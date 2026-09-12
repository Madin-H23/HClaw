/**
 * T7-A：额度面板只读口径（装配 facade quotaPanel）——真实配置装载 + 真实快照库
 *
 * 用临时 DATA_DIR 走生产装配路径（同 T6 fail-open 测试的装配方式），断言：
 * - 未配置映射 → configured=false，全部条目 mapped=false、无快照（零重件构造）；
 * - 已配置且有快照 → 条目带档位/信号/数据时间，陈旧以 TTL 裁决（只标注）；
 * - 映射指向池外 id 也出现在面板（映射存在性是面板职责）；
 * - 装配降级（构造失败）→ 快照槽位缺失，面板不炸（fail-open）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-panel-'));

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
const { QuotaRouterAssembly, buildQuotaPanelData } =
  await import('../src/quota-router/assembly.js');

const CONFIG_FILE = path.join(tmp, 'config', 'quota-router.json');
const CRED_FILE = path.join(tmp, 'config', 'quota-router-credentials.json');
const DB_PATH = path.join(tmp, 'db', 'quota-router.db');
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });

const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  // 懒刷新 fire-and-forget 落地窗口 + 关库，避免跨用例文件抖动（Windows EPERM）
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* 幂等 */
    }
  }
  for (const suffix of ['-wal', '-shm'])
    fs.rmSync(DB_PATH + suffix, { force: true });
});

function writeConfig(providers: Record<string, unknown>, ttlMs = 300_000) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      quotaTool: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 },
      snapshotTtlMs: ttlMs,
      providers,
    }),
  );
}

function buildAssembly(poolIds: string[]) {
  const config = new QuotaRouterConfigLoader(CONFIG_FILE);
  const credentials = new QuotaCredentialStore(CRED_FILE);
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
      poolIds.map((profileId) => ({ profileId, weight: 1, enabled: true })),
    resetSticky: vi.fn(),
    strategyOf: () => 'round-robin',
    nowMs: () => Date.now(),
  });
  return { config, snapshots, assembly };
}

function panelOf(
  assembly: InstanceType<typeof QuotaRouterAssembly>,
  config: {
    get(): { providers: Record<string, unknown>; snapshotTtlMs: number };
  },
  providerIds: string[],
) {
  // 与生产 facade 同一组装函数（buildQuotaPanelData）+ 真实 panelEntry
  return buildQuotaPanelData({
    mappedProviders: config.get().providers,
    snapshotTtlMs: config.get().snapshotTtlMs,
    poolProviderIds: providerIds,
    panelEntryOf: (providerId) => assembly.panelEntry(providerId),
  });
}

describe('quotaPanel 只读口径', () => {
  test('未配置映射 → configured=false，条目全降级（面板明示未配置额度源）', () => {
    writeConfig({});
    const { config, assembly } = buildAssembly(['zhipu-glm']);
    const panel = panelOf(assembly, config, ['zhipu-glm']);
    expect(panel.configured).toBe(false);
    expect(panel.entries[0]).toMatchObject({
      providerId: 'zhipu-glm',
      mapped: false,
      snapshot: null,
      stale: false,
      ageMs: null,
    });
  });

  test('已配置 + 新鲜快照 → 档位/信号/数据时间齐备且 stale=false', () => {
    writeConfig({ 'zhipu-glm': { quotaToolProvider: 'zhipu' } });
    const { config, snapshots, assembly } = buildAssembly(['zhipu-glm']);
    const now = Date.now();
    snapshots.upsert({
      providerId: 'zhipu-glm',
      tier: 'plenty',
      signalKind: 'percentage',
      score: 68,
      fetchedAt: new Date(now - 60_000).toISOString(),
      storedAt: new Date(now).toISOString(),
      windows: [],
      summary: [],
    });
    const panel = panelOf(assembly, config, ['zhipu-glm']);
    expect(panel.configured).toBe(true);
    expect(panel.entries[0].snapshot?.tier).toBe('plenty');
    expect(panel.entries[0].snapshot?.signalKind).toBe('percentage');
    expect(panel.entries[0].snapshot?.fetchedAt).toBeTruthy();
    expect(panel.entries[0].stale).toBe(false);
    expect(panel.entries[0].ageMs).not.toBeNull();
  });

  test('数据时间超 TTL → stale=true（陈旧照用，只标注——ADR-0004）', () => {
    writeConfig({ 'zhipu-glm': { quotaToolProvider: 'zhipu' } }, 60_000);
    const { config, snapshots, assembly } = buildAssembly(['zhipu-glm']);
    const now = Date.now();
    snapshots.upsert({
      providerId: 'zhipu-glm',
      tier: 'tight',
      signalKind: 'percentage',
      score: 18,
      fetchedAt: new Date(now - 47 * 60_000).toISOString(),
      storedAt: new Date(now).toISOString(),
      windows: [],
      summary: [],
    });
    const panel = panelOf(assembly, config, ['zhipu-glm']);
    expect(panel.entries[0].stale).toBe(true);
    expect(panel.entries[0].ageMs).toBeGreaterThanOrEqual(47 * 60_000);
  });

  test('已登记但池外/无快照的映射 id → 条目在列、快照缺失（降级展示）', () => {
    writeConfig({ 'legacy-id': { quotaToolProvider: 'legacy' } });
    const { config, assembly } = buildAssembly(['zhipu-glm']);
    const panel = panelOf(assembly, config, ['zhipu-glm', 'legacy-id']);
    const legacy = panel.entries.find((e) => e.providerId === 'legacy-id');
    expect(legacy?.mapped).toBe(true);
    expect(legacy?.snapshot).toBeNull();
    const pooled = panel.entries.find((e) => e.providerId === 'zhipu-glm');
    expect(pooled?.mapped).toBe(false);
  });
});
