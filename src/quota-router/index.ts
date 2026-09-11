/**
 * quota-router — 额度感知路由（HClaw 原创模块）
 *
 * T1 立缝：选路上下文与路由决策的最小类型 + no-op 策略（原样放行）。
 * T3 落数据面：quota-tool 适配器 / 凭证自持加密存储 / 独立快照库
 * （data/db/quota-router.db，ADR-0006）/ 档位归一化 / TTL 懒刷新
 * + single-flight（选路访问时刷新，ADR-0004 fail-open）。
 * T4 落成本与余额源：CC Switch 库只读（单价+已花成本，绝不写）、
 * 上游 billing 只读消费（用户余额，语义原样）+ 三源统一输入类型
 * （routing-inputs，单点定义）。
 * 决策的选定/降档/否决形态由后续票扩展（SPEC #1 注入点①②③）。
 */
import type { ProviderPoolMember } from '../provider-pool.js';
import type { BalancingConfig } from '../runtime-config.js';

/** 选路上下文：上游健康过滤后的幸存者候选与当前均衡策略名 */
export interface QuotaRoutingContext {
  readonly strategy: BalancingConfig['strategy'];
  readonly candidates: readonly ProviderPoolMember[];
}

/** 路由决策：T1 仅 passthrough（原样放行）形态 */
export interface QuotaRoutingDecision {
  readonly candidates: readonly ProviderPoolMember[];
}

/** 额度策略纯函数：输入选路上下文，输出路由决策 */
export type QuotaRoutingPolicy = (
  context: QuotaRoutingContext,
) => QuotaRoutingDecision;

export { noopQuotaRoutingPolicy } from './policy.js';

// ─── T3：数据面（适配器 / 归一化 / 凭证 / 快照库 / 刷新器 / 配置） ───

export type {
  QuotaTier,
  QuotaSignalKind,
  QuotaWindow,
  QuotaSummaryItem,
  TierThresholds,
  TierThresholdTable,
  NormalizeQuotaInput,
  NormalizedQuotaTier,
} from './tiers.js';
export {
  QUOTA_TIERS,
  QUOTA_TIER_LABELS,
  DEFAULT_TIER_THRESHOLDS,
  normalizeQuotaTier,
  tierOf,
  detectSignalKind,
} from './tiers.js';

export type {
  QuotaToolEndpoint,
  QuotaQueryPayload,
  QuotaToolOutcome,
} from './quota-tool-client.js';
export { queryQuotaTool } from './quota-tool-client.js';

export type { QuotaCredentialRecord } from './credentials.js';
export { QuotaCredentialStore } from './credentials.js';

export type {
  StoredQuotaSnapshot,
  MissingQuotaSnapshot,
  QuotaSnapshotOrMissing,
} from './snapshot-store.js';
export { QuotaSnapshotStore, isMissingSnapshot } from './snapshot-store.js';

export type { ProviderQuotaMapping, QuotaRouterConfig } from './config.js';
export {
  QuotaRouterConfigLoader,
  DEFAULT_QUOTA_ROUTER_CONFIG,
} from './config.js';

export type { QuotaSnapshotRefresherOptions } from './refresher.js';
export { QuotaSnapshotRefresher } from './refresher.js';

// ─── T4：成本与余额源（CC Switch 只读 / 上游 billing / 统一输入类型） ───

export type {
  ModelPrice,
  MissingModelPrice,
  ModelPriceOrMissing,
  ProviderSpentCost,
  MissingProviderSpentCost,
  ProviderSpentCostOrMissing,
  CcSwitchFailureKind,
  CcSwitchSourceFailure,
  CcSwitchCostSourceOptions,
} from './cc-switch-cost-source.js';
export {
  CcSwitchCostSource,
  defaultCcSwitchDbPath,
} from './cc-switch-cost-source.js';

export type {
  BillingBalanceReader,
  BillingSourceFailure,
  MissingUserBalance,
  UserBalance,
  UserBalanceOrMissing,
} from './billing-balance-source.js';
export {
  BillingBalanceSource,
  isMissingUserBalance,
} from './billing-balance-source.js';

export type { RoutingQuotaInputs } from './routing-inputs.js';
