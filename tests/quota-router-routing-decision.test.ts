import { describe, expect, test } from 'vitest';

import type { QuotaRoutingPolicy } from '../src/quota-router/types.js';
import type { ProviderPoolMember } from '../src/provider-pool.js';
import {
  decideRouting,
  toQuotaRoutingDecision,
  type QuotaCandidateInput,
  type RoutingDecision,
  type RoutingDecisionInput,
} from '../src/quota-router/routing-decision.js';
import type {
  RoutingQuotaInputs,
  StoredQuotaSnapshot,
} from '../src/quota-router/routing-inputs.js';
import {
  DEFAULT_TIER_THRESHOLDS,
  normalizeQuotaTier,
} from '../src/quota-router/tiers.js';
import {
  makeMissingSnapshot,
  makeQuotaSnapshot,
  TIER_SAMPLE_USED_PERCENTAGE,
  TIER_SAMPLE_USD_BALANCE,
} from './quota-router-stubs/fake-snapshot.js';
import { createScriptedProviderPool } from './quota-router-stubs/fake-provider-pool.js';

// 路由决策纯函数（T5，SPEC #1「路由决策纯函数」缝）行为级测试：
// 只断言可观察行为（选中谁 / 降到哪里 / 拒绝文案 / 幸存集），吃 T2 桩样本
// 常量与 T3 生产归一化函数；时钟与 TTL 全部注入，无任何真实时间依赖。

const NOW_MS = Date.parse('2026-09-11T12:00:00Z');
const TTL_MS = 300_000;

type Tier = 'plenty' | 'tight' | 'critical' | 'exhausted';
type Signal = 'absolute' | 'percentage' | 'currency';

// ─── 构造器：三源数据 / 候选 / 决策输入 ─────────────────────

/** T2 桩快照 + T3 存储形态补齐（storedAt/score），数值全部来自 T2 样本常量 */
function storedSnapshot(
  providerId: string,
  tier: Tier,
  options?: { signal?: Signal; ageMs?: number },
): StoredQuotaSnapshot {
  const fake = makeQuotaSnapshot(providerId, {
    tier,
    signal: options?.signal,
    ageMs: options?.ageMs,
    now: NOW_MS,
  });
  const signal = options?.signal ?? 'absolute';
  // 剩余分与档位同源（T2 样本表）：绝对/百分比信号按已用百分比折算，货币看余额
  const score =
    signal === 'currency'
      ? TIER_SAMPLE_USD_BALANCE[tier]
      : 100 - TIER_SAMPLE_USED_PERCENTAGE[tier];
  return { ...fake, storedAt: fake.fetchedAt, score };
}

function quotaInputs(
  providerId: string,
  options?: {
    tier?: Tier;
    snapshotMissing?: boolean;
    signal?: Signal;
    ageMs?: number;
    priceMissing?: boolean;
    price?: { input: number; output: number };
    spentMissing?: boolean;
    balanceMissing?: boolean;
  },
): RoutingQuotaInputs {
  return {
    providerId,
    snapshot: options?.snapshotMissing
      ? makeMissingSnapshot(providerId)
      : storedSnapshot(providerId, options?.tier ?? 'plenty', {
          signal: options?.signal,
          ageMs: options?.ageMs,
        }),
    modelPrice: options?.priceMissing
      ? { modelId: 'model-a', missing: true }
      : {
          modelId: 'model-a',
          displayName: 'Model A',
          inputCostPerMillion: options?.price?.input ?? 3,
          outputCostPerMillion: options?.price?.output ?? 15,
          cacheReadCostPerMillion: 0.3,
          cacheCreationCostPerMillion: 3.75,
        },
    spentCost: options?.spentMissing
      ? { providerId, missing: true }
      : {
          providerId,
          totalCostUsd: 1.25,
          requestCount: 40,
          firstDate: '2026-09-01',
          lastDate: '2026-09-10',
          windowDays: null,
        },
    userBalance: options?.balanceMissing
      ? { userId: 'user-alice', missing: true }
      : {
          user_id: 'user-alice',
          balance_usd: 42,
          total_deposited_usd: 50,
          total_consumed_usd: 8,
          updated_at: '2026-09-11T00:00:00Z',
        },
  };
}

function candidate(
  profileId: string,
  options?: Parameters<typeof quotaInputs>[1],
): QuotaCandidateInput {
  return {
    member: { profileId, weight: 1, enabled: true },
    quota: quotaInputs(profileId, options),
  };
}

function decisionInput(
  overrides?: Partial<RoutingDecisionInput>,
): RoutingDecisionInput {
  return {
    strategy: 'round-robin',
    candidates: [],
    agentBinding: null,
    stickyProviderId: null,
    adminOverride: false,
    snapshotTtlMs: TTL_MS,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function survivorIds(decision: RoutingDecision): string[] {
  return decision.survivors.map((m) => m.profileId);
}

/** 恰在阈值上的真实窗口快照：档位由生产归一化函数裁决，不手写档位 */
function snapshotAtScore(
  providerId: string,
  signal: Signal,
  score: number,
): StoredQuotaSnapshot {
  if (signal === 'currency') {
    return {
      providerId,
      tier: tierOfOrThrow(providerId, signal, score),
      signalKind: signal,
      score,
      fetchedAt: '2026-09-11T11:00:00Z',
      storedAt: '2026-09-11T11:00:01Z',
      windows: [],
      summary: [{ label: 'USD 总余额', value: score }],
    };
  }
  const total = 400_000;
  const remaining = Math.round((total * score) / 100);
  const used = total - remaining;
  const window = {
    label: '5h Rolling',
    total,
    used,
    remaining,
    percentage: 100 - score,
    resetAt: '2026-09-11T17:00:00Z',
    unit: signal === 'percentage' ? '%' : 'AFP',
  };
  return {
    providerId,
    tier: tierOfOrThrow(providerId, signal, score),
    signalKind: signal,
    score,
    fetchedAt: '2026-09-11T11:00:00Z',
    storedAt: '2026-09-11T11:00:01Z',
    windows: [window],
    summary: [],
  };
}

function tierOfOrThrow(
  providerId: string,
  signal: Signal,
  score: number,
): Tier {
  const normalized = normalizeQuotaTier(
    signal === 'currency'
      ? { windows: [], summary: [{ label: 'USD 总余额', value: score }] }
      : {
          windows: [
            {
              label: '5h Rolling',
              total: 400_000,
              used: Math.round(400_000 * (1 - score / 100)),
              remaining: Math.round((400_000 * score) / 100),
              percentage: 100 - score,
              resetAt: null,
              unit: signal === 'percentage' ? '%' : 'AFP',
            },
          ],
          summary: [],
        },
    DEFAULT_TIER_THRESHOLDS,
  );
  if (!normalized) throw new Error(`无法归一化：${providerId} ${signal}`);
  return normalized.tier;
}

// ─── 四档阈值边界（恰在阈值）× 异构三信号 → 前置过滤 ────────

describe('四档阈值边界（恰在阈值）× 异构三信号 → 前置过滤', () => {
  // 阈值表（tiers.ts DEFAULT_TIER_THRESHOLDS）：绝对/百分比 ≤25 紧张 ≤10 临界 ≤0 耗尽；货币 ≤20/≤5/≤0
  const boundaryCases = [
    {
      signal: 'percentage' as Signal,
      tight: 25,
      critical: 10,
      exhausted: 0,
      plenty: 26,
    },
    {
      signal: 'absolute' as Signal,
      tight: 25,
      critical: 10,
      exhausted: 0,
      plenty: 26,
    },
    {
      signal: 'currency' as Signal,
      tight: 20,
      critical: 5,
      exhausted: 0,
      plenty: 21,
    },
  ];

  for (const bounds of boundaryCases) {
    test(`${bounds.signal} 信号恰在阈值时档位裁决驱动过滤（耗尽出局、其余幸存）`, () => {
      const cases: Array<{ score: number; tier: Tier }> = [
        { score: bounds.exhausted, tier: 'exhausted' },
        { score: bounds.critical, tier: 'critical' },
        { score: bounds.tight, tier: 'tight' },
        { score: bounds.plenty, tier: 'plenty' },
      ];
      for (const { score, tier } of cases) {
        const providerId = `prof-${bounds.signal}-${tier}`;
        const entry: QuotaCandidateInput = {
          member: { profileId: providerId, weight: 1, enabled: true },
          quota: {
            providerId,
            snapshot: snapshotAtScore(providerId, bounds.signal, score),
            modelPrice: { modelId: 'model-a', missing: true },
            spentCost: { providerId, missing: true },
            userBalance: { userId: 'user-alice', missing: true },
          },
        };
        const decision = decideRouting(decisionInput({ candidates: [entry] }));
        if (tier === 'exhausted') {
          // 恰在耗尽阈值（剩余分 ≤ 0）：出局，幸存集为空
          expect(survivorIds(decision)).toEqual([]);
          expect(decision.reason).toContain(providerId);
        } else {
          // 恰在紧张/临界阈值及以上的候选幸存（仅耗尽出局）
          expect(survivorIds(decision)).toEqual([providerId]);
        }
      }
    });
  }

  test('混合候选集：仅档位耗尽者出局，幸存集保留原成员引用', () => {
    const dead = candidate('prof-dead', { tier: 'exhausted' });
    const alive = candidate('prof-alive', { tier: 'tight' });
    const decision = decideRouting(
      decisionInput({ candidates: [dead, alive] }),
    );
    expect(decision.kind).toBe('native');
    expect(survivorIds(decision)).toEqual(['prof-alive']);
    // 幸存集是原成员引用（决策不复制不改写候选）
    expect(decision.survivors[0]).toBe(alive.member);
    expect(decision.reason).toContain('prof-dead');
    expect(decision.reason).toContain('1/2');
  });
});

// ─── 绑定否决两级（Agent 显式绑定，绕过池） ─────────────────

function boundInput(
  boundTier: Tier | 'snapshot-missing' | 'no-slot',
  candidates: QuotaCandidateInput[],
  overrides?: Partial<RoutingDecisionInput>,
): RoutingDecisionInput {
  return decisionInput({
    candidates,
    agentBinding: {
      modelConfigId: 'prof-bound',
      candidate:
        boundTier === 'no-slot'
          ? null
          : candidate(
              'prof-bound',
              boundTier === 'snapshot-missing'
                ? { snapshotMissing: true }
                : { tier: boundTier },
            ),
    },
    ...overrides,
  });
}

describe('绑定否决两级（Agent 显式绑定，绕过池）', () => {
  test('绑定供应商档位非耗尽 → 放行选定绑定供应商', () => {
    const decision = decideRouting(boundInput('critical', []));
    expect(decision.kind).toBe('select');
    if (decision.kind === 'select') {
      expect(decision.providerId).toBe('prof-bound');
      expect(decision.stickyKept).toBe(false);
      expect(decision.adminOverride).toBe(false);
    }
    expect(decision.reason).toContain('prof-bound');
    expect(decision.reason).toContain('临界');
  });

  test('绑定耗尽 + 候选集有幸存者 → 降档（档位序优先于成本序）', () => {
    const decision = decideRouting(
      boundInput('exhausted', [
        candidate('prof-plenty-expensive', {
          tier: 'plenty',
          price: { input: 50, output: 200 },
        }),
        candidate('prof-tight-cheap', {
          tier: 'tight',
          price: { input: 1, output: 5 },
        }),
      ]),
    );
    expect(decision.kind).toBe('downgrade');
    if (decision.kind === 'downgrade') {
      expect(decision.providerId).toBe('prof-plenty-expensive');
      expect(decision.fromProviderId).toBe('prof-bound');
      // 降档目标即新粘滞点（轮边界迁移并重设粘滞）
      expect(decision.newStickyProviderId).toBe('prof-plenty-expensive');
    }
    expect(decision.reason).toContain('prof-bound');
    expect(decision.reason).toContain('降档');
    expect(decision.reason).toContain('prof-plenty-expensive');
  });

  test('同档位按成本序：更便宜者胜出，单价进 reason', () => {
    const decision = decideRouting(
      boundInput('exhausted', [
        candidate('prof-costly', {
          tier: 'tight',
          price: { input: 9, output: 45 },
        }),
        candidate('prof-cheap', {
          tier: 'tight',
          price: { input: 1, output: 2 },
        }),
      ]),
    );
    expect(decision.kind).toBe('downgrade');
    if (decision.kind === 'downgrade') {
      expect(decision.providerId).toBe('prof-cheap');
    }
    expect(decision.reason).toContain('输入 1');
    expect(decision.reason).toContain('输出 2');
  });

  test('单价缺失殿后：已知单价同档位候选优先，缺失者仍可选', () => {
    const decision = decideRouting(
      boundInput('exhausted', [
        candidate('prof-unpriced', { tier: 'tight', priceMissing: true }),
        candidate('prof-priced', {
          tier: 'tight',
          price: { input: 9, output: 9 },
        }),
      ]),
    );
    expect(decision.kind).toBe('downgrade');
    if (decision.kind === 'downgrade') {
      expect(decision.providerId).toBe('prof-priced');
    }
    // 只剩单价缺失的幸存者时仍降档（缺失不阻塞选路），理由注明单价未知
    const fallbackDecision = decideRouting(
      boundInput('exhausted', [
        candidate('prof-unpriced', { tier: 'tight', priceMissing: true }),
      ]),
    );
    expect(fallbackDecision.kind).toBe('downgrade');
    expect(fallbackDecision.reason).toContain('单价未知');
  });

  test('绑定耗尽 + 全部候选耗尽 → 否决，理由明示额度耗尽与降无可降', () => {
    const decision = decideRouting(
      boundInput('exhausted', [
        candidate('prof-also-dead', { tier: 'exhausted' }),
      ]),
    );
    expect(decision.kind).toBe('veto');
    expect(decision.survivors).toEqual([]);
    expect(decision.fallbackSequence).toEqual([]);
    expect(decision.reason).toContain('prof-bound');
    expect(decision.reason).toContain('耗尽');
    expect(decision.reason).toContain('降无可降');
  });

  test('绑定耗尽 + 候选集为空 → 否决（降无可降）', () => {
    const decision = decideRouting(boundInput('exhausted', []));
    expect(decision.kind).toBe('veto');
    expect(decision.reason).toContain('降无可降');
  });

  test('admin 显式放行解除否决 → 选定绑定供应商并带告警标记', () => {
    const decision = decideRouting(
      boundInput(
        'exhausted',
        [candidate('prof-also-dead', { tier: 'exhausted' })],
        {
          adminOverride: true,
        },
      ),
    );
    expect(decision.kind).toBe('select');
    if (decision.kind === 'select') {
      expect(decision.providerId).toBe('prof-bound');
      expect(decision.adminOverride).toBe(true);
    }
    expect(decision.reason).toContain('admin 放行');
    expect(decision.reason).toContain('耗尽');
  });

  test('admin 放行不跳过降档：降档目标存在时仍降档', () => {
    const decision = decideRouting(
      boundInput('exhausted', [candidate('prof-target', { tier: 'plenty' })], {
        adminOverride: true,
      }),
    );
    expect(decision.kind).toBe('downgrade');
    if (decision.kind === 'downgrade') {
      expect(decision.providerId).toBe('prof-target');
    }
  });

  test('绑定供应商快照缺失 → fail-open 放行', () => {
    const decision = decideRouting(boundInput('snapshot-missing', []));
    expect(decision.kind).toBe('select');
    if (decision.kind === 'select') {
      expect(decision.providerId).toBe('prof-bound');
      expect(decision.adminOverride).toBe(false);
    }
    expect(decision.reason).toContain('无额度快照');
  });

  test('绑定数据槽位未供给 → fail-open 放行', () => {
    const decision = decideRouting(boundInput('no-slot', []));
    expect(decision.kind).toBe('select');
    if (decision.kind === 'select') {
      expect(decision.providerId).toBe('prof-bound');
    }
    expect(decision.reason).toContain('无额度快照');
  });
});

// ─── 粘滞优先（轮边界语义，绝不轮内迁移） ───────────────────

describe('粘滞优先（轮边界语义）', () => {
  test('粘滞供应商档位非耗尽 → 维持粘滞不动，幸存集收缩为粘滞点', () => {
    const sticky = candidate('prof-sticky', { tier: 'tight' });
    const decision = decideRouting(
      decisionInput({
        candidates: [sticky, candidate('prof-other', { tier: 'plenty' })],
        stickyProviderId: 'prof-sticky',
      }),
    );
    expect(decision.kind).toBe('select');
    if (decision.kind === 'select') {
      expect(decision.providerId).toBe('prof-sticky');
      expect(decision.stickyKept).toBe(true);
    }
    expect(survivorIds(decision)).toEqual(['prof-sticky']);
    expect(decision.fallbackSequence).toEqual(['prof-other']);
    expect(decision.reason).toContain('维持粘滞');
    expect(decision.reason).toContain('prof-sticky');
  });

  test('粘滞供应商耗尽 → 轮边界迁移：幸存集剔除粘滞，输出新粘滞点标记', () => {
    const decision = decideRouting(
      decisionInput({
        candidates: [
          candidate('prof-sticky', { tier: 'exhausted' }),
          candidate('prof-a', { tier: 'plenty' }),
        ],
        stickyProviderId: 'prof-sticky',
      }),
    );
    expect(decision.kind).toBe('native');
    if (decision.kind === 'native') {
      expect(decision.newStickyFromProviderId).toBe('prof-sticky');
    }
    expect(survivorIds(decision)).toEqual(['prof-a']);
    expect(decision.reason).toContain('粘滞迁移');
    expect(decision.reason).toContain('prof-sticky');
    expect(decision.reason).toContain('耗尽');
  });

  test('无粘滞 → 交上游原生，无新粘滞点标记', () => {
    const decision = decideRouting(
      decisionInput({ candidates: [candidate('prof-a', { tier: 'plenty' })] }),
    );
    expect(decision.kind).toBe('native');
    if (decision.kind === 'native') {
      expect(decision.newStickyFromProviderId).toBeNull();
    }
    expect(survivorIds(decision)).toEqual(['prof-a']);
  });

  test('粘滞候选快照缺失 → fail-open 维持粘滞', () => {
    const decision = decideRouting(
      decisionInput({
        candidates: [candidate('prof-sticky', { snapshotMissing: true })],
        stickyProviderId: 'prof-sticky',
      }),
    );
    expect(decision.kind).toBe('select');
    if (decision.kind === 'select') {
      expect(decision.providerId).toBe('prof-sticky');
      expect(decision.stickyKept).toBe(true);
    }
    expect(decision.reason).toContain('无额度快照');
  });

  test('粘滞供应商不在健康候选集 → 按无粘滞处理并标记重设粘滞', () => {
    const decision = decideRouting(
      decisionInput({
        candidates: [candidate('prof-a', { tier: 'plenty' })],
        stickyProviderId: 'prof-gone',
      }),
    );
    expect(decision.kind).toBe('native');
    if (decision.kind === 'native') {
      expect(decision.newStickyFromProviderId).toBe('prof-gone');
    }
    expect(decision.reason).toContain('不在健康候选集');
    expect(survivorIds(decision)).toEqual(['prof-a']);
  });
});

// ─── fail-open 组合矩阵 ─────────────────────────────────────

describe('fail-open 组合矩阵', () => {
  test('四源全缺失 × 全体候选 → 交上游原生（等价无额度感知）+ 全量降级标注', () => {
    const decision = decideRouting(
      decisionInput({
        candidates: [
          candidate('prof-a', {
            snapshotMissing: true,
            priceMissing: true,
            spentMissing: true,
            balanceMissing: true,
          }),
          candidate('prof-b', {
            snapshotMissing: true,
            priceMissing: true,
            spentMissing: true,
            balanceMissing: true,
          }),
        ],
      }),
    );
    expect(decision.kind).toBe('native');
    expect(survivorIds(decision)).toEqual(['prof-a', 'prof-b']);
    const kinds = new Set(decision.degradations.map((d) => d.kind));
    expect(kinds).toContain('snapshot-missing');
    expect(kinds).toContain('price-missing');
    expect(kinds).toContain('spent-cost-missing');
    expect(kinds).toContain('user-balance-missing');
    expect(decision.reason).toContain('无额度感知');
    expect(decision.reason).toContain('fail-open');
  });

  test('个别候选快照缺失 → 缺失者放行，耗尽者照常出局', () => {
    const decision = decideRouting(
      decisionInput({
        candidates: [
          candidate('prof-missing', { snapshotMissing: true }),
          candidate('prof-dead', { tier: 'exhausted' }),
        ],
      }),
    );
    expect(decision.kind).toBe('native');
    expect(survivorIds(decision)).toEqual(['prof-missing']);
    expect(decision.reason).toContain('prof-dead');
  });

  test('快照陈旧照用：陈旧充足粘滞维持，降级标注数据年龄', () => {
    const decision = decideRouting(
      decisionInput({
        candidates: [
          candidate('prof-sticky', { tier: 'plenty', ageMs: TTL_MS + 1000 }),
        ],
        stickyProviderId: 'prof-sticky',
      }),
    );
    expect(decision.kind).toBe('select');
    if (decision.kind === 'select') {
      expect(decision.providerId).toBe('prof-sticky');
    }
    expect(decision.reason).toContain('陈旧');
    const stale = decision.degradations.find(
      (d) => d.kind === 'snapshot-stale',
    );
    expect(stale).toBeDefined();
    if (stale?.kind === 'snapshot-stale') {
      expect(stale.ageMs).toBe(TTL_MS + 1000);
    }
  });

  test('快照陈旧照用：陈旧耗尽仍出局（照用不豁免档位裁决）', () => {
    const decision = decideRouting(
      decisionInput({
        candidates: [
          candidate('prof-dead', { tier: 'exhausted', ageMs: TTL_MS + 1000 }),
        ],
      }),
    );
    expect(decision.kind).toBe('native');
    expect(survivorIds(decision)).toEqual([]);
    expect(decision.degradations.some((d) => d.kind === 'snapshot-stale')).toBe(
      true,
    );
  });

  test('单价/已花成本缺失不阻塞选路：幸存集与数据齐全时一致', () => {
    const base = decideRouting(
      decisionInput({
        candidates: [
          candidate('prof-a', { tier: 'tight' }),
          candidate('prof-b', { tier: 'plenty' }),
        ],
      }),
    );
    const degraded = decideRouting(
      decisionInput({
        candidates: [
          candidate('prof-a', {
            tier: 'tight',
            priceMissing: true,
            spentMissing: true,
          }),
          candidate('prof-b', {
            tier: 'plenty',
            priceMissing: true,
            spentMissing: true,
          }),
        ],
      }),
    );
    expect(survivorIds(degraded)).toEqual(survivorIds(base));
    const kinds = new Set(degraded.degradations.map((d) => d.kind));
    expect(kinds).toContain('price-missing');
    expect(kinds).toContain('spent-cost-missing');
  });

  test('用户余额缺失只跳过余额维度，不影响供应商额度过滤', () => {
    const decision = decideRouting(
      decisionInput({
        candidates: [
          candidate('prof-a', { tier: 'plenty', balanceMissing: true }),
        ],
      }),
    );
    expect(survivorIds(decision)).toEqual(['prof-a']);
    expect(
      decision.degradations.some((d) => d.kind === 'user-balance-missing'),
    ).toBe(true);
  });

  test('用户余额缺失不影响降档目标挑选（本函数不建余额闸门）', () => {
    const decision = decideRouting(
      boundInput('exhausted', [
        candidate('prof-target', { tier: 'tight', balanceMissing: true }),
      ]),
    );
    expect(decision.kind).toBe('downgrade');
    if (decision.kind === 'downgrade') {
      expect(decision.providerId).toBe('prof-target');
    }
  });
});

// ─── reason 一行可解释性 ────────────────────────────────────

describe('reason 一行可解释性', () => {
  const decisions: RoutingDecision[] = [
    decideRouting(boundInput('tight', [])),
    decideRouting(
      boundInput('exhausted', [candidate('prof-target', { tier: 'plenty' })]),
    ),
    decideRouting(boundInput('exhausted', [])),
    decideRouting(
      decisionInput({
        candidates: [candidate('prof-sticky', { tier: 'plenty' })],
        stickyProviderId: 'prof-sticky',
      }),
    ),
    decideRouting(
      decisionInput({
        candidates: [candidate('prof-a', { tier: 'exhausted' })],
        stickyProviderId: 'prof-sticky',
      }),
    ),
    decideRouting(
      decisionInput({
        candidates: [candidate('prof-a', { snapshotMissing: true })],
      }),
    ),
    decideRouting(decisionInput({})),
  ];

  test('每种决策的理由为一行非空中文，无模板残留与黑话占位', () => {
    for (const decision of decisions) {
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.reason).not.toContain('\n');
      expect(decision.reason).not.toContain('undefined');
      expect(decision.reason).not.toContain('NaN');
      expect(decision.reason).not.toContain('{}');
      expect(decision.reason.length).toBeLessThanOrEqual(120);
    }
  });

  test('选定/降档理由点名供应商与档位，否决理由点名绑定供应商', () => {
    const [boundPass, downgrade, veto, stickyKeep, migrate, allMissing] =
      decisions;
    expect(boundPass.reason).toContain('prof-bound');
    expect(boundPass.reason).toContain('紧张');
    expect(downgrade.reason).toContain('prof-target');
    expect(veto.reason).toContain('prof-bound');
    expect(stickyKeep.reason).toContain('prof-sticky');
    expect(stickyKeep.reason).toContain('充足');
    expect(migrate.reason).toContain('prof-sticky');
    expect(allMissing.reason).toContain('无额度感知');
  });
});

// ─── 决策幂等 ───────────────────────────────────────────────

describe('决策幂等', () => {
  test('同一输入两次调用输出深等（冻结输入防隐性变异）', () => {
    const poolInput = Object.freeze(
      decisionInput({
        candidates: [
          candidate('prof-a', { tier: 'plenty' }),
          candidate('prof-b', { tier: 'exhausted' }),
        ],
        stickyProviderId: 'prof-a',
      }),
    );
    expect(decideRouting(poolInput)).toEqual(decideRouting(poolInput));

    const bindingInput = Object.freeze(
      boundInput(
        'exhausted',
        [
          candidate('prof-x', {
            tier: 'tight',
            price: { input: 5, output: 20 },
          }),
          candidate('prof-y', { tier: 'critical' }),
        ],
        { adminOverride: false },
      ),
    );
    expect(decideRouting(bindingInput)).toEqual(decideRouting(bindingInput));
  });
});

// ─── T1 缝契约对齐 ──────────────────────────────────────────

describe('T1 缝契约对齐', () => {
  test('toQuotaRoutingDecision 产出 QuotaRoutingDecision 形状（candidates 引用原样）', () => {
    const decision = decideRouting(
      decisionInput({ candidates: [candidate('prof-a', { tier: 'plenty' })] }),
    );
    const seam = toQuotaRoutingDecision(decision);
    expect(Object.keys(seam)).toEqual(['candidates']);
    expect(seam.candidates).toBe(decision.survivors);
  });

  test('真实选路循环：决策幸存集经 T1 缝过滤耗尽候选，上游策略从幸存者中选', () => {
    const tiers: Record<string, Tier> = {
      'prof-plenty': 'plenty',
      'prof-tight': 'tight',
      'prof-dead': 'exhausted',
    };
    // 把决策纯函数装进 T1 缝（T6 装配的同款收口）：QuotaRoutingPolicy 复用
    const policy: QuotaRoutingPolicy = (context) =>
      toQuotaRoutingDecision(
        decideRouting({
          strategy: context.strategy,
          candidates: context.candidates.map((member: ProviderPoolMember) => ({
            member,
            quota: quotaInputs(member.profileId, {
              tier: tiers[member.profileId],
            }),
          })),
          agentBinding: null,
          stickyProviderId: null,
          adminOverride: false,
          snapshotTtlMs: TTL_MS,
          nowMs: NOW_MS,
        }),
      );

    const scripted = createScriptedProviderPool({
      members: [
        { id: 'prof-plenty' },
        { id: 'prof-tight' },
        { id: 'prof-dead' },
      ],
      strategy: 'failover',
      policy,
    });
    const picked = scripted.select();
    const selection = scripted.selections[0];
    // 缝收到的上下文是健康过滤后的三家；决策幸存集剔除了耗尽者
    expect(selection.contextCandidateIds).toEqual([
      'prof-plenty',
      'prof-tight',
      'prof-dead',
    ]);
    expect(selection.decisionCandidateIds).toEqual([
      'prof-plenty',
      'prof-tight',
    ]);
    expect(picked).toBe('prof-plenty');
  });
});
