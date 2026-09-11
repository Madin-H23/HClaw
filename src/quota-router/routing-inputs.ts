/**
 * 三源统一输入类型 — 单点定义（T4），供 T5 决策层消费（HClaw 原创模块）
 *
 * 路由决策纯函数的数据输入形状（SPEC #1）：输入 = 快照 + 单价/成本 + 用户余额
 * （+ 请求上下文，后者由 T5 定义）。本文件是唯一权威出口：
 * - 源1 供应商额度：复用 T3 StoredQuotaSnapshot（不重定义）
 * - 源2a 模型单价 / 源2b 供应商已花成本：CC Switch 只读源
 * - 源3 用户余额：上游 billing（UserBalance 上游类型原样，语义不改）
 * 每个源缺失都有显式降级表示（沿 T3 missing 模式），决策层按 fail-open
 * 处理（ADR-0004：缺源 = 退回上游原生选路，绝不拒绝服务）。
 * 禁止在别处手抄这些形状——T5 从本文件 import。
 */
import type {
  ModelPriceOrMissing,
  ProviderSpentCostOrMissing,
} from './cc-switch-cost-source.js';
import type { UserBalanceOrMissing } from './billing-balance-source.js';
import type { QuotaSnapshotOrMissing } from './snapshot-store.js';

/** 路由决策的三源统一输入：四个数据槽位来自三个数据源，各自可缺失 */
export interface RoutingQuotaInputs {
  /** 供应商池 profileId（与快照 providerId 同域） */
  readonly providerId: string;
  /** 源1 供应商额度：quota-tool 快照（T3 原样复用，含 missing 降级） */
  readonly snapshot: QuotaSnapshotOrMissing;
  /** 源2a 模型单价：CC Switch model_pricing（按请求模型查询） */
  readonly modelPrice: ModelPriceOrMissing;
  /** 源2b 供应商已花成本：CC Switch usage_daily_rollups 聚合 */
  readonly spentCost: ProviderSpentCostOrMissing;
  /** 源3 用户余额：上游 billing user_balances（上游类型原样透传） */
  readonly userBalance: UserBalanceOrMissing;
}

// ─── 单点转出口：四源 OrMissing 联合与守卫（T5 唯一 import 点） ─────────

export type {
  MissingQuotaSnapshot,
  QuotaSnapshotOrMissing,
  StoredQuotaSnapshot,
} from './snapshot-store.js';
export { isMissingSnapshot } from './snapshot-store.js';

export type {
  MissingModelPrice,
  ModelPrice,
  ModelPriceOrMissing,
  MissingProviderSpentCost,
  ProviderSpentCost,
  ProviderSpentCostOrMissing,
} from './cc-switch-cost-source.js';
export {
  isMissingModelPrice,
  isMissingProviderSpentCost,
} from './cc-switch-cost-source.js';

export type {
  MissingUserBalance,
  UserBalance,
  UserBalanceOrMissing,
} from './billing-balance-source.js';
export { isMissingUserBalance } from './billing-balance-source.js';
