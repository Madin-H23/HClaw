import type { QuotaRoutingDecision, QuotaRoutingPolicy } from './types.js';

/**
 * no-op 额度策略：原样放行。
 *
 * T1 注入点默认值——额度感知尚未生效，选路行为与上游完全一致
 * （ADR-0004 fail-open 的空实现；注入前后行为一致由
 * tests/quota-router-noop-injection.test.ts 证明）。
 */
export const noopQuotaRoutingPolicy: QuotaRoutingPolicy = (context) => ({
  candidates: context.candidates,
});
