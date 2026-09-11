import { describe, expect, test } from 'vitest';

import {
  isMissingModelPrice,
  isMissingProviderSpentCost,
  isMissingSnapshot,
  isMissingUserBalance,
  type RoutingQuotaInputs,
  type StoredQuotaSnapshot,
} from '../src/quota-router/routing-inputs.js';
import * as routingInputsModule from '../src/quota-router/routing-inputs.js';
import { isMissingSnapshot as sourceIsMissingSnapshot } from '../src/quota-router/snapshot-store.js';
import { isMissingModelPrice as costIsMissingModelPrice } from '../src/quota-router/cc-switch-cost-source.js';
import { isMissingUserBalance as billingIsMissingUserBalance } from '../src/quota-router/billing-balance-source.js';

// 三源统一输入类型（T4）：单点定义、单点转出——T5 决策层唯一 import 点。
// 本测试证明：全 present / 全 missing 两种形态可构造、守卫可判定、
// 转出口与各源模块导出是同一实现（禁止手抄第二份的契约化证据）。

function snapshot(
  overrides?: Partial<StoredQuotaSnapshot>,
): StoredQuotaSnapshot {
  return {
    providerId: 'volcano-profile',
    tier: 'tight',
    signalKind: 'absolute',
    score: 25,
    fetchedAt: '2026-09-11T08:00:00Z',
    storedAt: '2026-09-11T08:00:01Z',
    windows: [
      {
        label: '5h Rolling',
        total: 500_000,
        used: 375_000,
        remaining: 125_000,
        percentage: 75,
        resetAt: '2026-09-11T13:00:00Z',
        unit: 'AFP',
      },
    ],
    summary: [],
    ...overrides,
  };
}

function fullyPresentInputs(): RoutingQuotaInputs {
  const snap = snapshot();
  return {
    providerId: 'volcano-profile',
    snapshot: snap,
    modelPrice: {
      modelId: 'test-model-a',
      displayName: 'Test Model A',
      inputCostPerMillion: 5,
      outputCostPerMillion: 25,
      cacheReadCostPerMillion: 0.5,
      cacheCreationCostPerMillion: 6.25,
    },
    spentCost: {
      providerId: 'vendor-uuid-1',
      totalCostUsd: 0.6,
      requestCount: 9,
      firstDate: '2026-09-02',
      lastDate: '2026-09-10',
      windowDays: null,
    },
    userBalance: {
      user_id: 'user-alice',
      balance_usd: 12.5,
      total_deposited_usd: 20,
      total_consumed_usd: 7.5,
      updated_at: '2026-09-11T00:00:00Z',
    },
  };
}

function fullyMissingInputs(): RoutingQuotaInputs {
  return {
    providerId: 'volcano-profile',
    snapshot: { providerId: 'volcano-profile', missing: true },
    modelPrice: { modelId: 'test-model-a', missing: true },
    spentCost: { providerId: 'vendor-uuid-1', missing: true },
    userBalance: { userId: 'user-alice', missing: true },
  };
}

describe('routing quota inputs (three sources, unified shape)', () => {
  test('fully present inputs compose from all three sources, values untouched', () => {
    const inputs = fullyPresentInputs();
    // 各源数据原样进槽位（不复制不重组——T5 拿到的就是各适配器的产出）
    expect(isMissingSnapshot(inputs.snapshot)).toBe(false);
    expect(isMissingModelPrice(inputs.modelPrice)).toBe(false);
    expect(isMissingProviderSpentCost(inputs.spentCost)).toBe(false);
    expect(isMissingUserBalance(inputs.userBalance)).toBe(false);
    if (!isMissingSnapshot(inputs.snapshot)) {
      expect(inputs.snapshot.tier).toBe('tight');
      expect(inputs.snapshot.windows).toHaveLength(1);
    }
    if (!isMissingUserBalance(inputs.userBalance)) {
      expect(inputs.userBalance.balance_usd).toBe(12.5);
    }
  });

  test('fully missing inputs degrade explicitly per source (fail-open material)', () => {
    const inputs = fullyMissingInputs();
    expect(isMissingSnapshot(inputs.snapshot)).toBe(true);
    expect(isMissingModelPrice(inputs.modelPrice)).toBe(true);
    expect(isMissingProviderSpentCost(inputs.spentCost)).toBe(true);
    expect(isMissingUserBalance(inputs.userBalance)).toBe(true);
  });

  test('guards re-exported from the single point are the source implementations', () => {
    // 单点转出契约：routing-inputs 的守卫与各源模块导出同一引用，不是手抄副本
    expect(routingInputsModule.isMissingSnapshot).toBe(sourceIsMissingSnapshot);
    expect(routingInputsModule.isMissingModelPrice).toBe(
      costIsMissingModelPrice,
    );
    expect(routingInputsModule.isMissingUserBalance).toBe(
      billingIsMissingUserBalance,
    );
  });
});
