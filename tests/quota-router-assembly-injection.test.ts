import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

// T6 装配注入集成测（SPEC #1 三处注入点 + #4 AC4 端到端 + T5 移交清单核销）。
//
// 吃 T2 桩（fake-provider-pool 包真实 ProviderPool 选路循环 / fake-quota-tool
// 真 HTTP 桩）驱动真实链路：真实 T3 数据面（quota-tool 适配器 + 独立快照库 +
// 加密凭证 + 刷新器）→ T6 装配（decideRouting 池路径/绑定路径/粘滞闸/fallback
// 源）→ T1 注入缝。断言只看可观察行为：选中谁、降到哪里、粘滞落到谁、
// 快照库是否开始产生数据、告警日志是否可见。

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-assembly-'));
let rigSeq = 0;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, Record<string, unknown>>>();
  return {
    ...real,
    DATA_DIR: root,
    STORE_DIR: path.join(root, 'db'),
    GROUPS_DIR: path.join(root, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { logger } = (await import('../src/logger.js')) as {
  logger: Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
};

/**
 * Windows 全量并行跑时的文件系统抖动缓解：上游 writeSecretFile 的原子
 * rename 在 AV/索引器短暂占用目标文件时可能 EPERM（Linux CI 无此问题，
 * 上游同款写路径亦有同样抖动）。凭证落盘属测试夹具固定步骤，重试即可。
 */
async function saveWithRetry(
  store: InstanceType<typeof QuotaCredentialStore>,
  providerId: string,
  record: { quotaToolProvider: string; credentials: unknown },
  attempts = 5,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      store.save(providerId, record);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        attempt >= attempts ||
        (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const { QuotaRouterConfigLoader } =
  await import('../src/quota-router/config.js');
const { QuotaCredentialStore } =
  await import('../src/quota-router/credentials.js');
const { QuotaSnapshotStore, isMissingSnapshot } =
  await import('../src/quota-router/snapshot-store.js');
const { QuotaSnapshotRefresher } =
  await import('../src/quota-router/refresher.js');
const { QuotaRouterAssembly } = await import('../src/quota-router/assembly.js');
const { createScriptedProviderPool } =
  await import('./quota-router-stubs/fake-provider-pool.js');
const runtimeConfig =
  (await import('../src/runtime-config.js')) as typeof import('../src/runtime-config.js');
const db = (await import('../src/db.js')) as typeof import('../src/db.js');
const { trySelectPoolProvider } = await import('../src/container-runner.js');

import {
  startFakeQuotaTool,
  type FakeQuotaTool,
  type QuotaQueryResult,
} from './quota-router-stubs/fake-quota-tool.js';
import type {
  QuotaRouterAssemblyOptions,
  RoutingCostSource,
  RoutingBalanceSource,
} from '../src/quota-router/assembly.js';

const openStores: Array<{ close(): void }> = [];
const openFixtures: FakeQuotaTool[] = [];

afterEach(async () => {
  for (const fixture of openFixtures.splice(0)) await fixture.stop();
  // fire-and-forget 懒刷新的落地窗口，避免跨用例串写
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* 幂等 */
    }
  }
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.debug).mockClear();
});

// ─── 桩件 ────────────────────────────────────────────────────

function afpResult(usedPct: number): QuotaQueryResult {
  const total = 500_000;
  const used = Math.round((total * usedPct) / 100);
  return {
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    summary: [{ label: '套餐', value: 'Agent Plan' }],
    windows: [
      {
        label: '5h Rolling',
        total,
        used,
        remaining: total - used,
        percentage: usedPct,
        resetAt: null,
        unit: 'AFP',
      },
    ],
    details: [],
  };
}

function fakeCostSource(
  prices: Record<string, { input: number; output: number }>,
): RoutingCostSource {
  return {
    getModelPrice: (modelId) => {
      const price = prices[modelId];
      if (!price) return { modelId, missing: true };
      return {
        modelId,
        displayName: modelId,
        inputCostPerMillion: price.input,
        outputCostPerMillion: price.output,
        cacheReadCostPerMillion: 0,
        cacheCreationCostPerMillion: 0,
      };
    },
    getProviderSpentCost: (providerId) => ({ providerId, missing: true }),
  };
}

function fakeBalanceSource(balanceUsd: number | null): RoutingBalanceSource {
  return {
    getUserBalance: (userId) =>
      balanceUsd === null
        ? { userId, missing: true }
        : {
            user_id: userId,
            balance_usd: balanceUsd,
            total_deposited_usd: 0,
            total_consumed_usd: 0,
            updated_at: '2026-09-11T00:00:00Z',
          },
  };
}

const MEMBERS = ['volcano-profile', 'zhipu-profile', 'opencode-profile'];
const MODELS: Record<string, string> = {
  'volcano-profile': 'volcano-model',
  'zhipu-profile': 'zhipu-model',
  'opencode-profile': 'opencode-model',
};
const PRICES: Record<string, { input: number; output: number }> = {
  'zhipu-model': { input: 3, output: 15 }, // 每百万 18 美元
  'opencode-model': { input: 1, output: 5 }, // 每百万 6 美元
};
const MAPPING: Record<string, { quotaToolProvider: string; signal: string }> = {
  'volcano-profile': { quotaToolProvider: 'volcano', signal: 'absolute' },
  'zhipu-profile': { quotaToolProvider: 'zhipu', signal: 'absolute' },
  'opencode-profile': { quotaToolProvider: 'opencode', signal: 'percentage' },
};

interface AssemblyRig {
  readonly assembly: InstanceType<typeof QuotaRouterAssembly>;
  readonly snapshots: InstanceType<typeof QuotaSnapshotStore>;
  readonly refresher: InstanceType<typeof QuotaSnapshotRefresher>;
  readonly stickyResets: Array<{ scope: unknown; providerId: string }>;
  readonly configPath: string;
}

/** 参数化装配：真实 T3 数据面 + fake 成本/余额源 + 捕获型粘滞重设 */
async function buildAssemblyRig(options?: {
  /** quota-tool 基础地址（缺省写一个不可达地址，模拟停服） */
  readonly baseUrl?: string;
  readonly snapshotTtlMs?: number;
  readonly balanceUsd?: number;
  readonly adminOverride?: boolean;
}): Promise<AssemblyRig> {
  const dir = path.join(root, `rig-${(rigSeq += 1)}`);
  const configPath = path.join(dir, 'config', 'quota-router.json');
  const credPath = path.join(dir, 'config', 'quota-router-credentials.json');
  const dbPath = path.join(dir, 'db', 'quota-router.db');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      quotaTool: {
        baseUrl: options?.baseUrl ?? 'http://127.0.0.1:1',
        timeoutMs: 800,
      },
      snapshotTtlMs: options?.snapshotTtlMs ?? 300_000,
      providers: MAPPING,
    }),
  );
  const config = new QuotaRouterConfigLoader(configPath);
  const credentials = new QuotaCredentialStore(credPath);
  for (const [profileId, mapped] of Object.entries(MAPPING)) {
    await saveWithRetry(credentials, profileId, {
      quotaToolProvider: mapped.quotaToolProvider,
      credentials: { token: `cred-for-${profileId}` },
    });
  }
  const snapshots = new QuotaSnapshotStore(dbPath);
  openStores.push(snapshots);
  const refresher = new QuotaSnapshotRefresher({
    config,
    credentials,
    snapshots,
  });
  const stickyResets: Array<{ scope: unknown; providerId: string }> = [];
  const assemblyOptions: QuotaRouterAssemblyOptions = {
    config,
    snapshots,
    refresher,
    costSource: fakeCostSource(PRICES),
    balanceSource: fakeBalanceSource(options?.balanceUsd ?? null),
    modelIdOf: (profileId) => MODELS[profileId] ?? null,
    listCandidates: () =>
      MEMBERS.map((id) => ({ profileId: id, weight: 1, enabled: true })),
    resetSticky: (scope, providerId) => {
      stickyResets.push({ scope, providerId });
    },
    strategyOf: () => 'round-robin',
    ...(options?.adminOverride ? { adminOverrideProbe: () => true } : {}),
  };
  return {
    assembly: new QuotaRouterAssembly(assemblyOptions),
    snapshots,
    refresher,
    stickyResets,
    configPath,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ─── 注入点① + #4 AC4：真实选路循环上的前置过滤与刷新器通电 ──

describe('注入点①：真实 ProviderPool + 装配端到端（AC1 / AC4）', () => {
  test('档位耗尽的供应商不再被选中；refresher 在选路路径真实被调用，快照库开始产生数据', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) }, // 耗尽
      zhipu: { kind: 'success', result: afpResult(10) }, // 充足
      opencode: { kind: 'success', result: afpResult(75) }, // 紧张（未耗尽）
    });
    openFixtures.push(fixture);
    const rig = await buildAssemblyRig({ baseUrl: fixture.baseUrl });

    // 装配策略挂上真实选路循环（T2 桩包真实 ProviderPool + T1 缝）
    const scripted = createScriptedProviderPool({
      members: MEMBERS.map((id) => ({ id })),
      strategy: 'round-robin',
      policy: rig.assembly.quotaPolicy,
    });

    // 冷启动第一轮：快照库尚无数据 → 全部 missing → 幸存集完整放行
    // （fail-open 不否决任何候选；幸存集按 T5「档位序+成本序」排序）
    expect(scripted.select()).toBe('opencode-profile');

    // AC4 兑现：选路路径上 refresher 真实查询了三家（真 HTTP 到 fake-quota-tool）
    await waitFor(() =>
      ['volcano', 'zhipu', 'opencode'].every((vendor) =>
        fixture.requests.some((request) => request.provider === vendor),
      ),
    );
    // AC4 兑现：快照库开始产生数据（独立 quota-router.db 落库）
    await waitFor(() =>
      MEMBERS.every((id) => {
        const snapshot = rig.snapshots.get(id);
        return !!snapshot && !isMissingSnapshot(snapshot);
      }),
    );
    expect(rig.snapshots.get('volcano-profile')?.tier).toBe('exhausted');
    expect(rig.snapshots.get('zhipu-profile')?.tier).toBe('plenty');

    // AC1 兑现：耗尽的 volcano 出局，幸存者交上游 round-robin 轮转
    const sequence = scripted.selectSequence(4);
    expect(sequence).not.toContain('volcano-profile');
    expect(new Set(sequence)).toEqual(
      new Set(['zhipu-profile', 'opencode-profile']),
    );
    for (const selection of scripted.selections.slice(1)) {
      expect(selection.decisionCandidateIds).not.toContain('volcano-profile');
    }
  });

  test('quota-tool 停服且无快照 → 全员放行，选路与原生逐一同（fail-open）', async () => {
    const fixture = await startFakeQuotaTool();
    const { baseUrl } = fixture;
    await fixture.stop(); // 从未产出数据就下线
    const rig = await buildAssemblyRig({ baseUrl });

    const scripted = createScriptedProviderPool({
      members: MEMBERS.map((id) => ({ id })),
      strategy: 'round-robin',
      policy: rig.assembly.quotaPolicy,
    });
    expect(scripted.selectSequence(3)).toEqual([
      'opencode-profile',
      'zhipu-profile',
      'volcano-profile',
    ]);
  });

  test('quota-tool 停服但有陈旧快照 → 陈旧照用，过滤仍成立且降级标注带数据时间（移交清单 #4）', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) },
      zhipu: { kind: 'success', result: afpResult(10) },
      opencode: { kind: 'success', result: afpResult(75) },
    });
    openFixtures.push(fixture);
    const rig = await buildAssemblyRig({
      baseUrl: fixture.baseUrl,
      snapshotTtlMs: 1,
    });
    for (const id of MEMBERS) {
      const snapshot = await rig.refresher.getSnapshot(id);
      expect(isMissingSnapshot(snapshot)).toBe(false);
    }
    await fixture.stop();
    openFixtures.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 10)); // TTL=1ms 过后即陈旧

    const scripted = createScriptedProviderPool({
      members: MEMBERS.map((id) => ({ id })),
      strategy: 'round-robin',
      policy: rig.assembly.quotaPolicy,
    });
    const sequence = scripted.selectSequence(2);
    expect(sequence).not.toContain('volcano-profile');

    // 降级标注透传到日志：snapshot-stale 带 ageMs 与数据时间
    const decisionLogs = vi
      .mocked(logger.info)
      .mock.calls.filter((call) => call[1] === 'quota-router 路由决策');
    expect(decisionLogs.length).toBeGreaterThan(0);
    const payload = decisionLogs.at(-1)![0] as {
      degradations: Array<{
        kind: string;
        ageMs?: number;
        dataTime: string | null;
      }>;
    };
    const stale = payload.degradations.find((d) => d.kind === 'snapshot-stale');
    expect(stale).toBeDefined();
    expect(typeof stale!.ageMs).toBe('number');
    expect(stale!.ageMs!).toBeGreaterThanOrEqual(0);
    expect(typeof stale!.dataTime).toBe('string');
  });
});

// ─── 注入点②：绑定否决钩子（降档/否决/admin 记账告警） ──────

describe('注入点②：绑定否决钩子 + admin 记账告警', () => {
  test('绑定耗尽且有降档目标 → 降档裁决并经注入回调重设粘滞点（移交清单 #2）', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) }, // 绑定方：耗尽
      zhipu: { kind: 'success', result: afpResult(10) }, // 降档目标：充足
      opencode: { kind: 'success', result: afpResult(75) },
    });
    openFixtures.push(fixture);
    const rig = await buildAssemblyRig({ baseUrl: fixture.baseUrl });
    for (const id of MEMBERS) await rig.refresher.getSnapshot(id);

    const verdict = rig.assembly.bindingGate(
      { groupFolder: 'grp', agentId: null },
      'volcano-profile',
    );
    expect(verdict).toMatchObject({
      action: 'downgrade',
      providerId: 'zhipu-profile',
      fromProviderId: 'volcano-profile',
      newStickyProviderId: 'zhipu-profile',
    });
    // T5 newStickyProviderId 消费：装配层经注入回调重设会话粘滞点
    expect(rig.stickyResets).toEqual([
      {
        scope: { groupFolder: 'grp', agentId: null },
        providerId: 'zhipu-profile',
      },
    ]);
  });

  test('绑定耗尽且降无可降 → 否决；admin 显式放行 → 放行 + 一行记账告警（providerId/档位/时间戳）', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) },
      zhipu: { kind: 'success', result: afpResult(100) }, // 全员耗尽
      opencode: { kind: 'success', result: afpResult(100) },
    });
    openFixtures.push(fixture);
    const strictRig = await buildAssemblyRig({ baseUrl: fixture.baseUrl });
    for (const id of MEMBERS) await strictRig.refresher.getSnapshot(id);
    expect(
      strictRig.assembly.bindingGate(
        { groupFolder: 'grp', agentId: null },
        'volcano-profile',
      ),
    ).toMatchObject({ action: 'veto', providerId: 'volcano-profile' });

    const adminRig = await buildAssemblyRig({
      baseUrl: fixture.baseUrl,
      adminOverride: true,
    });
    for (const id of MEMBERS) await adminRig.refresher.getSnapshot(id);
    expect(
      adminRig.assembly.bindingGate(
        { groupFolder: 'grp', agentId: null },
        'volcano-profile',
      ),
    ).toMatchObject({ action: 'allow', providerId: 'volcano-profile' });

    const warns = vi
      .mocked(logger.warn)
      .mock.calls.filter((call) => String(call[1]).includes('额度记账告警'));
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toMatchObject({
      providerId: 'volcano-profile',
      tier: '耗尽',
      adminOverride: true,
    });
    expect(typeof (warns[0]![0] as { at: string }).at).toBe('string');
    expect(Number.isNaN(Date.parse((warns[0]![0] as { at: string }).at))).toBe(
      false,
    );
  });

  test('绑定供应商无快照 → fail-open 放行（缺失不否决）', async () => {
    const fixture = await startFakeQuotaTool();
    const { baseUrl } = fixture;
    await fixture.stop();
    const rig = await buildAssemblyRig({ baseUrl });
    expect(
      rig.assembly.bindingGate(
        { groupFolder: 'grp', agentId: null },
        'volcano-profile',
      ),
    ).toMatchObject({ action: 'allow', providerId: 'volcano-profile' });
  });
});

// ─── A4：粘滞迁移闸（池路径 newStickyFromProviderId 消费） ───

describe('A4：粘滞迁移闸（轮边界语义）', () => {
  test('粘滞供应商档位非耗尽 → keep（轮内不迁移）', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) },
      zhipu: { kind: 'success', result: afpResult(10) },
      opencode: { kind: 'success', result: afpResult(75) },
    });
    openFixtures.push(fixture);
    const rig = await buildAssemblyRig({ baseUrl: fixture.baseUrl });
    for (const id of MEMBERS) await rig.refresher.getSnapshot(id);
    expect(
      rig.assembly.stickyGate(
        { groupFolder: 'grp', agentId: null },
        'zhipu-profile',
      ),
    ).toBe('keep');
  });

  test('粘滞供应商档位耗尽 → migrate（轮边界迁移，上游选路尾部重绑落地）', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) },
      zhipu: { kind: 'success', result: afpResult(10) },
      opencode: { kind: 'success', result: afpResult(75) },
    });
    openFixtures.push(fixture);
    const rig = await buildAssemblyRig({ baseUrl: fixture.baseUrl });
    for (const id of MEMBERS) await rig.refresher.getSnapshot(id);
    expect(
      rig.assembly.stickyGate(
        { groupFolder: 'grp', agentId: null },
        'volcano-profile',
      ),
    ).toBe('migrate');

    // wiring 消费协议：migrate → 跳过粘滞复用落池选路（注入点①过滤耗尽）→
    // 选路尾部既有重绑把新粘滞点落到幸存者（T5 newStickyFromProviderId 落地）
    const scripted = createScriptedProviderPool({
      members: MEMBERS.map((id) => ({ id })),
      strategy: 'round-robin',
      policy: rig.assembly.quotaPolicy,
    });
    const picked = scripted.select();
    expect(picked).not.toBe('volcano-profile');
  });
});

// ─── 注入点③：fallback 源（按余额与档位计算的降档序列） ─────

describe('注入点③：运行中 fallback 源（承接清单 #3：装配层重算余额规则）', () => {
  async function buildWarmRig(balanceUsd: number | null) {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) }, // 耗尽：不进序列
      zhipu: { kind: 'success', result: afpResult(10) }, // 充足、单价 18/M
      opencode: { kind: 'success', result: afpResult(75) }, // 紧张、单价 6/M
    });
    openFixtures.push(fixture);
    const rig = await buildAssemblyRig({
      baseUrl: fixture.baseUrl,
      balanceUsd,
    });
    for (const id of MEMBERS) await rig.refresher.getSnapshot(id);
    return rig;
  }

  test('余额缺失 → 与 T5 fallbackSequence 同序（档位序优先，充足在前）', async () => {
    const rig = await buildWarmRig(null);
    expect(rig.assembly.fallbackModel({})).toBe('zhipu-model');
  });

  test('余额紧张（10 美元）→ 可负担的便宜档位前移（6/M ≤ 10 < 18/M）', async () => {
    const rig = await buildWarmRig(10);
    expect(rig.assembly.fallbackModel({ balanceUserId: 'user-a' })).toBe(
      'opencode-model',
    );
  });

  test('余额充裕（100 美元）→ 无分段重排，档位序胜出', async () => {
    const rig = await buildWarmRig(100);
    expect(rig.assembly.fallbackModel({ balanceUserId: 'user-a' })).toBe(
      'zhipu-model',
    );
  });

  test('剔除当前主选模型自身：excludeModelId 命中队头时取次选', async () => {
    const rig = await buildWarmRig(null);
    expect(rig.assembly.fallbackModel({ excludeModelId: 'zhipu-model' })).toBe(
      'opencode-model',
    );
  });

  test('单价缺失条目按未知段居中（fail-open 只排序不剔除，不造余额闸门）', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) },
      zhipu: { kind: 'success', result: afpResult(10) },
      opencode: { kind: 'success', result: afpResult(75) },
    });
    openFixtures.push(fixture);
    const dir = path.join(root, `rig-${(rigSeq += 1)}`);
    const configPath = path.join(dir, 'config', 'quota-router.json');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        quotaTool: { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
        snapshotTtlMs: 300_000,
        providers: MAPPING,
      }),
    );
    const config = new QuotaRouterConfigLoader(configPath);
    const credentials = new QuotaCredentialStore(
      path.join(dir, 'config', 'quota-router-credentials.json'),
    );
    for (const [profileId, mapped] of Object.entries(MAPPING)) {
      await saveWithRetry(credentials, profileId, {
        quotaToolProvider: mapped.quotaToolProvider,
        credentials: { token: 'cred' },
      });
    }
    const snapshots = new QuotaSnapshotStore(
      path.join(dir, 'db', 'quota-router.db'),
    );
    openStores.push(snapshots);
    const refresher = new QuotaSnapshotRefresher({
      config,
      credentials,
      snapshots,
    });
    for (const id of MEMBERS) await refresher.getSnapshot(id);
    // zhipu（充足）单价缺失、opencode（紧张）单价 6/M ≤ 余额 10：
    // 已知可负担 > 未知单价（未知居中），余额规则下便宜且已知的先出头
    const assembly = new QuotaRouterAssembly({
      config,
      snapshots,
      refresher,
      costSource: fakeCostSource({ 'opencode-model': { input: 1, output: 5 } }),
      balanceSource: fakeBalanceSource(10),
      modelIdOf: (profileId) => MODELS[profileId] ?? null,
      listCandidates: () =>
        MEMBERS.map((id) => ({ profileId: id, weight: 1, enabled: true })),
      resetSticky: () => {},
      strategyOf: () => 'round-robin',
    });
    expect(assembly.fallbackModel({ balanceUserId: 'user-a' })).toBe(
      'opencode-model',
    );
  });
});

// ─── 缺省不激活：未配置 quota-router 时全链 no-op 等价 ────────

describe('缺省不激活（未配置映射 = 上游行为不变）', () => {
  test('无配置文件：策略原样放行（同引用）、gate 返回 null、fallback 返回 null', async () => {
    const dir = path.join(root, `rig-${(rigSeq += 1)}`);
    const configPath = path.join(dir, 'config', 'quota-router.json');
    const dbPath = path.join(dir, 'db', 'quota-router.db');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    const config = new QuotaRouterConfigLoader(configPath); // 文件不存在 → 缺省
    const snapshots = new QuotaSnapshotStore(dbPath);
    openStores.push(snapshots);
    const assembly = new QuotaRouterAssembly({
      config,
      snapshots,
      refresher: new QuotaSnapshotRefresher({
        config,
        credentials: new QuotaCredentialStore(
          path.join(dir, 'config', 'quota-router-credentials.json'),
        ),
        snapshots,
      }),
      costSource: fakeCostSource(PRICES),
      balanceSource: fakeBalanceSource(null),
      modelIdOf: (profileId) => MODELS[profileId] ?? null,
      listCandidates: () =>
        MEMBERS.map((id) => ({ profileId: id, weight: 1, enabled: true })),
      resetSticky: () => {},
      strategyOf: () => 'round-robin',
    });

    expect(assembly.isConfigured()).toBe(false);
    const context = {
      strategy: 'round-robin' as const,
      candidates: MEMBERS.map((id) => ({
        profileId: id,
        weight: 1,
        enabled: true,
      })),
    };
    expect(assembly.quotaPolicy(context)).toBe(context); // 原样放行（同引用）
    expect(
      assembly.bindingGate(
        { groupFolder: 'g', agentId: null },
        'volcano-profile',
      ),
    ).toBeNull();
    expect(
      assembly.stickyGate({ groupFolder: 'g', agentId: null }, 'zhipu-profile'),
    ).toBeNull();
    expect(assembly.fallbackModel({})).toBeNull();
  });
});

// ─── 全链路：真实 trySelectPoolProvider（生产 facade + 真实 db/状态） ──

describe('全链路（真实 trySelectPoolProvider + 生产 facade + sessions 表）', () => {
  const rootDbPath = path.join(root, 'db', 'quota-router.db');
  const rootConfigPath = path.join(root, 'config', 'quota-router.json');
  const rootCredPath = path.join(
    root,
    'config',
    'quota-router-credentials.json',
  );

  beforeAll(() => {
    db.initDatabase();
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  });

  /** 在生产 facade 的 DATA_DIR 约定路径上写映射/凭证并预刷快照（真 HTTP） */
  async function writeMappingAndPrewarm(
    fixture: FakeQuotaTool,
    mapping: Record<string, string>,
    tiers: Record<string, number>,
  ): Promise<void> {
    fs.writeFileSync(
      rootConfigPath,
      JSON.stringify({
        version: 1,
        quotaTool: { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
        snapshotTtlMs: 300_000,
        providers: Object.fromEntries(
          Object.entries(mapping).map(([profileId, vendor]) => [
            profileId,
            { quotaToolProvider: vendor, signal: 'absolute' },
          ]),
        ),
      }),
    );
    for (const vendor of new Set(Object.values(mapping))) {
      fixture.setScript(vendor, {
        kind: 'success',
        result: afpResult(tiers[vendor] ?? 100),
      });
    }
    const credentials = new QuotaCredentialStore(rootCredPath);
    for (const [profileId, vendor] of Object.entries(mapping)) {
      await saveWithRetry(credentials, profileId, {
        quotaToolProvider: vendor,
        credentials: { token: `cred-${vendor}` },
      });
    }
    const prewarm = new QuotaSnapshotRefresher({
      config: new QuotaRouterConfigLoader(rootConfigPath),
      credentials,
      snapshots: new QuotaSnapshotStore(rootDbPath),
    });
    for (const profileId of Object.keys(mapping)) {
      const snapshot = await prewarm.refreshNow(profileId);
      expect(isMissingSnapshot(snapshot)).toBe(false);
    }
    // 预刷的写连接落库窗口
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  test('quota-router 未配置 → 绑定原样放行（上游行为不变）', () => {
    expect(fs.existsSync(rootConfigPath)).toBe(false);
    const bound = runtimeConfig.createProvider({
      name: 'plain-bound',
      type: 'third_party',
      anthropicBaseUrl: 'https://plain.test',
      anthropicAuthToken: 'token-plain',
      anthropicModel: 'model-plain',
      enabled: true,
    });
    const result = trySelectPoolProvider('grp-plain', null, bound.id);
    expect(result?.profileId).toBe(bound.id);
    expect(db.getSessionProviderId('grp-plain')).toBe(bound.id);
  });

  test('绑定耗尽 → 自动降档 → 重设粘滞点（AC2 全链路）', async () => {
    const fixture = await startFakeQuotaTool();
    openFixtures.push(fixture);
    const bound = runtimeConfig.createProvider({
      name: 'chain-bound',
      type: 'third_party',
      anthropicBaseUrl: 'https://bound.test',
      anthropicAuthToken: 'token-bound',
      anthropicModel: 'model-bound',
      enabled: true,
    });
    const cheap = runtimeConfig.createProvider({
      name: 'chain-cheap',
      type: 'third_party',
      anthropicBaseUrl: 'https://cheap.test',
      anthropicAuthToken: 'token-cheap',
      anthropicModel: 'model-cheap',
      enabled: true,
    });
    const mid = runtimeConfig.createProvider({
      name: 'chain-mid',
      type: 'third_party',
      anthropicBaseUrl: 'https://mid.test',
      anthropicAuthToken: 'token-mid',
      anthropicModel: 'model-mid',
      enabled: true,
    });
    runtimeConfig.saveBalancingConfig({ strategy: 'round-robin' });
    // plain-bound 未映射（快照 missing → 幸存候选），但档位序保证充足者胜出
    await writeMappingAndPrewarm(
      fixture,
      {
        [bound.id]: 'volcano',
        [cheap.id]: 'zhipu',
        [mid.id]: 'opencode',
      },
      { volcano: 100, zhipu: 10, opencode: 75 },
    );

    db.setSessionProviderId('grp-chain', null, bound.id);
    const result = trySelectPoolProvider('grp-chain', null, bound.id);
    expect(result?.profileId).toBe(cheap.id);
    expect(result?.resetSession).toBe(true);
    // A4：降档目标落地为该会话新粘滞点（newStickyProviderId 消费）
    expect(db.getSessionProviderId('grp-chain')).toBe(cheap.id);
  });

  test('绑定耗尽且降无可降 → 拒绝并明示额度耗尽（quota_veto）', async () => {
    const fixture = await startFakeQuotaTool();
    openFixtures.push(fixture);
    // 全部已启用供应商都映射到已耗尽脚本：降无可降
    const all = runtimeConfig.getProviders();
    const mapping: Record<string, string> = {};
    all.forEach((provider, index) => {
      mapping[provider.id] = `vendor-${index}`;
    });
    await writeMappingAndPrewarm(
      fixture,
      mapping,
      Object.fromEntries(Object.values(mapping).map((vendor) => [vendor, 100])),
    );

    const bound = all.find((provider) => provider.name === 'chain-bound')!;
    db.setSessionProviderId('grp-veto', null, bound.id);
    expect(() =>
      trySelectPoolProvider('grp-veto', null, bound.id),
    ).toThrowError(/quota_veto/);
    // 否决不动既有粘滞（拒绝语义：不迁移、不改绑）
    expect(db.getSessionProviderId('grp-veto')).toBe(bound.id);
  });
});
