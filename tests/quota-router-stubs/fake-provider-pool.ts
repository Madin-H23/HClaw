/**
 * 假供应商池桩 — 经 T1 注入缝驱动上游真实选路循环（T2 测试基座，SPEC #1）
 *
 * 桩不替换选路算法：包住真实 ProviderPool（src/provider-pool.ts），用
 * setQuotaRoutingPolicy（T1 缝）挂按脚本构造的 QuotaRoutingPolicy。
 * 脚本两轴：
 * - tiers：profileId → 额度档位（四档或 'missing'——无额度数据按 fail-open
 *   保留，绝不因缺数据否决候选，ADR-0004）
 * - allowAtOrAbove：低于该档位的候选被脚本策略否决出局（默认 'critical'，
 *   即只有「耗尽」出局——对齐 SPEC「粘滞/否决只针对耗尽」的口径基线）
 * 每次选路记录上游健康过滤后的上下文候选、决策候选与最终选中，供后续票
 * 做行为断言（外部行为优先：断言选中谁、剩谁，不断言内部调用次数）。
 */
import { ProviderPool } from '../../src/provider-pool.js';
import type {
  QuotaRoutingContext,
  QuotaRoutingDecision,
  QuotaRoutingPolicy,
} from '../../src/quota-router/index.js';
import type { QuotaTier } from './fake-snapshot.js';

export type ScriptedTier = QuotaTier | 'missing';

/** 档位序：数值越大额度越足；'missing' 无数据 fail-open（rank 最大，永不否决） */
export const TIER_RANK: Record<ScriptedTier, number> = {
  exhausted: 0,
  critical: 1,
  tight: 2,
  plenty: 3,
  missing: Number.POSITIVE_INFINITY,
};

export type PoolStrategy = 'round-robin' | 'weighted-round-robin' | 'failover';

export interface ScriptedPoolOptions {
  readonly members: ReadonlyArray<{
    id: string;
    weight?: number;
    enabled?: boolean;
  }>;
  readonly strategy?: PoolStrategy;
  /** 脚本：profileId → 档位；未列出的 profileId 按 'missing' 处理（fail-open 保留） */
  readonly tiers?: Record<string, ScriptedTier>;
  /** 否决阈值：rank 低于该档位的候选出局，默认 'critical'（仅耗尽出局） */
  readonly allowAtOrAbove?: QuotaTier;
  /** 完全自定义脚本策略；给出时 tiers/allowAtOrAbove 不再生效 */
  readonly policy?: QuotaRoutingPolicy;
}

export interface ScriptedPoolSelection {
  readonly selected: string;
  readonly strategy: PoolStrategy;
  /** 上游健康过滤后交给策略的候选（注入缝收到的上下文） */
  readonly contextCandidateIds: readonly string[];
  /** 策略放行的幸存者（路由决策候选） */
  readonly decisionCandidateIds: readonly string[];
}

export interface ScriptedProviderPool {
  /** 真实上游选路循环实例（本桩驱动它，而不是模仿它） */
  readonly pool: ProviderPool;
  readonly selections: readonly ScriptedPoolSelection[];
  select(): string;
  selectSequence(count: number): string[];
}

export function createScriptedProviderPool(
  options: ScriptedPoolOptions,
): ScriptedProviderPool {
  const strategy = options.strategy ?? 'round-robin';
  const allowRank = TIER_RANK[options.allowAtOrAbove ?? 'critical'];
  const tiers = options.tiers ?? {};

  const pool = new ProviderPool();
  pool.refreshFromConfig(
    options.members.map((m) => ({
      id: m.id,
      enabled: m.enabled ?? true,
      weight: m.weight ?? 1,
    })),
    { strategy, unhealthyThreshold: 3, recoveryIntervalMs: 300_000 },
  );

  const observed: {
    context: QuotaRoutingContext | null;
    decision: QuotaRoutingDecision | null;
  } = { context: null, decision: null };

  const tierFilterPolicy: QuotaRoutingPolicy = (context) => ({
    candidates: context.candidates.filter(
      (m) => TIER_RANK[tiers[m.profileId] ?? 'missing'] >= allowRank,
    ),
  });

  // 包装层只做观察记录，决策一律透传给被脚本选定的策略
  const observingPolicy: QuotaRoutingPolicy = (context) => {
    observed.context = context;
    const decision = (options.policy ?? tierFilterPolicy)(context);
    observed.decision = decision;
    return decision;
  };
  pool.setQuotaRoutingPolicy(observingPolicy);

  const selections: ScriptedPoolSelection[] = [];

  const select = (): string => {
    observed.context = null;
    observed.decision = null;
    const selected = pool.selectProvider();
    selections.push({
      selected,
      strategy,
      contextCandidateIds: observed.context
        ? observed.context.candidates.map((m) => m.profileId)
        : [],
      decisionCandidateIds: observed.decision
        ? observed.decision.candidates.map((m) => m.profileId)
        : [],
    });
    return selected;
  };

  const selectSequence = (count: number): string[] =>
    Array.from({ length: count }, () => select());

  return { pool, selections, select, selectSequence };
}
