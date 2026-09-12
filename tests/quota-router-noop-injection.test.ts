import { describe, expect, test, vi } from 'vitest';

import { ProviderPool } from '../src/provider-pool.js';
import {
  noopQuotaRoutingPolicy,
  type QuotaRoutingPolicy,
} from '../src/quota-router/index.js';

// 参照上游选路算法语义（tests/provider-pool-recovery.test.ts 及
// provider-pool.ts 的三策略实现），证明 quota-router no-op 注入
// 前后选路行为一致：同输入下选中结果逐一相同。

type MemberSpec = { id: string; enabled?: boolean; weight?: number };

function makePool(
  members: MemberSpec[],
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover' = 'round-robin',
): ProviderPool {
  const pool = new ProviderPool();
  pool.refreshFromConfig(
    members.map((m) => ({
      id: m.id,
      enabled: m.enabled ?? true,
      weight: m.weight ?? 1,
    })),
    { strategy, unhealthyThreshold: 3, recoveryIntervalMs: 300_000 },
  );
  return pool;
}

function selectSequence(pool: ProviderPool, times: number): string[] {
  return Array.from({ length: times }, () => pool.selectProvider());
}

function markUnhealthy(pool: ProviderPool, profileId: string): void {
  for (let i = 0; i < 3; i += 1) pool.reportFailure(profileId);
}

describe('quota-router no-op injection keeps upstream selection behavior', () => {
  test('round-robin cycles identically to the upstream algorithm', () => {
    const pool = makePool(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      'round-robin',
    );
    expect(selectSequence(pool, 5)).toEqual(['a', 'b', 'c', 'a', 'b']);
  });

  test('weighted-round-robin honors weights identically to the upstream algorithm', () => {
    const pool = makePool(
      [
        { id: 'a', weight: 1 },
        { id: 'b', weight: 3 },
      ],
      'weighted-round-robin',
    );
    expect(selectSequence(pool, 5)).toEqual(['a', 'b', 'b', 'b', 'a']);
  });

  test('failover picks the first candidate identically to the upstream algorithm', () => {
    const pool = makePool([{ id: 'a' }, { id: 'b' }], 'failover');
    expect(selectSequence(pool, 3)).toEqual(['a', 'a', 'a']);
  });

  test('disabled members and unhealthy providers stay filtered out', () => {
    const pool = makePool([
      { id: 'a', enabled: false },
      { id: 'b' },
      { id: 'c' },
    ]);
    markUnhealthy(pool, 'c');
    expect(selectSequence(pool, 3)).toEqual(['b', 'b', 'b']);
  });

  test('all-unhealthy fallback returns the first enabled member', () => {
    const pool = makePool([{ id: 'a' }, { id: 'b' }], 'failover');
    markUnhealthy(pool, 'a');
    markUnhealthy(pool, 'b');
    expect(pool.selectProvider()).toBe('a');
  });

  test('empty pool still throws the upstream error', () => {
    const pool = makePool([]);
    expect(() => pool.selectProvider()).toThrowError(
      'Provider pool has no members configured',
    );
  });

  test('recovery-aware selection stays intact under the no-op policy', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-24T10:00:00.000Z'));
      const pool = makePool([{ id: 'qwen' }, { id: 'glm' }], 'failover');
      pool.reportFailure('qwen', true);
      expect(pool.selectProvider()).toBe('glm');

      vi.advanceTimersByTime(300_000);
      pool.refreshRecoveryState();
      expect(pool.selectProvider()).toBe('qwen');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('explicit no-op injection is indistinguishable from the default', () => {
  test('same inputs produce identical selections before and after injection', () => {
    for (const strategy of [
      'round-robin',
      'weighted-round-robin',
      'failover',
    ] as const) {
      const members: MemberSpec[] = [
        { id: 'alpha' },
        { id: 'beta', enabled: false },
        { id: 'gamma', weight: 3 },
        { id: 'delta' },
      ];
      const before = makePool(members, strategy);
      const after = makePool(members, strategy);
      after.setQuotaRoutingPolicy(noopQuotaRoutingPolicy);

      const beforeSequence = selectSequence(before, 6);
      const afterSequence = selectSequence(after, 6);
      expect(afterSequence).toEqual(beforeSequence);
      // 轮询类策略下序列非平凡（不能全靠单一候选蒙混过关）；failover 恒选首个
      if (strategy !== 'failover') {
        expect(new Set(beforeSequence).size).toBeGreaterThan(1);
      }
    }
  });
});

describe('the injected policy sits on the real selection path', () => {
  test('a filtering policy changes the selection accordingly', () => {
    const dropAlpha: QuotaRoutingPolicy = (context) => ({
      candidates: context.candidates.filter((m) => m.profileId !== 'alpha'),
    });
    const pool = makePool([{ id: 'alpha' }, { id: 'beta' }], 'failover');
    pool.setQuotaRoutingPolicy(dropAlpha);
    expect(pool.selectProvider()).toBe('beta');
  });

  test('the policy receives the upstream strategy and healthy candidates', () => {
    let seen: { strategy: string; ids: string[] } | null = null;
    const capture: QuotaRoutingPolicy = (context) => {
      seen = {
        strategy: context.strategy,
        ids: context.candidates.map((m) => m.profileId),
      };
      return { candidates: context.candidates };
    };
    const pool = makePool(
      [{ id: 'alpha', enabled: false }, { id: 'beta' }],
      'failover',
    );
    pool.setQuotaRoutingPolicy(capture);
    pool.selectProvider();
    expect(seen).toEqual({ strategy: 'failover', ids: ['beta'] });
  });
});

describe('noopQuotaRoutingPolicy', () => {
  test('passes candidates through by reference without mutation', () => {
    const candidates = [{ profileId: 'a', weight: 1, enabled: true }];
    const decision = noopQuotaRoutingPolicy({
      strategy: 'round-robin',
      candidates,
    });
    expect(decision.candidates).toBe(candidates);
    expect(candidates).toHaveLength(1);
  });
});
