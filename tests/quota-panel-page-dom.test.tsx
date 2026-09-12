// @vitest-environment happy-dom

/**
 * T7-A：额度面板页组件渲染测试（QuotaPage，mock 取数端点）
 *
 * 外部行为断言（SPEC 渲染面验收口径）：四档徽标齐全、原始信号按 signalKind
 * 呈现、数据时间（相对展示 + 绝对 title）、未配置/无快照降级文案、陈旧标注、
 * 加载失败 toast——面板绝不空白报错。
 *
 * U1 追加：顶部汇总行（总数/四档计数/最紧点名与降级形态）、炉心温度计表盘
 * （弧长-剩余比映射数学钉死、四档色阶 token 表、虚线环/美元余额形态）、
 * 窗口折叠（默认最紧一窗，展开/收起）。
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

const {
  QuotaPage,
  gaugeArc,
  pickTightestWindowIndex,
  summarizeTiers,
  TIER_GAUGE_COLOR,
} = await import('../web/src/pages/QuotaPage');

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
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
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
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(container!.textContent).toContain('智谱 GLM');
  });
});

/**
 * 多窗口行夹具（U1 折叠测试用）：三窗口绝对信号，剩余占比 80/45/30 →
 * 最紧为「月度包」（第三窗），score=30 与档位 plenty 自洽（阈值 25）。
 */
function multiWindowRow(overrides: Record<string, unknown> = {}) {
  return rowFixture({
    providerId: 'minimax-ab',
    displayName: 'MiniMax AB',
    tier: 'plenty',
    tierLabel: '充足',
    signalKind: 'absolute',
    score: 30,
    windows: [
      {
        label: '5h 窗口',
        total: 300_000,
        used: 60_000,
        remaining: 240_000,
        percentage: 20,
        resetAt: null,
        unit: ' tokens',
      },
      {
        label: '周窗口',
        total: 2_000_000,
        used: 1_100_000,
        remaining: 900_000,
        percentage: 55,
        resetAt: null,
        unit: ' tokens',
      },
      {
        label: '月度包',
        total: 10_000_000,
        used: 7_000_000,
        remaining: 3_000_000,
        percentage: 70,
        resetAt: null,
        unit: ' tokens',
      },
    ],
    ...overrides,
  });
}

async function clickToggle(): Promise<void> {
  const toggle = container!.querySelector<HTMLElement>(
    '[data-testid="quota-windows-toggle"]',
  );
  expect(toggle).not.toBeNull();
  await act(async () => {
    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

describe('U1 汇总行 / 炉心温度计表盘 / 窗口折叠', () => {
  test('汇总行：供应商总数 + 四档色点计数 + 最紧供应商点名', async () => {
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
        multiWindowRow(),
      ],
    });
    await renderPanel();
    const summary = container!.querySelector('[data-testid="quota-summary"]');
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain('6 家供应商');
    expect(
      summary!.querySelector('[data-testid="quota-summary-tier-plenty"]')
        ?.textContent,
    ).toContain('3');
    expect(
      summary!.querySelector('[data-testid="quota-summary-tier-tight"]')
        ?.textContent,
    ).toContain('1');
    expect(
      summary!.querySelector('[data-testid="quota-summary-tier-critical"]')
        ?.textContent,
    ).toContain('1');
    expect(
      summary!.querySelector('[data-testid="quota-summary-tier-exhausted"]')
        ?.textContent,
    ).toContain('1');
    // 最紧点名：剩余分最小的火山方舟（0%）
    expect(
      summary!.querySelector('[data-testid="quota-summary-tightest"]')
        ?.textContent,
    ).toContain('火山方舟');
    expect(
      summary!.querySelector('[data-testid="quota-summary-tightest"]')
        ?.textContent,
    ).toContain('0%');
  });

  test('汇总行降级：全无档位 → 「暂无档位数据」；未配置 → 静默形态；空池不渲染汇总行', async () => {
    const noSnapshot = {
      tier: null,
      tierLabel: null,
      signalKind: null,
      score: null,
      fetchedAt: null,
      storedAt: null,
      ageMs: null,
      windows: [],
      summary: [],
    };
    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: true,
      snapshotTtlMs: 300_000,
      providers: [
        rowFixture({ ...noSnapshot }),
        rowFixture({ providerId: 'b', displayName: '乙', ...noSnapshot }),
      ],
    });
    await renderPanel();
    let summary = container!.querySelector('[data-testid="quota-summary"]');
    expect(summary!.textContent).toContain('2 家供应商');
    expect(summary!.textContent).toContain('暂无档位数据');

    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: false,
      snapshotTtlMs: 300_000,
      providers: [
        rowFixture({ mapped: false, ...noSnapshot }),
        rowFixture({
          providerId: 'b',
          displayName: '乙',
          mapped: false,
          ...noSnapshot,
        }),
      ],
    });
    await renderPanel();
    summary = container!.querySelector('[data-testid="quota-summary"]');
    expect(summary!.textContent).toContain('尚未配置额度源映射');

    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: true,
      snapshotTtlMs: 300_000,
      providers: [],
    });
    await renderPanel();
    expect(
      container!.querySelector('[data-testid="quota-summary"]'),
    ).toBeNull();
    expect(container!.textContent).toContain('供应商池为空');
  });

  test('表盘弧长-剩余比映射（数学钉死）+ 四档色阶 token 表', async () => {
    // 周长 = 2π×30 = 188.4956；弧长 = 比值×周长，夹取 [0,1]
    expect(gaugeArc(0.68)).toBe('128.1770 188.4956');
    expect(gaugeArc(0.08)).toBe('15.0796 188.4956');
    expect(gaugeArc(0)).toBe('0.0000 188.4956');
    expect(gaugeArc(1)).toBe('188.4956 188.4956');
    expect(gaugeArc(1.5)).toBe(gaugeArc(1));
    expect(gaugeArc(-0.1)).toBe(gaugeArc(0));
    // 四档色阶只从 globals.css tokens 取值（临界 = warning/error 派生深 warning）
    expect(TIER_GAUGE_COLOR.plenty).toBe('var(--success)');
    expect(TIER_GAUGE_COLOR.tight).toBe('var(--warning)');
    expect(TIER_GAUGE_COLOR.critical).toBe(
      'color-mix(in srgb, var(--warning) 45%, var(--error))',
    );
    expect(TIER_GAUGE_COLOR.exhausted).toBe('var(--error)');

    // DOM 弧长与剩余比逐卡吻合；弧色随档位 token
    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: true,
      snapshotTtlMs: 300_000,
      providers: [
        rowFixture(), // percentage 68 → 0.68
        rowFixture({
          providerId: 'bailian-qwen',
          displayName: '百炼千问',
          tier: 'critical',
          tierLabel: '临界',
          signalKind: 'absolute',
          score: 8, // → 0.08
        }),
        rowFixture({
          providerId: 'volcano-afp',
          displayName: '火山方舟',
          tier: 'exhausted',
          tierLabel: '耗尽',
          signalKind: 'absolute',
          score: 0, // 剩余比 0 → 不渲染前弧
        }),
      ],
    });
    await renderPanel();
    const arcStyle = (id: string) =>
      container!
        .querySelector<SVGCircleElement>(
          `[data-testid="quota-card-${id}"] [data-testid="quota-gauge-arc"]`,
        )!
        .getAttribute('style');
    // 弧长/弧色走 style（CSS 属性，可过渡）：dasharray=比值×周长，色=档位 token
    expect(arcStyle('zhipu-glm')).toContain(
      'stroke-dasharray: 128.1770 188.4956',
    );
    expect(arcStyle('zhipu-glm')).toContain('stroke: var(--success)');
    expect(arcStyle('bailian-qwen')).toContain(
      'stroke-dasharray: 15.0796 188.4956',
    );
    expect(arcStyle('bailian-qwen')).toContain(
      'stroke: color-mix(in srgb, var(--warning) 45%, var(--error))',
    );
    // 耗尽（比值 0）无前弧，避免 0 长度圆头线帽画出假圆点
    expect(
      container!.querySelector(
        '[data-testid="quota-card-volcano-afp"] [data-testid="quota-gauge-arc"]',
      ),
    ).toBeNull();
    // 数字过渡：弧长/色阶 200ms CSS transition（reduced-motion 由全局样式降级）
    expect(arcStyle('zhipu-glm')).toContain('stroke-dasharray 200ms');
  });

  test('表盘降级形态：未映射/无快照 → 虚线灰环 + 「—」；美元余额 → 不画弧 + 中心余额', async () => {
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
          providerId: 'deepseek-chat',
          displayName: 'DeepSeek',
          signalKind: 'currency',
          score: 12.5,
          windows: [],
          summary: [{ label: '总余额', value: 12.5 }],
        }),
      ],
    });
    await renderPanel();
    const trackOf = (id: string) =>
      container!.querySelector<SVGCircleElement>(
        `[data-testid="quota-card-${id}"] [data-testid="quota-gauge-track"]`,
      );
    const valueOf = (id: string) =>
      container!.querySelector<SVGTextElement>(
        `[data-testid="quota-card-${id}"] [data-testid="quota-gauge-value"]`,
      );
    // 未映射：虚线轨道 + 「—」 + 无前弧
    expect(trackOf('zhipu-glm')!.getAttribute('stroke-dasharray')).toBe('3 4');
    expect(valueOf('zhipu-glm')!.textContent).toBe('—');
    expect(
      container!.querySelector(
        '[data-testid="quota-card-zhipu-glm"] [data-testid="quota-gauge-arc"]',
      ),
    ).toBeNull();
    // 美元余额：无比率不画弧，中心展示余额本身
    expect(
      container!.querySelector(
        '[data-testid="quota-card-deepseek-chat"] [data-testid="quota-gauge-arc"]',
      ),
    ).toBeNull();
    expect(
      trackOf('deepseek-chat')!.getAttribute('stroke-dasharray'),
    ).toBeNull();
    expect(valueOf('deepseek-chat')!.textContent).toBe('$12.5');
  });

  test('窗口折叠：默认只展示最紧一窗，展开/收起可切换；单窗口无开关', async () => {
    mocks.fetchQuotaPanel.mockResolvedValue({
      configured: true,
      snapshotTtlMs: 300_000,
      providers: [rowFixture(), multiWindowRow()],
    });
    await renderPanel();
    const card = () =>
      container!.querySelector('[data-testid="quota-card-minimax-ab"]')!;
    // 默认折叠：只展示最紧的「月度包」（30%），其余两窗不可见
    expect(card().textContent).toContain('月度包：剩 3000000/10000000 tokens');
    expect(card().textContent).toContain('（最紧）');
    expect(card().textContent).not.toContain('5h 窗口');
    expect(card().textContent).not.toContain('周窗口');
    const toggle = card().querySelector<HTMLElement>(
      '[data-testid="quota-windows-toggle"]',
    );
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    expect(toggle!.textContent).toContain('展开其余 2 窗');
    // 单窗口供应商不出现开关
    expect(
      container!.querySelector(
        '[data-testid="quota-card-zhipu-glm"] [data-testid="quota-windows-toggle"]',
      ),
    ).toBeNull();
    // 展开：三窗齐全；再点收起
    await clickToggle();
    expect(card().textContent).toContain('5h 窗口');
    expect(card().textContent).toContain('周窗口');
    expect(card().textContent).toContain('月度包');
    expect(
      card()
        .querySelector('[data-testid="quota-windows-toggle"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      card().querySelector('[data-testid="quota-windows-toggle"]')!.textContent,
    ).toContain('收起窗口明细');
    await clickToggle();
    expect(card().textContent).not.toContain('5h 窗口');
    expect(
      card()
        .querySelector('[data-testid="quota-windows-toggle"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('最紧窗口裁决与汇总统计（纯函数钉死）', () => {
    type Win = {
      label: string;
      total: number | null;
      used: number | null;
      remaining: number | null;
      percentage: number | null;
      unit: string;
    };
    const win = (p: Partial<Win>): Win => ({
      label: 'w',
      total: null,
      used: null,
      remaining: null,
      percentage: null,
      unit: '%',
      ...p,
    });
    // 绝对窗口：剩余占比 80/45/30 → 最紧为第三窗
    expect(
      pickTightestWindowIndex(multiWindowRow().windows as Win[], 'absolute'),
    ).toBe(2);
    // 百分比窗口：已用 20/55 → 剩余 80/45 → 最紧为第二窗
    expect(
      pickTightestWindowIndex(
        [win({ percentage: 20 }), win({ percentage: 55 })],
        'percentage',
      ),
    ).toBe(1);
    // 均不可折算 → 回退首窗
    expect(pickTightestWindowIndex([win({ label: 'x' })], null)).toBe(0);
    // 汇总统计：同分并列取先出现者；未知档位不入四档计数
    const a = rowFixture({ score: 10 });
    const b = rowFixture({ providerId: 'b', displayName: '乙', score: 10 });
    const unknown = rowFixture({
      providerId: 'c',
      displayName: '丙',
      tier: null,
      tierLabel: null,
      score: null,
    });
    const stats = summarizeTiers([a, b, unknown]);
    expect(stats.total).toBe(3);
    expect(stats.counts.plenty).toBe(2);
    expect(stats.tightest).toBe(a);
  });
});
