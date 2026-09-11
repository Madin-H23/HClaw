/**
 * T7-B：会话内提示卡片（turn-cards）—— 格式化纯函数 + 发射链路 + 装配层触达
 *
 * 链路选型②（票 #8）：经上游系统消息落库路径（storeMessageDirect +
 * broadcastNewMessage）触达；本文件 mock 上游 db/web 边界，断言：
 * - 三类决策（降档/否决/admin 放行）各发一张卡片，徽标与 T5 reason 透传；
 * - veto 路径必有卡片（用户需要知道为什么没跑）；
 * - 无 web 会话（纯 IM 群）跳过；落库失败吞掉（fail-open，绝不影响裁决）；
 * - agent 会话落到虚拟 jid（web:xxx#agent:yyy）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  ensureChatExists: vi.fn(),
  getJidsByFolder: vi.fn((): string[] => []),
  storeMessageDirect: vi.fn(() => 'msg-1'),
}));
const webMocks = vi.hoisted(() => ({
  broadcastNewMessage: vi.fn(),
}));

vi.mock('../src/db.js', () => dbMocks);
vi.mock('../src/web.js', () => webMocks);
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { formatQuotaCardText, emitQuotaTurnCard } =
  await import('../src/quota-router/turn-cards.js');
const { QuotaRouterConfigLoader } =
  await import('../src/quota-router/config.js');
const { QuotaCredentialStore } =
  await import('../src/quota-router/credentials.js');
const { QuotaSnapshotStore } =
  await import('../src/quota-router/snapshot-store.js');
const { QuotaSnapshotRefresher } =
  await import('../src/quota-router/refresher.js');
const { QuotaRouterAssembly } = await import('../src/quota-router/assembly.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cards-'));
const DB_PATH = path.join(tmp, 'db', 'quota-router.db');
const CONFIG_FILE = path.join(tmp, 'config', 'quota-router.json');

fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
fs.writeFileSync(
  CONFIG_FILE,
  JSON.stringify({
    quotaTool: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 },
    snapshotTtlMs: 300_000,
    providers: {
      'volcano-afp': { quotaToolProvider: 'volcano' },
      'deepseek-chat': { quotaToolProvider: 'deepseek' },
    },
  }),
);

function exhaustedSnapshot(providerId: string, fetchedAgoMs = 0) {
  const now = Date.now();
  return {
    providerId,
    tier: 'exhausted' as const,
    signalKind: 'percentage' as const,
    score: 0,
    fetchedAt: new Date(now - fetchedAgoMs).toISOString(),
    storedAt: new Date(now).toISOString(),
    windows: [
      {
        label: '5h',
        total: 100,
        used: 100,
        remaining: 0,
        percentage: 100,
        resetAt: null,
        unit: '%',
      },
    ],
    summary: [],
  };
}

function healthySnapshot(providerId: string) {
  const now = Date.now();
  return {
    providerId,
    tier: 'plenty' as const,
    signalKind: 'currency' as const,
    score: 100,
    fetchedAt: new Date(now).toISOString(),
    storedAt: new Date(now).toISOString(),
    windows: [],
    summary: [{ label: '总余额', value: 100 }],
  };
}

const openStores: Array<{ close(): void }> = [];

function buildAssembly(
  adminOverride: boolean,
  candidateIds: string[] = ['volcano-afp', 'deepseek-chat'],
) {
  const config = new QuotaRouterConfigLoader(CONFIG_FILE);
  const credentials = new QuotaCredentialStore(
    path.join(tmp, 'config', 'quota-router-credentials.json'),
  );
  const snapshots = new QuotaSnapshotStore(DB_PATH);
  openStores.push(snapshots);
  const assembly = new QuotaRouterAssembly({
    config,
    snapshots,
    refresher: new QuotaSnapshotRefresher({ config, credentials, snapshots }),
    costSource: {
      getModelPrice: (modelId) => ({ modelId, missing: true }),
      getProviderSpentCost: (providerId) => ({ providerId, missing: true }),
    },
    balanceSource: { getUserBalance: (userId) => ({ userId, missing: true }) },
    modelIdOf: () => null,
    listCandidates: () =>
      candidateIds.map((profileId) => ({
        profileId,
        weight: 1,
        enabled: true,
      })),
    resetSticky: vi.fn(),
    strategyOf: () => 'round-robin',
    adminOverrideProbe: () => adminOverride,
    nowMs: () => Date.now(),
  });
  return { assembly, snapshots };
}

afterEach(() => {
  vi.clearAllMocks();
  dbMocks.getJidsByFolder.mockReturnValue([]);
  // 先关库再清 WAL：Windows 上打开的 SQLite 文件 rm 会 EPERM（T6 教训）
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* 幂等 */
    }
  }
  for (const suffix of ['-wal', '-shm'])
    try {
      fs.rmSync(DB_PATH + suffix, { force: true });
    } catch {
      /* Windows 文件抖动：下一用例重建 */
    }
});

describe('formatQuotaCardText', () => {
  test('徽标行 + reason 透传 + 可选数据时间行', () => {
    const text = formatQuotaCardText({
      kind: 'veto',
      reason: '额度否决：绑定供应商 X 额度档位「耗尽」',
      dataTime: '2026-09-11T04:00:00.000Z',
    });
    expect(text).toContain('【额度否决】');
    expect(text).toContain('额度否决：绑定供应商 X 额度档位「耗尽」');
    expect(text).toContain('额度数据时间：');

    const withoutTime = formatQuotaCardText({
      kind: 'downgrade',
      reason: '额度降档：A → B',
    });
    expect(withoutTime).toContain('【额度降档】');
    expect(withoutTime).not.toContain('额度数据时间');
  });
});

describe('emitQuotaTurnCard（发射链路）', () => {
  test('落库 + 广播：web 会话 jid、系统消息形态、is_from_me', async () => {
    dbMocks.getJidsByFolder.mockReturnValue(['web:abc123']);
    await emitQuotaTurnCard({
      scope: { groupFolder: 'abc123', agentId: null },
      kind: 'veto',
      reason: '额度否决：绑定供应商 X 额度档位「耗尽」',
    });
    expect(dbMocks.ensureChatExists).toHaveBeenCalledWith('web:abc123');
    const [msgId, jid, sender, senderName, content, , isFromMe] =
      dbMocks.storeMessageDirect.mock.calls[0];
    expect(msgId).toBeTruthy();
    expect(jid).toBe('web:abc123');
    expect(sender).toBe('__system__');
    expect(senderName).toBeTruthy();
    expect(content).toContain('【额度否决】');
    expect(isFromMe).toBe(true);
    expect(webMocks.broadcastNewMessage).toHaveBeenCalledTimes(1);
  });

  test('agent 会话落到虚拟 jid（web:xxx#agent:yyy）', async () => {
    dbMocks.getJidsByFolder.mockReturnValue(['web:abc123']);
    await emitQuotaTurnCard({
      scope: { groupFolder: 'abc123', agentId: 'agent-9' },
      kind: 'downgrade',
      reason: '额度降档：A → B',
    });
    expect(dbMocks.ensureChatExists).toHaveBeenCalledWith(
      'web:abc123#agent:agent-9',
    );
    expect(webMocks.broadcastNewMessage).toHaveBeenCalledWith(
      'web:abc123#agent:agent-9',
      expect.objectContaining({ id: 'msg-1' }),
      'agent-9',
    );
  });

  test('纯 IM 群（无 web jid）跳过，零副作用', async () => {
    dbMocks.getJidsByFolder.mockReturnValue(['8613xxx@s.whatsapp.net']);
    await emitQuotaTurnCard({
      scope: { groupFolder: 'wa-folder', agentId: null },
      kind: 'veto',
      reason: 'r',
    });
    expect(dbMocks.storeMessageDirect).not.toHaveBeenCalled();
    expect(webMocks.broadcastNewMessage).not.toHaveBeenCalled();
  });

  test('落库异常被吞掉（fail-open，绝不 reject）', async () => {
    dbMocks.getJidsByFolder.mockReturnValue(['web:abc123']);
    dbMocks.storeMessageDirect.mockImplementation(() => {
      throw new Error('db locked');
    });
    await expect(
      emitQuotaTurnCard({
        scope: { groupFolder: 'abc123', agentId: null },
        kind: 'veto',
        reason: 'r',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('bindingGate → 卡片触达（装配层决策产出后）', () => {
  test('veto：降无可降（唯一候选耗尽）→ 否决裁决 + 【额度否决】卡片', async () => {
    const { assembly, snapshots } = buildAssembly(false, ['volcano-afp']);
    snapshots.upsert(exhaustedSnapshot('volcano-afp'));
    dbMocks.getJidsByFolder.mockReturnValue(['web:abc123']);

    const verdict = assembly.bindingGate(
      { groupFolder: 'abc123', agentId: null },
      'volcano-afp',
    );
    expect(verdict?.action).toBe('veto');
    // fire-and-forget 卡片落地窗口
    await new Promise((resolve) => setTimeout(resolve, 30));
    const content = String(dbMocks.storeMessageDirect.mock.calls[0]?.[4] ?? '');
    expect(content).toContain('【额度否决】');
    expect(content).toContain('volcano-afp');
  });

  test('downgrade：存在健康候选 → 降档裁决 + 【额度降档】卡片', async () => {
    const { assembly, snapshots } = buildAssembly(false);
    snapshots.upsert(exhaustedSnapshot('volcano-afp'));
    snapshots.upsert(healthySnapshot('deepseek-chat'));
    dbMocks.getJidsByFolder.mockReturnValue(['web:abc123']);

    const verdict = assembly.bindingGate(
      { groupFolder: 'abc123', agentId: null },
      'volcano-afp',
    );
    expect(verdict?.action).toBe('downgrade');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const content = String(dbMocks.storeMessageDirect.mock.calls[0]?.[4] ?? '');
    expect(content).toContain('【额度降档】');
  });

  test('adminOverride 放行：否决解除（无降档目标）→ 【额度放行】卡片', async () => {
    const { assembly, snapshots } = buildAssembly(true, ['volcano-afp']);
    snapshots.upsert(exhaustedSnapshot('volcano-afp'));
    dbMocks.getJidsByFolder.mockReturnValue(['web:abc123']);

    const verdict = assembly.bindingGate(
      { groupFolder: 'abc123', agentId: null },
      'volcano-afp',
    );
    expect(verdict?.action).toBe('allow');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const content = String(dbMocks.storeMessageDirect.mock.calls[0]?.[4] ?? '');
    expect(content).toContain('【额度放行】');
  });

  test('普通绑定放行（额度充足）不发卡', async () => {
    const { assembly, snapshots } = buildAssembly(false);
    snapshots.upsert(healthySnapshot('volcano-afp'));
    dbMocks.getJidsByFolder.mockReturnValue(['web:abc123']);

    const verdict = assembly.bindingGate(
      { groupFolder: 'abc123', agentId: null },
      'volcano-afp',
    );
    expect(verdict?.action).toBe('allow');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dbMocks.storeMessageDirect).not.toHaveBeenCalled();
  });
});
