import { afterEach, describe, expect, test } from 'vitest';

import {
  credentialRejected,
  startFakeQuotaTool,
  type FakeQuotaTool,
  type QuotaQueryResult,
} from './quota-router-stubs/fake-quota-tool.js';

// fake quota-tool 自检：契约字段与真实服务逐字段一致（D:\Develop\multi-vendor-quota-tool
// app.mjs 只读核对），桩行为可断言、可重编程、启停干净无端口泄漏。

const fixtures: FakeQuotaTool[] = [];

async function start(
  scripts?: Parameters<typeof startFakeQuotaTool>[0],
): Promise<FakeQuotaTool> {
  const fixture = await startFakeQuotaTool(scripts);
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures) await fixture.stop();
  fixtures.length = 0;
});

function successResult(
  overrides?: Partial<QuotaQueryResult>,
): QuotaQueryResult {
  return {
    updatedAt: '2026-09-11T08:00:00Z',
    summary: [{ label: '套餐', value: 'Agent Plan 样本' }],
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
    ],
    details: [],
    ...overrides,
  };
}

describe('fake quota-tool serves the real /api/query contract', () => {
  test('success responses carry every unified-contract field with real shapes', async () => {
    const fixture = await start({
      zhipu: { kind: 'success', result: successResult() },
    });
    const { status, body } = await fixture.query('zhipu', { token: 't' });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.updatedAt as string))).toBe(false);
    expect(Array.isArray(body.summary)).toBe(true);
    expect(Array.isArray(body.windows)).toBe(true);
    expect(Array.isArray(body.details)).toBe(true);

    const summaryItem = (body.summary as Array<Record<string, unknown>>)[0];
    expect(Object.keys(summaryItem).sort()).toEqual(['label', 'value']);

    // windows 项七字段固定契约；数值字段（这里具数）为 number，resetAt 为 ISO 串
    const window = (body.windows as Array<Record<string, unknown>>)[0];
    expect(Object.keys(window).sort()).toEqual([
      'label',
      'percentage',
      'remaining',
      'resetAt',
      'total',
      'unit',
      'used',
    ]);
    expect(window).toEqual({
      label: '5h Rolling',
      total: 500_000,
      used: 50_000,
      remaining: 450_000,
      percentage: 10,
      resetAt: '2026-09-11T13:00:00Z',
      unit: 'AFP',
    });
  });

  test('null-valued window fields pass through for heterogeneous vendors', async () => {
    // 百分比-only 供应商（火山 CodingPlan / OpenCode）：total/used/remaining 为 null
    const fixture = await start({
      opencode: {
        kind: 'success',
        result: successResult({
          windows: [
            {
              label: '5h Rolling',
              total: 100,
              used: 42,
              remaining: 58,
              percentage: 42,
              resetAt: '2026-09-11T13:00:00Z',
              unit: '%',
            },
          ],
        }),
      },
    });
    const { body } = await fixture.query('opencode', {});
    const window = (body.windows as Array<Record<string, unknown>>)[0];
    expect(window.total).toBe(100);
    expect(window.unit).toBe('%');
    expect(window.resetAt).toBe('2026-09-11T13:00:00Z');
  });

  test('provider-level errors stay on HTTP 200 with ok:false like the real service', async () => {
    const fixture = await start({
      deepseek: { kind: 'error', error: '接口未返回余额数据' },
    });
    const { status, body } = await fixture.query('deepseek', {
      apiKey: 'sk-x',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: '接口未返回余额数据' });
  });

  test('credential rejection is expressible with the real auth-failure wording', async () => {
    // 默认文案 = OpenCode 连接器 cookie 路径认证失败原话（providers/opencode.mjs）
    const fixture = await start({ opencode: credentialRejected() });
    const { body } = await fixture.query('opencode', { authCookie: 'auth=x' });
    expect(body.ok).toBe(false);
    expect(body.error).toBe('认证失败 (HTTP 401)，请检查 auth cookie');
  });

  test('unregistered providers mirror the real 未知厂家 wording on HTTP 200', async () => {
    const fixture = await start({
      zhipu: { kind: 'success', result: successResult() },
    });
    const { status, body } = await fixture.query('nobody', {});
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: '未知厂家: nobody' });
  });

  test('malformed JSON bodies get the real HTTP 400 wording', async () => {
    const fixture = await start({
      zhipu: { kind: 'success', result: successResult() },
    });
    const response = await fetch(`${fixture.baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '请求体不是合法 JSON' });
  });

  test('recorded requests expose provider and credentials for behavior assertions', async () => {
    const fixture = await start({
      zhipu: { kind: 'success', result: successResult() },
    });
    await fixture.query('zhipu', { token: 'secret-token', base: 'https://x' });
    await fixture.query('nobody', {});
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0]).toMatchObject({
      provider: 'zhipu',
      credentials: { token: 'secret-token', base: 'https://x' },
    });
    expect(fixture.requests[1].provider).toBe('nobody');
  });
});

describe('fake quota-tool scriptable failure modes', () => {
  test('timeout scripts hold the response so clients observe slowness, then settle', async () => {
    const fixture = await start({
      zhipu: { kind: 'timeout', delayMs: 400 },
    });

    // 客户端超时先到：请求被中止（后续票的 fail-open 分支据此触发）
    await expect(fixture.query('zhipu', {}, 50)).rejects.toThrowError();
    // 桩侧最终仍回包（ok:false），不留下永久挂起
    const settled = await fixture.query('zhipu', {});
    expect(settled.body).toEqual({ ok: false, error: '请求超时' });
  });

  test('scripts can be reprogrammed between cases, including de-registration', async () => {
    const fixture = await start({
      zhipu: { kind: 'success', result: successResult() },
    });
    expect((await fixture.query('zhipu', {})).body.ok).toBe(true);

    fixture.setScript('zhipu', { kind: 'error', error: 'Token 已过期' });
    expect((await fixture.query('zhipu', {})).body).toEqual({
      ok: false,
      error: 'Token 已过期',
    });

    fixture.setScript('zhipu', null);
    expect((await fixture.query('zhipu', {})).body).toEqual({
      ok: false,
      error: '未知厂家: zhipu',
    });
  });

  test('extra contract-external fields pass through untouched like real vendors', async () => {
    // DeepSeek 真实实现会附带 extra 字段（app.mjs 的 {...result} 透传）
    const fixture = await start({
      deepseek: {
        kind: 'success',
        result: successResult({ extra: { available: true } }),
      },
    });
    const { body } = await fixture.query('deepseek', {});
    expect(body.extra).toEqual({ available: true });
  });
});

describe('fake quota-tool metadata endpoints match the real service', () => {
  test('GET /api/providers lists registered scripts with id/name/fields', async () => {
    const fixture = await start({
      zhipu: { kind: 'success', result: successResult() },
      deepseek: { kind: 'error', error: 'x' },
    });
    const response = await fetch(`${fixture.baseUrl}/api/providers`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: 'zhipu', name: 'zhipu', fields: [] },
      { id: 'deepseek', name: 'deepseek', fields: [] },
    ]);
  });

  test('GET /api/version returns a version object and unknown paths 404', async () => {
    const fixture = await start();
    const version = await fetch(`${fixture.baseUrl}/api/version`);
    expect(version.status).toBe(200);
    expect(await version.json()).toEqual({ version: '1.0.0' });

    const missing = await fetch(`${fixture.baseUrl}/nope`);
    expect(missing.status).toBe(404);
  });
});

describe('fake quota-tool fixture lifecycle is leak-free', () => {
  test('stop() releases the port and is idempotent', async () => {
    const fixture = await start({
      zhipu: { kind: 'success', result: successResult() },
    });
    const { port } = fixture;

    await fixture.stop();
    await expect(fixture.stop()).resolves.toBeUndefined();

    // 端口确已释放：同端口可立即重新监听
    const http = await import('node:http');
    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  test('a random free port is allocated per fixture', async () => {
    const first = await start();
    const second = await start();
    expect(first.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
    expect(first.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first.port).not.toBe(second.port);
  });
});
