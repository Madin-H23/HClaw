/**
 * T7-A：额度面板取数端点（src/routes/quota.ts）——响应形状组装实证
 *
 * mock 装配 facade（quotaPanelData）与上游鉴权中间件（鉴权 wiring 本身是
 * 上游 authMiddleware/systemConfigMiddleware 原样复用，不在本测试职责内），
 * 断言面板行的字段映射：档位中文标签、displayName 回退、映射缺失/快照缺失
 * 的降级形态、陈旧标注透传——绝不出现任何凭证字段。
 */
import { describe, expect, test, vi } from 'vitest';

const facadeMocks = vi.hoisted(() => ({
  quotaPanelData: vi.fn(),
}));
const runtimeMocks = vi.hoisted(() => ({
  getProviders: vi.fn(() => [
    { id: 'zhipu-glm', name: '智谱 GLM', enabled: true },
    { id: 'opencode-go', name: 'OpenCode Go', enabled: false },
  ]),
}));

vi.mock('../src/quota-router/assembly.js', () => facadeMocks);
vi.mock('../src/runtime-config.js', () => runtimeMocks);
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  systemConfigMiddleware: async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

const quotaRoutes = (await import('../src/routes/quota.js')).default;

const STORED = {
  providerId: 'zhipu-glm',
  tier: 'plenty' as const,
  signalKind: 'percentage' as const,
  score: 68,
  fetchedAt: '2026-09-11T04:00:00.000Z',
  storedAt: '2026-09-11T04:00:05.000Z',
  windows: [
    {
      label: '5h',
      total: 100,
      used: 32,
      remaining: 68,
      percentage: 32,
      resetAt: null,
      unit: '%',
    },
  ],
  summary: [],
};

describe('GET /api/quota/panel（响应形状）', () => {
  test('已映射供应商：档位标签/信号/数据时间逐字段透出', async () => {
    facadeMocks.quotaPanelData.mockReturnValue({
      configured: true,
      snapshotTtlMs: 300_000,
      entries: [
        {
          providerId: 'zhipu-glm',
          mapped: true,
          snapshot: STORED,
          stale: false,
          ageMs: 60_000,
        },
      ],
    });
    const res = await quotaRoutes.request('/panel');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      providers: Array<Record<string, unknown>>;
    };
    expect(body.configured).toBe(true);
    const row = body.providers[0];
    expect(row.providerId).toBe('zhipu-glm');
    expect(row.displayName).toBe('智谱 GLM');
    expect(row.enabled).toBe(true);
    expect(row.mapped).toBe(true);
    expect(row.tier).toBe('plenty');
    expect(row.tierLabel).toBe('充足');
    expect(row.signalKind).toBe('percentage');
    expect(row.score).toBe(68);
    expect(row.fetchedAt).toBe('2026-09-11T04:00:00.000Z');
    expect(row.stale).toBe(false);
    expect(row.ageMs).toBe(60_000);
    expect(row.windows).toEqual(STORED.windows);
  });

  test('映射缺失（未登记）与快照缺失 → 降级字段（tier null / mapped false）', async () => {
    facadeMocks.quotaPanelData.mockReturnValue({
      configured: true,
      snapshotTtlMs: 300_000,
      entries: [
        {
          providerId: 'moonshot-kimi',
          mapped: false,
          snapshot: null,
          stale: false,
          ageMs: null,
        },
        {
          providerId: 'grok-beta',
          mapped: true,
          snapshot: null,
          stale: false,
          ageMs: null,
        },
      ],
    });
    const res = await quotaRoutes.request('/panel');
    const body = (await res.json()) as {
      providers: Array<Record<string, unknown>>;
    };
    const [unmapped, noSnapshot] = body.providers;
    expect(unmapped.mapped).toBe(false);
    expect(unmapped.tier).toBeNull();
    expect(unmapped.tierLabel).toBeNull();
    // 池内无此 id → displayName 回退为 id
    expect(unmapped.displayName).toBe('moonshot-kimi');
    expect(noSnapshot.mapped).toBe(true);
    expect(noSnapshot.tier).toBeNull();
    expect(noSnapshot.stale).toBe(false);
  });

  test('陈旧标注与停用状态透传；响应体零凭证字段', async () => {
    facadeMocks.quotaPanelData.mockReturnValue({
      configured: true,
      snapshotTtlMs: 60_000,
      entries: [
        {
          providerId: 'opencode-go',
          mapped: true,
          snapshot: { ...STORED, providerId: 'opencode-go' },
          stale: true,
          ageMs: 47 * 60_000,
        },
      ],
    });
    const res = await quotaRoutes.request('/panel');
    const raw = JSON.stringify(await res.json());
    expect(raw).toContain('"stale":true');
    expect(raw).toContain('OpenCode Go');
    // 红线：面板绝不携带凭证类字段
    for (const banned of [
      'apiKey',
      'authToken',
      'oauth',
      'token',
      'credential',
      'secret',
    ]) {
      expect(raw.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
