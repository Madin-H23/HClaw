import { describe, expect, test } from 'vitest';

import {
  DEFAULT_TIER_THRESHOLDS,
  QUOTA_TIERS,
  detectSignalKind,
  normalizeQuotaTier,
  tierOf,
} from '../src/quota-router/tiers.js';
import type {
  QuotaSummaryItem,
  QuotaWindow,
  TierThresholdTable,
} from '../src/quota-router/tiers.js';

// 档位归一化：三类异构信号（绝对剩余/整数百分比/美元余额）入四档 + 阈值边界。
// 阈值缺省表（DEFAULT_TIER_THRESHOLDS）与 T2 基座确定性样本
// （tests/quota-router-stubs/fake-snapshot.ts 的 TIER_SAMPLE_*）逐档吻合；
// 窗口/汇总夹具逐字段对齐统一契约七字段形态（同 fake-quota-tool 桩的类型）。

function absoluteWindow(
  remainingPct: number,
  overrides?: Partial<QuotaWindow>,
): QuotaWindow {
  const total = 500_000;
  const used = Math.round((total * (100 - remainingPct)) / 100);
  return {
    label: '5h Rolling',
    total,
    used,
    remaining: total - used,
    percentage: 100 - remainingPct,
    resetAt: '2026-09-11T13:00:00Z',
    unit: 'AFP',
    ...overrides,
  };
}

function percentageWindow(remainingPct: number): QuotaWindow {
  const used = 100 - remainingPct;
  return {
    label: '5h Rolling',
    total: 100,
    used,
    remaining: remainingPct,
    percentage: used,
    resetAt: '2026-09-11T13:00:00Z',
    unit: '%',
  };
}

function currencySummary(balance: number): QuotaSummaryItem[] {
  return [{ label: 'USD 总余额', value: balance }];
}

describe('default thresholds reproduce the T2 tier samples on every signal kind', () => {
  // TIER_SAMPLE_USED_PERCENTAGE: plenty 10 / tight 75 / critical 96 / exhausted 100
  // TIER_SAMPLE_USD_BALANCE:     plenty 100 / tight 15 / critical 3 / exhausted 0
  const usedCases = [
    [10, 'plenty'],
    [75, 'tight'],
    [96, 'critical'],
    [100, 'exhausted'],
  ] as const;
  const usdCases = [
    [100, 'plenty'],
    [15, 'tight'],
    [3, 'critical'],
    [0, 'exhausted'],
  ] as const;

  for (const [used, tier] of usedCases) {
    test(`absolute signal: used ${used}% → ${tier}`, () => {
      expect(
        normalizeQuotaTier({
          windows: [absoluteWindow(100 - used)],
          summary: [],
        })?.tier,
      ).toBe(tier);
    });

    test(`percentage signal: used ${used}% → ${tier}`, () => {
      expect(
        normalizeQuotaTier({
          windows: [percentageWindow(100 - used)],
          summary: [],
        })?.tier,
      ).toBe(tier);
    });
  }

  for (const [balance, tier] of usdCases) {
    test(`currency signal: $${balance} → ${tier}`, () => {
      expect(
        normalizeQuotaTier(
          { windows: [], summary: currencySummary(balance) },
          DEFAULT_TIER_THRESHOLDS,
          'currency',
        )?.tier,
      ).toBe(tier);
    });
  }
});

describe('threshold boundaries (score ≤ threshold takes the tighter tier)', () => {
  const table: TierThresholdTable = {
    absolute: { tight: 25, critical: 10, exhausted: 0 },
    percentage: { tight: 30, critical: 15, exhausted: 0 },
    currency: { tight: 20, critical: 5, exhausted: 0 },
  };

  test('percentage: remaining 30 sits exactly on tight → tight, 31 → plenty', () => {
    expect(
      normalizeQuotaTier(
        { windows: [percentageWindow(30)], summary: [] },
        table,
        'percentage',
      )?.tier,
    ).toBe('tight');
    expect(
      normalizeQuotaTier(
        { windows: [percentageWindow(31)], summary: [] },
        table,
        'percentage',
      )?.tier,
    ).toBe('plenty');
  });

  test('absolute: remaining ratio 10 sits exactly on critical → critical, 10.01 → tight', () => {
    expect(
      normalizeQuotaTier(
        { windows: [absoluteWindow(10)], summary: [] },
        table,
        'absolute',
      )?.tier,
    ).toBe('critical');
    expect(
      normalizeQuotaTier(
        { windows: [absoluteWindow(10.01)], summary: [] },
        table,
        'absolute',
      )?.tier,
    ).toBe('tight');
  });

  test('currency: balance 5 sits exactly on critical → critical', () => {
    expect(
      normalizeQuotaTier(
        { windows: [], summary: currencySummary(5) },
        table,
        'currency',
      )?.tier,
    ).toBe('critical');
  });

  test('tierOf is directly testable against the exhausted boundary', () => {
    const th = { tight: 25, critical: 10, exhausted: 0 };
    expect(tierOf(0, th)).toBe('exhausted');
    expect(tierOf(-3, th)).toBe('exhausted');
    expect(tierOf(0.5, th)).toBe('critical');
    expect(tierOf(24.9, th)).toBe('tight');
  });
});

describe('heterogeneous payload shapes from the real providers', () => {
  test('volcano multi-window: the tightest window governs (5h exhausted beats monthly plenty)', () => {
    const result = normalizeQuotaTier(
      {
        windows: [
          absoluteWindow(90, { label: 'Monthly' }),
          absoluteWindow(0, { label: '5h Rolling' }),
        ],
        summary: [{ label: '套餐', value: 'Agent Plan' }],
      },
      DEFAULT_TIER_THRESHOLDS,
      'absolute',
    );
    expect(result?.tier).toBe('exhausted');
    expect(result?.signalKind).toBe('absolute');
    expect(result?.score).toBe(0);
  });

  test('absolute window without total falls back to 100 - percentage', () => {
    const result = normalizeQuotaTier(
      {
        windows: [
          {
            label: '5h Rolling',
            total: null,
            used: null,
            remaining: null,
            percentage: 96,
            resetAt: null,
            unit: '%',
          },
        ],
        summary: [],
      },
      DEFAULT_TIER_THRESHOLDS,
      'absolute',
    );
    expect(result?.tier).toBe('critical');
    expect(result?.score).toBe(4);
  });

  test('DeepSeek balance-only payload: windows empty, summary carries the number', () => {
    const result = normalizeQuotaTier({
      windows: [],
      summary: currencySummary(15),
    });
    expect(result).toEqual({
      tier: 'tight',
      signalKind: 'currency',
      score: 15,
    });
  });

  test('negative balance clamps to exhausted', () => {
    expect(
      normalizeQuotaTier(
        { windows: [], summary: currencySummary(-1.5) },
        DEFAULT_TIER_THRESHOLDS,
        'currency',
      )?.tier,
    ).toBe('exhausted');
  });
});

describe('auto-detection from the unified contract', () => {
  test("unit '%' → percentage", () => {
    expect(
      detectSignalKind({ windows: [percentageWindow(50)], summary: [] }),
    ).toBe('percentage');
  });

  test('numeric total → absolute', () => {
    expect(
      detectSignalKind({ windows: [absoluteWindow(50)], summary: [] }),
    ).toBe('absolute');
  });

  test('numeric summary only → currency', () => {
    expect(detectSignalKind({ windows: [], summary: currencySummary(9) })).toBe(
      'currency',
    );
  });

  test('nothing recognizable → detection fails and normalization returns null (missing, fail-open)', () => {
    expect(
      detectSignalKind({
        windows: [],
        summary: [{ label: '套餐', value: 'Agent Plan' }],
      }),
    ).toBeNull();
    expect(
      normalizeQuotaTier({
        windows: [],
        summary: [{ label: '套餐', value: 'Agent Plan' }],
      }),
    ).toBeNull();
  });

  test('explicit signal overrides auto-detection', () => {
    // unit '%' 窗口但强制按 absolute 读：total=100 具数 → remaining/total*100
    const result = normalizeQuotaTier(
      { windows: [percentageWindow(30)], summary: [] },
      DEFAULT_TIER_THRESHOLDS,
      'absolute',
    );
    expect(result?.signalKind).toBe('absolute');
    expect(result?.score).toBe(30);
  });
});

describe('four-tier scale is the single shared vocabulary', () => {
  test('QUOTA_TIERS order matches the CONTEXT.md scale', () => {
    expect([...QUOTA_TIERS]).toEqual([
      'plenty',
      'tight',
      'critical',
      'exhausted',
    ]);
  });
});
