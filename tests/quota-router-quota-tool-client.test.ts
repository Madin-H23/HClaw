import { afterEach, describe, expect, test } from 'vitest';

import { queryQuotaTool } from '../src/quota-router/quota-tool-client.js';
import {
  credentialRejected,
  startFakeQuotaTool,
  type FakeQuotaTool,
  type QuotaQueryResult,
} from './quota-router-stubs/fake-quota-tool.js';

// quota-tool 适配器：真实 HTTP 客户端吃 T2 fake-quota-tool 桩，验证统一契约
// 三类信号解析、供应商级失败形态（HTTP 200 + ok:false，T2 对真实服务实证）、
// 超时与未知厂家。全部失败都走结构化返回不抛异常——上层刷新器 fail-open 的前提。

const fixtures: FakeQuotaTool[] = [];

afterEach(async () => {
  for (const fixture of fixtures) await fixture.stop();
  fixtures.length = 0;
});

async function start(
  scripts?: Parameters<typeof startFakeQuotaTool>[0],
): Promise<FakeQuotaTool> {
  const fixture = await startFakeQuotaTool(scripts);
  fixtures.push(fixture);
  return fixture;
}

// 三类信号成功载荷（形态对齐真实 providers/*.mjs 的 normalize 输出）
const volcanoAfpResult: QuotaQueryResult = {
  updatedAt: '2026-09-11T08:00:00Z',
  summary: [
    { label: '套餐', value: 'Agent Plan Pro' },
    { label: '总额度', value: 500_000 },
    { label: '已用', value: 50_000 },
  ],
  windows: [
    {
      label: '5h Rolling',
      total: 500_000,
      used: 50_000,
      remaining: 450_000,
      percentage: 10,
      resetAt: '2026-09-11T13:00:00Z',
      unit: 'AFP',
    },
    {
      label: 'Monthly',
      total: 2_000_000,
      used: 400_000,
      remaining: 1_600_000,
      percentage: 20,
      resetAt: '2026-10-01T00:00:00Z',
      unit: 'AFP',
    },
  ],
  details: [],
};

const opencodePercentResult: QuotaQueryResult = {
  updatedAt: '2026-09-11T08:00:00Z',
  summary: [{ label: 'API 精度', value: '仅整数百分比(±0.5%)' }],
  windows: [
    {
      label: '5h Rolling',
      total: 100,
      used: 75,
      remaining: 25,
      percentage: 75,
      resetAt: '2026-09-11T13:00:00Z',
      unit: '%',
    },
  ],
  details: [],
};

const deepseekBalanceResult: QuotaQueryResult = {
  updatedAt: '2026-09-11T08:00:00Z',
  summary: [
    { label: 'CNY 总余额', value: 110.5 },
    { label: 'CNY 充值余额', value: 100 },
    { label: 'CNY 赠送余额', value: 10.5 },
  ],
  windows: [],
  details: [],
  extra: { available: true },
};

describe('queryQuotaTool parses all three heterogeneous signal kinds', () => {
  test('volcano AFP absolute windows come through with numbers intact', async () => {
    const fixture = await start({
      volcano: { kind: 'success', result: volcanoAfpResult },
    });
    const outcome = await queryQuotaTool(
      { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
      'volcano',
      { accessKeyId: 'ak', accessKeySecret: 'sk', region: 'cn-beijing' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.updatedAt).toBe('2026-09-11T08:00:00Z');
    expect(outcome.payload.windows).toHaveLength(2);
    expect(outcome.payload.windows[0]).toEqual({
      label: '5h Rolling',
      total: 500_000,
      used: 50_000,
      remaining: 450_000,
      percentage: 10,
      resetAt: '2026-09-11T13:00:00Z',
      unit: 'AFP',
    });
    expect(outcome.payload.details).toEqual([]);
  });

  test('OpenCode integer-percentage window parses with null-free numeric fields', async () => {
    const fixture = await start({
      opencode: { kind: 'success', result: opencodePercentResult },
    });
    const outcome = await queryQuotaTool(
      { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
      'opencode',
      { authCookie: 'auth=t' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.windows[0]).toEqual({
      label: '5h Rolling',
      total: 100,
      used: 75,
      remaining: 25,
      percentage: 75,
      resetAt: '2026-09-11T13:00:00Z',
      unit: '%',
    });
  });

  test('DeepSeek balance-only payload: empty windows + numeric summary', async () => {
    const fixture = await start({
      deepseek: { kind: 'success', result: deepseekBalanceResult },
    });
    const outcome = await queryQuotaTool(
      { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
      'deepseek',
      { apiKey: 'sk-test' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.windows).toEqual([]);
    expect(outcome.payload.summary[0]).toEqual({
      label: 'CNY 总余额',
      value: 110.5,
    });
  });

  test('nullable numeric fields and contract-external extras pass through leniently', async () => {
    const fixture = await start({
      odd: {
        kind: 'success',
        result: {
          updatedAt: '2026-09-11T08:00:00Z',
          summary: [{ label: '套餐', value: 'Plan' }],
          windows: [
            {
              label: 'Weekly',
              total: null,
              used: null,
              remaining: null,
              percentage: null,
              resetAt: null,
              unit: 'AFP',
            },
          ],
          details: [],
        },
      },
    });
    const outcome = await queryQuotaTool(
      { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
      'odd',
      {},
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.windows[0].total).toBeNull();
    expect(outcome.payload.windows[0].percentage).toBeNull();
  });
});

describe('provider-level failures arrive as HTTP 200 {ok:false} (not 4xx)', () => {
  test('credential rejection passes the connector message through verbatim', async () => {
    const fixture = await start({
      opencode: credentialRejected(),
      volcano: credentialRejected(
        'GetAFPUsage: 鉴权失败（SignatureDoesNotMatch）：请确认 AccessKey ID/Secret 正确',
      ),
    });
    const rejected = await queryQuotaTool(
      { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
      'opencode',
      { authCookie: 'auth=bad' },
    );
    expect(rejected).toEqual({
      ok: false,
      kind: 'provider-error',
      error: '认证失败 (HTTP 401)，请检查 auth cookie',
    });

    const volcanoRejected = await queryQuotaTool(
      { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
      'volcano',
      { accessKeyId: 'ak', accessKeySecret: 'bad' },
    );
    expect(volcanoRejected.ok).toBe(false);
    if (volcanoRejected.ok) return;
    expect(volcanoRejected.kind).toBe('provider-error');
    expect(volcanoRejected.error).toContain(
      '鉴权失败（SignatureDoesNotMatch）',
    );
  });

  test('unregistered provider returns the fake-server unknown-vendor message', async () => {
    const fixture = await start();
    const outcome = await queryQuotaTool(
      { baseUrl: fixture.baseUrl, timeoutMs: 2000 },
      'no-such-vendor',
      {},
    );
    expect(outcome).toEqual({
      ok: false,
      kind: 'provider-error',
      error: '未知厂家: no-such-vendor',
    });
  });
});

describe('service-level unreachability never throws', () => {
  test('timeout script + tight client timeout → unreachable outcome', async () => {
    const fixture = await start({
      slow: { kind: 'timeout', delayMs: 5000 },
    });
    const outcome = await queryQuotaTool(
      { baseUrl: fixture.baseUrl, timeoutMs: 80 },
      'slow',
      {},
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('unreachable');
    expect(outcome.error).toContain('不可达');
  });

  test('connection refused (server stopped) → unreachable outcome', async () => {
    const fixture = await start();
    const { baseUrl } = fixture;
    await fixture.stop();
    fixtures.length = 0; // 已停，afterEach 不再重复 stop
    const outcome = await queryQuotaTool(
      { baseUrl, timeoutMs: 2000 },
      'zhipu',
      { token: 't' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('unreachable');
    expect(outcome.error).toContain('不可达');
  });
});
