// @vitest-environment happy-dom

/**
 * T7-A：额度面板页组件渲染测试（QuotaPage，mock 取数端点）
 *
 * 外部行为断言（SPEC 渲染面验收口径）：四档徽标齐全、原始信号按 signalKind
 * 呈现、数据时间（相对展示 + 绝对 title）、未配置/无快照降级文案、陈旧标注、
 * 加载失败 toast——面板绝不空白报错。
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  fetchQuotaPanel: vi.fn(),
}));

vi.mock('../web/src/api/quota', () => ({
  fetchQuotaPanel: mocks.fetchQuotaPanel,
}));

const { QuotaPage } = await import('../web/src/pages/QuotaPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function rowFixture(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'zhipu-glm',
    displayName: '智谱 GLM',
    enabled: true,
    mapped: true,
    tier: 'plenty',
    tierLabel: '充足',
    signalKind: 'percentage',
    score: 68,
    fetchedAt: '2026-09-11T04:00:00.000Z',
    storedAt: '2026-09-11T04:00:05.000Z',
    stale: false,
    ageMs: 3 * 60_000,
    windows: [
      {
        label: '5h 窗口',
        total: 100,
        used: 32,
        remaining: 68,
        percentage: 32,
        resetAt: null,
        unit: '%',
      },
    ],
    summary: [],
    ...overrides,
  };
}

async function renderPanel(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<QuotaPage />);
  });
  // 两拍 flush：mount 后的异步取数（resolve/reject）与随后的 setState
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('额度面板渲染', () => {
  test('四档档位徽标与原始信号值（百分比/绝对/美元）齐备', async () => {
    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: true,
      snapshotTtlMs: 300_000,
      providers: [
        rowFixture(),
        rowFixture({
          providerId: 'opencode-go',
          displayName: 'OpenCode Go',
          tier: 'tight',
          tierLabel: '紧张',
          score: 18,
          ageMs: 4 * 60_000,
        }),
        rowFixture({
          providerId: 'bailian-qwen',
          displayName: '百炼千问',
          tier: 'critical',
          tierLabel: '临界',
          signalKind: 'absolute',
          score: 8,
          ageMs: 2 * 60_000,
        }),
        rowFixture({
          providerId: 'volcano-afp',
          displayName: '火山方舟',
          tier: 'exhausted',
          tierLabel: '耗尽',
          signalKind: 'absolute',
          score: 0,
          ageMs: 6 * 60_000,
        }),
        rowFixture({
          providerId: 'deepseek-chat',
          displayName: 'DeepSeek',
          tier: 'plenty',
          tierLabel: '充足',
          signalKind: 'currency',
          score: 12.5,
          ageMs: 60_000,
          windows: [],
          summary: [{ label: '总余额', value: 12.5 }],
        }),
      ],
    });
    await renderPanel();
    const text = container!.textContent ?? '';
    for (const label of ['充足', '紧张', '临界', '耗尽']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('智谱 GLM');
    expect(text).toContain('剩余 68%');
    expect(text).toContain('$12.5');
    // 数据时间：相对展示 + 绝对时间 title
    const timeEl = container!.querySelector<HTMLElement>('[title^="2026"]');
    expect(timeEl?.getAttribute('title')).toContain('2026');
    expect(timeEl?.textContent).toContain('数据时间：');
    // 无「未配置」横幅
    expect(
      container!.querySelector('[data-testid="quota-unconfigured"]'),
    ).toBeNull();
  });

  test('映射缺失 → 「未配置额度源」；无快照 → 「暂无额度数据」降级文案', async () => {
    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: true,
      snapshotTtlMs: 300_000,
      providers: [
        rowFixture({
          mapped: false,
          tier: null,
          tierLabel: null,
          signalKind: null,
          score: null,
          fetchedAt: null,
          storedAt: null,
          ageMs: null,
          windows: [],
        }),
        rowFixture({
          providerId: 'grok-beta',
          displayName: 'grok-beta',
          mapped: true,
          tier: null,
          tierLabel: null,
          signalKind: null,
          score: null,
          fetchedAt: null,
          ageMs: null,
          windows: [],
        }),
      ],
    });
    await renderPanel();
    expect(container!.textContent).toContain('未配置额度源');
    expect(container!.textContent).toContain('暂无额度数据');
    expect(container!.textContent).toContain('档位未知');
  });

  test('陈旧数据 → 「数据已过期」标注', async () => {
    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: true,
      snapshotTtlMs: 60_000,
      providers: [rowFixture({ stale: true, ageMs: 47 * 60_000 })],
    });
    await renderPanel();
    expect(container!.textContent).toContain('数据已过期');
    expect(container!.textContent).toContain('47 分钟前');
  });

  test('未配置任何映射 → 全局横幅提示', async () => {
    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: false,
      snapshotTtlMs: 300_000,
      providers: [
        rowFixture({
          mapped: false,
          tier: null,
          tierLabel: null,
          signalKind: null,
          score: null,
          fetchedAt: null,
          ageMs: null,
          windows: [],
        }),
      ],
    });
    await renderPanel();
    expect(
      container!.querySelector('[data-testid="quota-unconfigured"]'),
    ).not.toBeNull();
    expect(container!.textContent).toContain('尚未配置任何供应商额度源映射');
  });

  test('取数失败 → 明示加载失败与重试入口；重试成功后面板恢复', async () => {
    mocks.fetchQuotaPanel.mockImplementation(() =>
      Promise.reject(new Error('boom')),
    );
    await renderPanel();
    expect(container!.textContent).toContain('额度面板加载失败');
    const retry = container!.querySelector<HTMLButtonElement>(
      '[data-testid="quota-retry"]',
    );
    expect(retry?.textContent).toContain('重试');
    // 重试 → 成功取数 → 面板内容渲染
    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: true,
      snapshotTtlMs: 300_000,
      providers: [rowFixture()],
    });
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container!.textContent).toContain('智谱 GLM');
  });
});
