import { describe, expect, test } from 'vitest';

import { ProviderPool } from '../src/provider-pool.js';

import {
  createScriptedProviderPool,
  TIER_RANK,
} from './quota-router-stubs/fake-provider-pool.js';

// 假供应商池桩自检：桩驱动的是真实 ProviderPool（经 T1 setQuotaRoutingPolicy
// 缝注入脚本策略），选中结果确定性可断言；行为断言只看外部可见结果
// （选中谁、决策候选剩谁），不断言内部调用次数。

describe('the scripted pool drives the real upstream selection loop', () => {
  test('the fixture wraps a genuine ProviderPool instance', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'a' }, { id: 'b' }],
      strategy: 'failover',
    });
    expect(scripted.pool).toBeInstanceOf(ProviderPool);
    expect(scripted.pool.getEnabledCount()).toBe(2);
  });

  test('upstream empty-pool and all-unhealthy semantics stay intact', () => {
    expect(() =>
      createScriptedProviderPool({ members: [] }).select(),
    ).toThrowError('Provider pool has no members configured');
  });
});

describe('scripted tiers produce deterministic veto and selection', () => {
  test('an exhausted candidate is vetoed and the survivor is selected', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'glm' }, { id: 'deepseek' }],
      strategy: 'failover',
      tiers: { glm: 'exhausted', deepseek: 'plenty' },
    });
    expect(scripted.select()).toBe('deepseek');
    expect(scripted.selections[0]).toEqual({
      selected: 'deepseek',
      strategy: 'failover',
      contextCandidateIds: ['glm', 'deepseek'],
      decisionCandidateIds: ['deepseek'],
    });
  });

  test('missing quota data never vetoes a candidate (fail-open, ADR-0004)', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'glm' }, { id: 'deepseek' }],
      strategy: 'failover',
      tiers: { glm: 'missing', deepseek: 'exhausted' },
    });
    // glm 无数据仍保留；deepseek 耗尽被否决 → 选中无数据的 glm
    expect(scripted.select()).toBe('glm');
    expect(scripted.selections[0].decisionCandidateIds).toEqual(['glm']);
  });

  test('allowAtOrAbove scripting vetoes everything below the threshold', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      strategy: 'failover',
      tiers: { a: 'critical', b: 'tight', c: 'plenty' },
      allowAtOrAbove: 'tight',
    });
    expect(scripted.select()).toBe('b');
    expect(scripted.selections[0].decisionCandidateIds).toEqual(['b', 'c']);
  });

  test('round-robin cycles deterministically over scripted survivors', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      strategy: 'round-robin',
      tiers: { a: 'exhausted' },
    });
    expect(scripted.selectSequence(4)).toEqual(['b', 'c', 'b', 'c']);
  });

  test('weighted-round-robin honors the weights of scripted survivors', () => {
    const scripted = createScriptedProviderPool({
      members: [
        { id: 'a', weight: 1 },
        { id: 'b', weight: 3 },
      ],
      strategy: 'weighted-round-robin',
      tiers: { a: 'exhausted' },
    });
    expect(scripted.selectSequence(3)).toEqual(['b', 'b', 'b']);
  });

  test('when every candidate is vetoed the real pool falls back fail-open', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'a' }, { id: 'b' }],
      strategy: 'failover',
      tiers: { a: 'exhausted', b: 'exhausted' },
    });
    // 上游语义：决策候选为空时回退首个可用成员（不拒绝服务）
    expect(scripted.select()).toBe('a');
    expect(scripted.selections[0].decisionCandidateIds).toEqual([]);
  });

  test('selections accumulate one record per real selectProvider call', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'a' }, { id: 'b' }],
      strategy: 'round-robin',
      tiers: { b: 'exhausted' },
    });
    scripted.selectSequence(3);
    expect(scripted.selections).toHaveLength(3);
    expect(scripted.selections.map((s) => s.selected)).toEqual(['a', 'a', 'a']);
  });
});

describe('the scripted policy sits on the real injection seam', () => {
  test('the policy observes the upstream strategy and healthy candidates', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'a' }, { id: 'disabled', enabled: false }, { id: 'b' }],
      strategy: 'failover',
      tiers: { a: 'exhausted' },
    });
    scripted.select();
    expect(scripted.selections[0].strategy).toBe('failover');
    // 禁用成员不进入上下文候选（上游健康过滤先于额度策略）
    expect(scripted.selections[0].contextCandidateIds).toEqual(['a', 'b']);
  });

  test('a fully custom scripted policy overrides the tier script', () => {
    const scripted = createScriptedProviderPool({
      members: [{ id: 'a' }, { id: 'b' }],
      strategy: 'failover',
      tiers: { a: 'plenty', b: 'exhausted' },
      policy: (context) => ({
        candidates: context.candidates.filter((m) => m.profileId !== 'a'),
      }),
    });
    // 自定义策略放行 b——tiers 脚本失效，只看 policy
    expect(scripted.select()).toBe('b');
    expect(scripted.selections[0].decisionCandidateIds).toEqual(['b']);
  });
});

describe('tier ranking is exported for downstream policy assertions', () => {
  test('rank increases with quota and missing data never ranks lowest', () => {
    expect(TIER_RANK.exhausted).toBeLessThan(TIER_RANK.critical);
    expect(TIER_RANK.critical).toBeLessThan(TIER_RANK.tight);
    expect(TIER_RANK.tight).toBeLessThan(TIER_RANK.plenty);
    expect(TIER_RANK.missing).toBeGreaterThan(TIER_RANK.plenty);
  });
});
