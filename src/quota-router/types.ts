/**
 * quota-router — 额度感知路由（HClaw 原创模块）
 *
 * T1 仅立缝：选路上下文与路由决策的最小类型 + no-op 策略（原样放行）。
 * 决策的选定/降档/否决形态由后续票扩展（SPEC #1 注入点①②③）。
 * 数据落库与上游隔离：额度快照写独立 quota-router.db（ADR-0006），
 * 全部数据路径 fail-open（ADR-0004），执行面直连供应商（ADR-0003）。
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
