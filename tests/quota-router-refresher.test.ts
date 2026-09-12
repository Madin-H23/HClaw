import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// 快照刷新器：TTL 懒刷新 + single-flight（吃 T2 fake-quota-tool 桩驱动真实
// HTTP 适配器；凭证走真实加密存储；快照走真实独立 SQLite）。验证 fail-open
// 各分支（ADR-0004）：新鲜直读、陈旧懒刷新、刷新失败陈旧照用、无快照
// missing、未配置映射/凭证 missing、配置热生效。

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-refresh-'));

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
const { QuotaSnapshotStore } =
  await import('../src/quota-router/snapshot-store.js');
const { QuotaSnapshotRefresher } =
  await import('../src/quota-router/refresher.js');
const { isMissingSnapshot } =
  await import('../src/quota-router/snapshot-store.js');

import {
  credentialRejected,
  startFakeQuotaTool,
  type FakeQuotaTool,
  type QuotaQueryResult,
} from './quota-router-stubs/fake-quota-tool.js';
import { withFsRetry } from './helpers/win-fs-retry.js';

const CONFIG_FILE = path.join(tmp, 'config', 'quota-router.json');
const CRED_FILE = path.join(tmp, 'config', 'quota-router-credentials.json');
const DB_PATH = path.join(tmp, 'db', 'quota-router.db');

const fixtures: FakeQuotaTool[] = [];
const openStores: Array<{ close(): void }> = [];

// 可注入时钟：默认真实，个别用例拨快
let nowMsValue = Date.now();
const clock = { nowMs: () => nowMsValue };

afterEach(async () => {
  for (const fixture of fixtures) await fixture.stop();
  fixtures.length = 0;
  // 先关 SQLite 句柄再删文件（Windows 上打开中的 db 无法删除）
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* 幂等 */
    }
  }
  fs.rmSync(CONFIG_FILE, { force: true });
  fs.rmSync(CRED_FILE, { force: true });
  fs.rmSync(DB_PATH, { force: true });
  for (const suffix of ['-wal', '-shm'])
    fs.rmSync(DB_PATH + suffix, { force: true });
  nowMsValue = Date.now();
});

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function baseConfig(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    quotaTool: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 },
    snapshotTtlMs: 300_000,
    tierThresholds: {
      absolute: { tight: 25, critical: 10, exhausted: 0 },
      percentage: { tight: 25, critical: 10, exhausted: 0 },
      currency: { tight: 20, critical: 5, exhausted: 0 },
    },
    providers: {
      'volcano-profile': { quotaToolProvider: 'volcano', signal: 'absolute' },
      'opencode-profile': {
        quotaToolProvider: 'opencode',
        signal: 'percentage',
      },
      'deepseek-profile': { quotaToolProvider: 'deepseek', signal: 'currency' },
    },
    ...overrides,
  };
}

function afpResult(
  usedPct: number,
  updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
): QuotaQueryResult {
  const total = 500_000;
  const used = Math.round((total * usedPct) / 100);
  return {
    updatedAt,
    summary: [{ label: '套餐', value: 'Agent Plan' }],
    windows: [
      {
        label: '5h Rolling',
        total,
        used,
        remaining: total - used,
        percentage: usedPct,
        resetAt: '2026-09-11T17:00:00Z',
        unit: 'AFP',
      },
    ],
    details: [],
  };
}

interface Rig {
  refresher: InstanceType<typeof QuotaSnapshotRefresher>;
  credentials: InstanceType<typeof QuotaCredentialStore>;
  snapshots: InstanceType<typeof QuotaSnapshotStore>;
  config: InstanceType<typeof QuotaRouterConfigLoader>;
}

async function buildRig(options?: {
  enrollCredentials?: boolean;
  /** 故障注入：包住真实快照库（P1 存储层异常吸收测试用），inner 仍登记关闭 */
  wrapSnapshots?: (
    inner: InstanceType<typeof QuotaSnapshotStore>,
  ) => InstanceType<typeof QuotaSnapshotStore>;
}): Promise<Rig> {
  const loader = new QuotaRouterConfigLoader(CONFIG_FILE);
  const credentials = new QuotaCredentialStore(CRED_FILE);
  if (options?.enrollCredentials !== false) {
    // 缺省为三家映射供应商登记凭证（具体凭证值与本测试无关）
    for (const [profileId, mapping] of Object.entries({
      'volcano-profile': 'volcano',
      'opencode-profile': 'opencode',
      'deepseek-profile': 'deepseek',
    })) {
      await withFsRetry(() =>
        credentials.save(profileId, {
          quotaToolProvider: mapping,
          credentials: { token: `cred-${profileId}` },
        }),
      );
    }
  }
  const snapshots = new QuotaSnapshotStore(DB_PATH);
  openStores.push(snapshots);
  const refresher = new QuotaSnapshotRefresher({
    config: loader,
    credentials,
    snapshots: options?.wrapSnapshots
      ? options.wrapSnapshots(snapshots)
      : snapshots,
    nowMs: clock.nowMs,
  });
  return {
    refresher,
    credentials,
    snapshots: options?.wrapSnapshots
      ? options.wrapSnapshots(snapshots)
      : snapshots,
    config: loader,
  };
}

async function start(
  scripts?: Parameters<typeof startFakeQuotaTool>[0],
): Promise<FakeQuotaTool> {
  const fixture = await startFakeQuotaTool(scripts);
  fixtures.push(fixture);
  return fixture;
}

function writeConfigWithBaseUrl(
  baseUrl: string,
  extra?: Record<string, unknown>,
): void {
  writeConfig(
    baseConfig({ quotaTool: { baseUrl, timeoutMs: 2000 }, ...extra }),
  );
}

describe('mapping/credential absence defaults to missing (fail-open pass-through)', () => {
  test('unmapped provider → missing, and no HTTP request is attempted at all', async () => {
    const fixture = await start();
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();
    const result = await rig.refresher.getSnapshot('not-in-config');
    expect(isMissingSnapshot(result)).toBe(true);
    expect(result).toEqual({ providerId: 'not-in-config', missing: true });
    expect(fixture.requests).toHaveLength(0);
  });

  test('mapped but credentials not enrolled → missing (no snapshot fabricated)', async () => {
    const fixture = await start();
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig({ enrollCredentials: false });
    const result = await rig.refresher.getSnapshot('volcano-profile');
    expect(isMissingSnapshot(result)).toBe(true);
    expect(fixture.requests).toHaveLength(0); // 凭证层先于 HTTP 收口（不发起查询）
  });
});

describe('TTL lazy refresh', () => {
  test('fresh snapshot (data time within TTL) is served with zero network requests', async () => {
    const fixture = await start();
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();
    rig.snapshots.upsert({
      providerId: 'volcano-profile',
      tier: 'plenty',
      signalKind: 'absolute',
      score: 90,
      fetchedAt: new Date(nowMsValue - 60_000).toISOString(), // 1 分钟前，TTL 5 分钟
      storedAt: new Date(nowMsValue).toISOString(),
      windows: [],
      summary: [],
    });
    const result = await rig.refresher.getSnapshot('volcano-profile');
    expect(isMissingSnapshot(result)).toBe(false);
    if (isMissingSnapshot(result)) return;
    expect(result.tier).toBe('plenty');
    expect(fixture.requests).toHaveLength(0);
  });

  test('stale snapshot triggers a lazy refresh; tier and data time come from quota-tool', async () => {
    const fixture = await start({
      // 数据时间用固定值：断言快照 fetchedAt 逐字来自 quota-tool 的 updatedAt
      volcano: {
        kind: 'success',
        result: afpResult(96, '2026-09-11T12:00:00Z'),
      },
    });
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();
    rig.snapshots.upsert({
      providerId: 'volcano-profile',
      tier: 'plenty',
      signalKind: 'absolute',
      score: 90,
      fetchedAt: new Date(nowMsValue - 301_000).toISOString(), // 超 TTL 1 秒
      storedAt: new Date(nowMsValue).toISOString(),
      windows: [],
      summary: [],
    });
    const result = await rig.refresher.getSnapshot('volcano-profile');
    expect(isMissingSnapshot(result)).toBe(false);
    if (isMissingSnapshot(result)) return;
    expect(result.tier).toBe('critical');
    expect(result.fetchedAt).toBe('2026-09-11T12:00:00Z'); // 数据时间=quota-tool updatedAt
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].provider).toBe('volcano');
    // 落库：后续消费方可直接读
    expect(rig.snapshots.get('volcano-profile')?.tier).toBe('critical');
  });

  test('TTL boundary: data age exactly equal to TTL still counts as stale (refreshes)', async () => {
    const fixture = await start({
      volcano: { kind: 'success', result: afpResult(10) },
    });
    writeConfigWithBaseUrl(fixture.baseUrl, { snapshotTtlMs: 60_000 });
    const rig = await buildRig();
    rig.snapshots.upsert({
      providerId: 'volcano-profile',
      tier: 'critical',
      signalKind: 'absolute',
      score: 9,
      fetchedAt: new Date(nowMsValue - 60_000).toISOString(),
      storedAt: new Date(nowMsValue).toISOString(),
      windows: [],
      summary: [],
    });
    await rig.refresher.getSnapshot('volcano-profile');
    expect(fixture.requests).toHaveLength(1);
  });

  test('refreshNow bypasses TTL even when the snapshot is fresh', async () => {
    const fixture = await start({
      volcano: { kind: 'success', result: afpResult(75) }, // 已用 75% → 剩余 25 → 紧张
    });
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();
    rig.snapshots.upsert({
      providerId: 'volcano-profile',
      tier: 'plenty',
      signalKind: 'absolute',
      score: 90,
      fetchedAt: new Date(nowMsValue - 1_000).toISOString(),
      storedAt: new Date(nowMsValue).toISOString(),
      windows: [],
      summary: [],
    });
    const result = await rig.refresher.refreshNow('volcano-profile');
    expect(isMissingSnapshot(result)).toBe(false);
    if (isMissingSnapshot(result)) return;
    expect(result.tier).toBe('tight');
    expect(fixture.requests).toHaveLength(1);
  });
});

describe('single-flight debounce', () => {
  test('concurrent getSnapshot for the same provider issues exactly one query', async () => {
    const fixture = await start({
      volcano: { kind: 'success', result: afpResult(50) },
    });
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();
    const [a, b] = await Promise.all([
      rig.refresher.getSnapshot('volcano-profile'),
      rig.refresher.getSnapshot('volcano-profile'),
    ]);
    expect(fixture.requests).toHaveLength(1);
    expect(a).toEqual(b);
    // 刷新完成后的下一次调用命中新鲜快照（数据时间=当下），零请求
    await rig.refresher.getSnapshot('volcano-profile');
    expect(fixture.requests).toHaveLength(1);
  });
});

describe('refresh failure keeps routing alive (ADR-0004 fail-open branches)', () => {
  function seedStale(rig: Rig, fetchedAtOffsetMs: number): void {
    rig.snapshots.upsert({
      providerId: 'volcano-profile',
      tier: 'tight',
      signalKind: 'absolute',
      score: 20,
      fetchedAt: new Date(nowMsValue - fetchedAtOffsetMs).toISOString(),
      storedAt: new Date(nowMsValue).toISOString(),
      windows: [
        {
          label: '5h Rolling',
          total: 500_000,
          used: 400_000,
          remaining: 100_000,
          percentage: 80,
          resetAt: null,
          unit: 'AFP',
        },
      ],
      summary: [],
    });
  }

  test('credential rejection: stale snapshot is served as-is (data time marks staleness)', async () => {
    const fixture = await start({ volcano: credentialRejected() });
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();
    seedStale(rig, 600_000);
    const result = await rig.refresher.getSnapshot('volcano-profile');
    expect(isMissingSnapshot(result)).toBe(false);
    if (isMissingSnapshot(result)) return;
    expect(result.tier).toBe('tight'); // 陈旧照用
    expect(result.fetchedAt).toBe(new Date(nowMsValue - 600_000).toISOString());
    // 库里也没被坏数据覆盖
    expect(rig.snapshots.get('volcano-profile')?.tier).toBe('tight');
  });

  test('service unreachable: stale snapshot served; without one, missing', async () => {
    const fixture = await start();
    const baseUrl = fixture.baseUrl;
    await fixture.stop();
    fixtures.length = 0;
    writeConfigWithBaseUrl(baseUrl);
    const rig = await buildRig();

    seedStale(rig, 600_000);
    const stale = await rig.refresher.getSnapshot('volcano-profile');
    expect(isMissingSnapshot(stale)).toBe(false);

    const other = await rig.refresher.getSnapshot('opencode-profile');
    expect(isMissingSnapshot(other)).toBe(true); // 无快照 → missing（放行，不否决）
  });

  test('provider-level ok:false with no snapshot → missing (unregistered vendor mapping)', async () => {
    const fixture = await start(); // 无脚本：未知厂家
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();
    await withFsRetry(() =>
      rig.credentials.save('volcano-profile', {
        quotaToolProvider: 'volcano',
        credentials: { accessKeyId: 'ak' },
      }),
    );
    const result = await rig.refresher.getSnapshot('volcano-profile');
    expect(result).toEqual({ providerId: 'volcano-profile', missing: true });
  });

  test('timeout: stale snapshot served; timeout is not an error thrown at callers', async () => {
    const fixture = await start({
      volcano: { kind: 'timeout', delayMs: 10_000 },
    });
    writeConfigWithBaseUrl(fixture.baseUrl, {
      quotaTool: { baseUrl: fixture.baseUrl, timeoutMs: 60 },
    });
    const rig = await buildRig();
    seedStale(rig, 600_000);
    const result = await rig.refresher.getSnapshot('volcano-profile');
    expect(isMissingSnapshot(result)).toBe(false);
    if (isMissingSnapshot(result)) return;
    expect(result.fetchedAt).toBe(new Date(nowMsValue - 600_000).toISOString());
  });
});

describe('config hot reload (no UI, file edit takes effect on access)', () => {
  test('threshold edit changes tier on the next refresh without restarting', async () => {
    const fixture = await start({
      opencode: {
        kind: 'success',
        result: {
          updatedAt: '2026-09-11T12:00:00Z',
          summary: [],
          windows: [
            {
              label: '5h Rolling',
              total: 100,
              used: 80,
              remaining: 20,
              percentage: 80,
              resetAt: null,
              unit: '%',
            },
          ],
          details: [],
        },
      },
    });
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();

    const before = await rig.refresher.refreshNow('opencode-profile');
    expect(isMissingSnapshot(before)).toBe(false);
    if (isMissingSnapshot(before)) return;
    expect(before.tier).toBe('tight'); // 剩余 20 ≤ tight 25

    // 改阈值文件并强制 mtime 前移（热生效）
    writeConfig(
      baseConfig({
        quotaTool: { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
        tierThresholds: {
          absolute: { tight: 25, critical: 10, exhausted: 0 },
          percentage: { tight: 15, critical: 10, exhausted: 0 },
          currency: { tight: 20, critical: 5, exhausted: 0 },
        },
      }),
    );
    const future = nowMsValue + 5_000;
    fs.utimesSync(CONFIG_FILE, new Date(future), new Date(future));

    const after = await rig.refresher.refreshNow('opencode-profile');
    expect(isMissingSnapshot(after)).toBe(false);
    if (isMissingSnapshot(after)) return;
    expect(after.tier).toBe('plenty'); // 剩余 20 > 新 tight 15
  });

  test('mapping removal reverts the provider to missing (native behavior, fail-open)', async () => {
    const fixture = await start({
      volcano: { kind: 'success', result: afpResult(50) },
    });
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig();
    await withFsRetry(() =>
      rig.credentials.save('volcano-profile', {
        quotaToolProvider: 'volcano',
        credentials: { accessKeyId: 'ak' },
      }),
    );
    expect(
      isMissingSnapshot(await rig.refresher.refreshNow('volcano-profile')),
    ).toBe(false);

    writeConfig(
      baseConfig({
        quotaTool: { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
        providers: {}, // 映射清空
      }),
    );
    const future = nowMsValue + 5_000;
    fs.utimesSync(CONFIG_FILE, new Date(future), new Date(future));

    const result = await rig.refresher.getSnapshot('volcano-profile');
    expect(result).toEqual({ providerId: 'volcano-profile', missing: true });
  });
});

describe('storage layer exceptions are absorbed (P1: never rejects, ADR-0004)', () => {
  const diskError = () => {
    throw new Error('SQLite disk I/O error (simulated)');
  };
  /** 包住真实快照库，按脚本让 get/upsert 抛错（查询路径仍吃 fake-quota-tool） */
  function flakyStore(
    inner: InstanceType<typeof QuotaSnapshotStore>,
    faults: { get?: () => void; upsert?: () => void },
  ): InstanceType<typeof QuotaSnapshotStore> {
    return {
      get: (id: string) => {
        if (faults.get) faults.get();
        return inner.get(id);
      },
      upsert: (snapshot: unknown) => {
        if (faults.upsert) faults.upsert();
        return inner.upsert(snapshot as never);
      },
    } as unknown as InstanceType<typeof QuotaSnapshotStore>;
  }

  test('snapshot read throws + service unreachable → resolves missing, does not reject', async () => {
    const fixture = await start(); // 无脚本：查询走 unknown-vendor 失败路
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig({
      wrapSnapshots: (inner) => flakyStore(inner, { get: diskError }),
    });

    // 显式 await 无 reject 即通过；再防一层断言结果形态
    await expect(rig.refresher.getSnapshot('volcano-profile')).resolves.toEqual(
      { providerId: 'volcano-profile', missing: true },
    );
  });

  test('snapshot read and write both throw + service fine → still serves the fresh snapshot, does not reject', async () => {
    const fixture = await start({
      volcano: { kind: 'success', result: afpResult(96) },
    });
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig({
      wrapSnapshots: (inner) =>
        flakyStore(inner, { get: diskError, upsert: diskError }),
    });

    const result = await rig.refresher.getSnapshot('volcano-profile');
    expect(isMissingSnapshot(result)).toBe(false); // 刚取到的数据不因落库失败被丢弃
    if (isMissingSnapshot(result)) return;
    expect(result.tier).toBe('critical');
    expect(fixture.requests).toHaveLength(1);
    // 二次访问：读仍抛错 → 重走刷新，依旧不抛（无持久化，符合降级预期）
    await expect(
      rig.refresher.getSnapshot('volcano-profile'),
    ).resolves.toBeDefined();
  });

  test('refreshNow with throwing store never rejects (public surface is rejection-free)', async () => {
    const fixture = await start({
      volcano: { kind: 'success', result: afpResult(96) },
    });
    writeConfigWithBaseUrl(fixture.baseUrl);
    const rig = await buildRig({
      wrapSnapshots: (inner) => flakyStore(inner, { get: diskError }),
    });

    await expect(
      rig.refresher.refreshNow('volcano-profile'),
    ).resolves.toBeDefined();
  });

  test('injected query function throwing folds to unreachable (stale served or missing)', async () => {
    const fixture = await start();
    writeConfigWithBaseUrl(fixture.baseUrl);
    const inner = new QuotaSnapshotStore(DB_PATH);
    openStores.push(inner);
    const config = new QuotaRouterConfigLoader(CONFIG_FILE);
    const credentials = new QuotaCredentialStore(CRED_FILE);
    await withFsRetry(() =>
      credentials.save('volcano-profile', {
        quotaToolProvider: 'volcano',
        credentials: { token: 't' },
      }),
    );
    const refresher = new QuotaSnapshotRefresher({
      config,
      credentials,
      snapshots: inner,
      query: () => Promise.reject(new Error('query stub exploded')),
      nowMs: clock.nowMs,
    });

    await expect(refresher.getSnapshot('volcano-profile')).resolves.toEqual({
      providerId: 'volcano-profile',
      missing: true,
    });
  });
});
