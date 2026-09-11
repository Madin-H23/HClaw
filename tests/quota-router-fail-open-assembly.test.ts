import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// fail-open 装配实证（票面 AC：服务不可达时回退原生选路，有测试）。
//
// 用 T2 fake-provider-pool 桩包住**真实** ProviderPool 选路循环，把 T3 数据面
// （真实 quota-tool 适配器 + 真实独立快照库 + 真实加密凭证 + 刷新器）装配成
// 额度过滤策略挂上 T1 注入缝，断言：
// - quota-tool 不可达且无快照 → 全部候选 missing → 选路与无策略时逐一同
//   （=回退原生行为，fail-open 的本义）
// - 快照在库但服务挂了 → 陈旧快照照用（带数据时间），耗尽过滤仍成立
// - 快照新鲜时，只有「耗尽」出局（SPEC 基线：粘滞/否决只针对耗尽）

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-failopen-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: tmp };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { QuotaRouterConfigLoader } =
  await import('../src/quota-router/config.js');
const { QuotaCredentialStore } =
  await import('../src/quota-router/credentials.js');
const { QuotaSnapshotStore, isMissingSnapshot } =
  await import('../src/quota-router/snapshot-store.js');
const { QuotaSnapshotRefresher } =
  await import('../src/quota-router/refresher.js');
const { TIER_RANK, createScriptedProviderPool } =
  await import('./quota-router-stubs/fake-provider-pool.js');

import {
  startFakeQuotaTool,
  type FakeQuotaTool,
  type QuotaQueryResult,
} from './quota-router-stubs/fake-quota-tool.js';

const CONFIG_FILE = path.join(tmp, 'config', 'quota-router.json');
const CRED_FILE = path.join(tmp, 'config', 'quota-router-credentials.json');
const DB_PATH = path.join(tmp, 'db', 'quota-router.db');

const fixtures: FakeQuotaTool[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const fixture of fixtures) await fixture.stop();
  fixtures.length = 0;
  // 策略里的 fire-and-forget 懒刷新落地窗口，避免跨用例串写
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* 幂等 */
    }
  }
  fs.rmSync(DB_PATH, { force: true });
  for (const suffix of ['-wal', '-shm'])
    fs.rmSync(DB_PATH + suffix, { force: true });
  fs.rmSync(CRED_FILE, { force: true });
});

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

const MEMBERS = [
  { id: 'volcano-profile' },
  { id: 'zhipu-profile' },
  { id: 'opencode-profile' },
];

const MAPPING = {
  'volcano-profile': { quotaToolProvider: 'volcano', signal: 'absolute' },
  'zhipu-profile': { quotaToolProvider: 'zhipu', signal: 'absolute' },
  'opencode-profile': { quotaToolProvider: 'opencode', signal: 'percentage' },
};

/**
 * T3 数据面 → T1 缝的装配（最小 wiring 形态；决策层完整形态归后续票）。
 * 策略是同步缝：直读快照库（零网络）；陈旧者触发懒刷新但不等待——访问点
 * 即降级点，选路永不阻塞（fire-and-forget，失败已被刷新器内部吸收）。
 * 档位过滤基线：仅「耗尽」出局，missing 放行。
 */
function assembleQuotaFilterPolicy(rig: {
  refresher: InstanceType<typeof QuotaSnapshotRefresher>;
  snapshots: InstanceType<typeof QuotaSnapshotStore>;
  config: InstanceType<typeof QuotaRouterConfigLoader>;
  nowMs: () => number;
}) {
  const { refresher, snapshots, config, nowMs } = rig;
  return createScriptedProviderPool({
    members: MEMBERS.map((m) => ({ id: m.id })),
    strategy: 'round-robin',
    policy: (context) => ({
      candidates: context.candidates.filter((member) => {
        const snapshot = snapshots.get(member.profileId);
        if (!snapshot) return true; // missing → fail-open 放行
        const ttl = config.get().snapshotTtlMs;
        if (nowMs() - Date.parse(snapshot.fetchedAt) >= ttl) {
          // 陈旧：照用（本轮决策不阻塞），同时触发懒刷新供下一轮用
          void refresher.getSnapshot(member.profileId).catch(() => {});
        }
        return TIER_RANK[snapshot.tier] >= TIER_RANK.critical;
      }),
    }),
  });
}

function buildRig(baseUrl: string) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      {
        version: 1,
        quotaTool: { baseUrl, timeoutMs: 2000 },
        snapshotTtlMs: 300_000,
        providers: MAPPING,
      },
      null,
      2,
    ),
  );
  const config = new QuotaRouterConfigLoader(CONFIG_FILE);
  const credentials = new QuotaCredentialStore(CRED_FILE);
  for (const id of Object.keys(MAPPING)) {
    credentials.save(id, {
      quotaToolProvider: MAPPING[id as keyof typeof MAPPING].quotaToolProvider,
      credentials: { token: 'cred-for-' + id },
    });
  }
  const snapshots = new QuotaSnapshotStore(DB_PATH);
  openStores.push(snapshots);
  const refresher = new QuotaSnapshotRefresher({
    config,
    credentials,
    snapshots,
  });
  return { refresher, snapshots, config, credentials, nowMs: () => Date.now() };
}

describe('fail-open assembly over the real upstream selection loop', () => {
  test('quota-tool unreachable and no snapshots → every candidate stays (native selection)', async () => {
    const fixture = await startFakeQuotaTool();
    const { baseUrl } = fixture;
    await fixture.stop();
    fixtures.length = 0;
    const rig = buildRig(baseUrl);

    const scripted = assembleQuotaFilterPolicy(rig);
    // 无快照：三次选路 = 纯 round-robin 全员轮转（与 no-op 策略逐一同）
    expect(scripted.selectSequence(3)).toEqual([
      'volcano-profile',
      'zhipu-profile',
      'opencode-profile',
    ]);
    const selection = scripted.selections[0];
    expect(selection.contextCandidateIds).toEqual([
      'volcano-profile',
      'zhipu-profile',
      'opencode-profile',
    ]);
    expect(selection.decisionCandidateIds).toEqual(
      selection.contextCandidateIds,
    );
  });

  test('fresh snapshots: only exhausted is vetoed; survivors go to native round-robin', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) }, // 耗尽
      zhipu: { kind: 'success', result: afpResult(10) }, // 充足
      opencode: {
        kind: 'success',
        result: {
          updatedAt: new Date().toISOString(),
          summary: [],
          windows: [
            {
              label: '5h Rolling',
              total: 100,
              used: 75,
              remaining: 25,
              percentage: 75,
              resetAt: null,
              unit: '%',
            },
          ],
          details: [],
        },
      }, // 紧张（未耗尽，保留）
    });
    fixtures.push(fixture);
    const rig = buildRig(fixture.baseUrl);

    const scripted = assembleQuotaFilterPolicy(rig);
    // 预热：把三家真实额度刷进快照库（async 装配在选路前完成）
    for (const id of Object.keys(MAPPING)) {
      const snap = await rig.refresher.getSnapshot(id);
      expect(isMissingSnapshot(snap)).toBe(false);
    }
    // 耗尽的 volcano 出局；zhipu/opencode 幸存并按 round-robin 轮转
    expect(scripted.selectSequence(4)).toEqual([
      'zhipu-profile',
      'opencode-profile',
      'zhipu-profile',
      'opencode-profile',
    ]);
    expect(scripted.selections[0].decisionCandidateIds).toEqual([
      'zhipu-profile',
      'opencode-profile',
    ]);
  });

  test('service dies after snapshots exist: stale data still governs, marked by data time', async () => {
    const fixture = await startFakeQuotaTool({
      volcano: { kind: 'success', result: afpResult(100) },
      zhipu: { kind: 'success', result: afpResult(10) },
      opencode: { kind: 'success', result: afpResult(30) },
    });
    fixtures.push(fixture);
    const rig = buildRig(fixture.baseUrl);
    for (const id of Object.keys(MAPPING)) {
      await rig.refresher.getSnapshot(id);
    }

    // 服务下线后：陈旧快照照用（过滤仍然成立），不再有新数据但选路不停摆
    await fixture.stop();
    fixtures.length = 0;
    const scripted = assembleQuotaFilterPolicy(rig);
    expect(scripted.selectSequence(2)).toEqual([
      'zhipu-profile',
      'opencode-profile',
    ]);
    const stale = rig.snapshots.get('volcano-profile');
    expect(stale?.tier).toBe('exhausted'); // 数据时间即陈旧标注（ADR-0004）
    expect(Date.parse(stale!.fetchedAt)).toBeLessThan(Date.now());
  });
});
