import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// P1-2 复测钉死：生产 facade 重件构造（快照库/凭证）可抛（quota-router.db
// 打不开等），必须就地吸收——记一次 WARN 后按「未激活」处理，四个入口统一
// fail-open（选路/绑定/粘滞/fallback 全部原生行为），进程内不重试重抛刷屏
// （ADR-0004：额度路由绝不成为拒绝服务源）。

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-init-failopen-'));

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
const runtimeConfig =
  (await import('../src/runtime-config.js')) as typeof import('../src/runtime-config.js');
const db = (await import('../src/db.js')) as typeof import('../src/db.js');
const { buildVolumeMounts, getContainerRuntimeEnvDir, trySelectPoolProvider } =
  await import('../src/container-runner.js');
const {
  ensureQuotaRoutingInstalled,
  quotaBindingGate,
  quotaFallbackModel,
  quotaStickyGate,
} = await import('../src/quota-router/assembly.js');

const rootDbPath = path.join(root, 'db', 'quota-router.db');
const rootConfigPath = path.join(root, 'config', 'quota-router.json');

beforeAll(() => {
  db.initDatabase();
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  // 快照库路径放成目录：QuotaSnapshotStore 构造必抛（SQLITE_CANTOPEN）
  fs.mkdirSync(rootDbPath, { recursive: true });
  // 映射配置在册（激活态），凭证缺册——构造在快照库那一步就已炸
  fs.writeFileSync(
    rootConfigPath,
    JSON.stringify({
      version: 1,
      quotaTool: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 },
      snapshotTtlMs: 300_000,
      providers: { 'provider-x': { quotaToolProvider: 'volcano' } },
    }),
  );
});

afterAll(() => {
  db.closeDatabase();
  // 目录形态的假库路径无法 rmSync 整树（内容为空目录可以），逐层清理
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟释放，留待系统清理 */
  }
});

function volumeGroup(folder: string): Parameters<typeof buildVolumeMounts>[0] {
  return {
    name: folder,
    folder,
    added_at: '2026-09-11T00:00:00.000Z',
    created_by: null,
    is_home: false,
    executionMode: 'container',
    containerConfig: { additionalMounts: [] },
  } as Parameters<typeof buildVolumeMounts>[0];
}

function fallbackEnvValue(folder: string): string | undefined {
  const envPath = path.join(
    getContainerRuntimeEnvDir(folder, undefined, undefined, null),
    'env',
  );
  const line = fs
    .readFileSync(envPath, 'utf-8')
    .split('\n')
    .find((candidate) => candidate.startsWith('MINICLAW_FALLBACK_MODEL='));
  if (!line) return undefined;
  const raw = line.slice('MINICLAW_FALLBACK_MODEL='.length).trim();
  const quoted = /^'(.*)'$/.exec(raw);
  return quoted ? quoted[1] : raw;
}

describe('构造失败 fail-open（P1-2）：快照库打不开 → 全入口原生行为 + 单次 WARN', () => {
  test('绑定选路原样放行，gate 返回 null，不抛错', () => {
    const provider = runtimeConfig.createProvider({
      name: 'init-failopen-bound',
      type: 'third_party',
      anthropicBaseUrl: 'https://init-failopen.test',
      anthropicAuthToken: 'token',
      anthropicModel: 'model-init-failopen',
      enabled: true,
    });
    // 激活态（映射在册）但快照库不可用：绑定照常放行，绝不硬失败
    const result = trySelectPoolProvider('grp-init', null, provider.id);
    expect(result?.profileId).toBe(provider.id);
    expect(db.getSessionProviderId('grp-init')).toBe(provider.id);

    expect(quotaBindingGate('grp-init', null, provider.id)).toBeNull();
    expect(quotaStickyGate('grp-init', null, provider.id)).toBeNull();
    expect(quotaFallbackModel({})).toBeNull();
  });

  test('fallback 源回退 SystemSettings 单值（真实 buildVolumeMounts）', () => {
    runtimeConfig.saveSystemSettings({
      fallbackModel: 'settings-static-model',
    });
    const provider = runtimeConfig.getProviders().at(-1)!;
    buildVolumeMounts(
      volumeGroup('grp-init-fb'),
      false,
      false,
      undefined,
      undefined,
      undefined,
      runtimeConfig.resolveProviderById(provider.id),
    );
    expect(fallbackEnvValue('grp-init-fb')).toBe('settings-static-model');
  });

  test('失败态有记忆：再次触发全部入口，WARN 只记一次（不刷屏）', () => {
    const provider = runtimeConfig.getProviders().at(-1)!;
    trySelectPoolProvider('grp-init-2', null, provider.id);
    quotaBindingGate('grp-init-2', null, provider.id);
    quotaStickyGate('grp-init-2', null, provider.id);
    quotaFallbackModel({});
    ensureQuotaRoutingInstalled();
    const warns = vi
      .mocked(logger.warn)
      .mock.calls.filter((call) => String(call[1]).includes('装配构造失败'));
    expect(warns).toHaveLength(1);
  });
});
