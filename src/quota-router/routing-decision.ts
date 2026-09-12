/**
 * 路由决策纯函数 — 额度档位 → 选路 / 降档 / 否决（HClaw 原创模块，SPEC #1 核心 seam）
 *
 * 输入 = 三源统一数据（RoutingQuotaInputs，T4 单点转出）+ 请求上下文（候选集 /
 * Agent 绑定 / 会话粘滞 / admin 放行 / 策略名 / TTL / 注入时钟）；输出 = 路由决策：
 * 选定供应商 | 降档目标 | 否决 | 交上游原生，每个决策附一行中文理由（可解释性是
 * 硬要求，SPEC 用户故事 14）。零 IO、零时钟依赖——时间与 TTL 全部由参数注入，
 * 同输入必同输出（幂等）。
 *
 * 语义（逐条对齐票面 #6 / ADR-0004 fail-open）：
 * - 前置过滤：档位「耗尽」（剩余分低于耗尽阈值）的候选出局，幸存集交上游原生
 *   策略。幸存集形状与 T1 缝对齐：{ candidates: survivors } 即 types.ts 的
 *   QuotaRoutingDecision（toQuotaRoutingDecision 收口），T6 装配时直接喂
 *   QuotaRoutingPolicy。
 * - 绑定否决两级：Agent 显式绑定（上游绑定即权威、绕过池）档位「耗尽」时，先从
 *   候选集按「档位序 + 成本序」找降档目标；降无可降才否决且理由明示额度耗尽；
 *   admin 显式放行只解除否决（降档目标存在时降档优先），放行决策带告警标记，
 *   记账告警由 T6 装配层接手。
 * - 粘滞优先：粘滞供应商档位非「耗尽」不动（决策 = 维持粘滞，幸存集收缩为粘滞
 *   点本身——任何策略下上游都会选它）；「耗尽」才在轮边界迁移。本函数无轮内
 *   概念，只做轮边界决策：迁移目标由上游策略从幸存集选出（round-robin 序号是
 *   上游内部状态，纯函数不越权代选），输出 newStickyFromProviderId 标记供装配
 *   层在上游选定后重设粘滞点。
 * - fail-open 全分支：快照 missing → 该候选放行（缺失不否决）；快照陈旧照用
 *   （标注数据时间与数据年龄）；全部候选 missing → 交上游原生（幸存集全保留、
 *   按档位序+成本序重排——非原样顺序；T6 装配层对此情形另行缝上下文零改动
 *   直通，见 assembly.ts quotaPolicy）；
 *   单价 / 已花成本 / 用户余额缺失只作降级标注不阻塞选路（MVP 硬约束只看档位，
 *   成本维度进 reason 文案）。上游 billing 余额闸是上游自己的 fail-closed 语义，
 *   本函数不建任何余额闸门。
 *
 * 已知取舍（issue #6 追评披露）：
 * - 降档目标排序中快照缺失的候选殿后（降档是连续性关键决策，已知档位优先于
 *   未知）但绝不出局——与 T2 桩 TIER_RANK 的「missing 永不否决」过滤语义不
 *   冲突：此处排的是偏好序，不是准入闸。
 * - 用户余额维度在 MVP 不参与排序与过滤（不造余额闸门前提下无法折算单请求
 *   可负担性），缺失记降级标注；「按用户余额与档位计算 fallback」的余额规则
 *   由装配层/后续票细化，本函数产出的 fallbackSequence 按「档位序+成本序」。
 * - 「同协议」降档在 MVP 由候选集本身保证（SPEC：仅 Anthropic 协议兼容端点
 *   可路由），协议异构适配是 out of scope，字段留待后续票。
 */
import type { ProviderPoolMember } from '../provider-pool.js';
import type { BalancingConfig } from '../runtime-config.js';
import {
  isMissingModelPrice,
  isMissingProviderSpentCost,
  isMissingSnapshot,
  isMissingUserBalance,
  type RoutingQuotaInputs,
} from './routing-inputs.js';
import type { StoredQuotaSnapshot } from './snapshot-store.js';
import { QUOTA_TIER_LABELS, type QuotaTier } from './tiers.js';
import type { QuotaRoutingDecision } from './types.js';

// ─── 输入形状 ────────────────────────────────────────────────

/** 候选输入：供应商池成员（T1 缝候选形状原样）+ 该供应商的三源统一数据（T4） */
export interface QuotaCandidateInput {
  /**
   * 供应商池成员。本函数以 member.profileId 为候选身份键；quota.providerId
   * 应与其同值（RoutingQuotaInputs 契约），不一致视为调用侧装配错误。
   */
  readonly member: ProviderPoolMember;
  /** 三源统一数据（快照 + 单价 + 已花成本 + 用户余额，四槽位四守卫） */
  readonly quota: RoutingQuotaInputs;
}

/** Agent 显式绑定（上游绑定即权威、绕过池，container-runner 既有语义） */
export interface AgentModelBinding {
  /** AgentProfile.model_config_id（上游字段命名；值为供应商池 profileId 同域 id） */
  readonly modelConfigId: string;
  /** 绑定供应商的三源数据；null = 未供给（按快照缺失 fail-open 放行） */
  readonly candidate: QuotaCandidateInput | null;
}

/** 路由决策输入：三源数据 + 请求上下文（全部显式注入，无隐藏读取） */
export interface RoutingDecisionInput {
  /** 上游均衡策略名（幸存集交回上游后由它裁决；reason 文案引用） */
  readonly strategy: BalancingConfig['strategy'];
  /** 候选集：上游健康过滤后的池成员 + 各自三源数据（即 T1 缝收到的上下文候选） */
  readonly candidates: readonly QuotaCandidateInput[];
  /** Agent 显式绑定；null = 未绑定，走池选路（前置过滤 + 粘滞优先） */
  readonly agentBinding: AgentModelBinding | null;
  /** 会话粘滞绑定供应商 id；null = 无粘滞（新会话 / 既有绑定已失效） */
  readonly stickyProviderId: string | null;
  /** admin 显式放行：仅解除「降无可降」的否决；降档目标存在时降档优先 */
  readonly adminOverride: boolean;
  /** 快照 TTL（毫秒）：数据时间超过该值记陈旧；陈旧照用不阻塞（装配侧取配置） */
  readonly snapshotTtlMs: number;
  /** 注入时钟（毫秒时间戳）——纯函数禁止自取时钟 */
  readonly nowMs: number;
}

// ─── 输出形状 ────────────────────────────────────────────────

/** fail-open 降级标注：本次决策吸收的数据缺失/陈旧（机器可读，reason 为人话版） */
export type RoutingDegradation =
  | { readonly kind: 'snapshot-missing'; readonly providerId: string }
  | {
      readonly kind: 'snapshot-stale';
      readonly providerId: string;
      /** 数据年龄（毫秒）；fetchedAt 不可解析时为 -1 */
      readonly ageMs: number;
    }
  | { readonly kind: 'price-missing'; readonly providerId: string }
  | { readonly kind: 'spent-cost-missing'; readonly providerId: string }
  | { readonly kind: 'user-balance-missing'; readonly providerId: string };

/** 决策公共座：幸存集 + 后备序列 + 降级标注 + 一行理由 */
interface RoutingDecisionBase {
  /**
   * 幸存集：额度过滤后可路由的池成员（成员引用原样，绝不复制改写）。
   * T1 缝对齐：{ candidates: survivors } 即 QuotaRoutingDecision——维持粘滞时
   * 收缩为粘滞点本身；绑定路径不做池前置过滤（原样候选）；否决时为空集。
   */
  readonly survivors: readonly ProviderPoolMember[];
  /**
   * 运行中失败的后备序列（SPEC 注入点③）：幸存集按「档位序+成本序」排序的
   * profileId 列表，已剔除本决策点名的主选供应商；主选由上游策略定夺时
   * （native），装配层消费时跳过上游实际选中者。否决时为空。
   */
  readonly fallbackSequence: readonly string[];
  /** fail-open 降级标注（空数组 = 本次决策数据齐全） */
  readonly degradations: readonly RoutingDegradation[];
  /** 一行中文理由（可解释性硬要求：哪一家、哪一档、哪条约束） */
  readonly reason: string;
}

/** 选定供应商：本函数直接点名（维持粘滞 / 绑定放行 / admin 显式放行） */
export interface SelectRoutingDecision extends RoutingDecisionBase {
  readonly kind: 'select';
  readonly providerId: string;
  /** true = 维持既有粘滞（providerId 即粘滞点，无需迁移） */
  readonly stickyKept: boolean;
  /** true = 该放行来自 admin 显式放行（原本会被否决；告警记账由装配层接） */
  readonly adminOverride: boolean;
}

/** 降档目标：绑定供应商额度耗尽时换到的更低成本目标（轮边界行为） */
export interface DowngradeRoutingDecision extends RoutingDecisionBase {
  readonly kind: 'downgrade';
  /** 降档目标供应商 */
  readonly providerId: string;
  /** 被降档的绑定供应商（额度耗尽方） */
  readonly fromProviderId: string;
  /** 新粘滞点：降档目标即该会话新粘滞点（SPEC：轮边界迁移并重设粘滞） */
  readonly newStickyProviderId: string;
}

/** 否决：降无可降，拒绝并明示额度耗尽（绑定否决第二级专属，池路径不否决） */
export interface VetoRoutingDecision extends RoutingDecisionBase {
  readonly kind: 'veto';
  /** 被否决的绑定供应商 */
  readonly providerId: string;
}

/** 交上游原生：幸存集交回上游策略裁决（无粘滞 / 粘滞耗尽迁移 / 数据缺失语境） */
export interface NativeRoutingDecision extends RoutingDecisionBase {
  readonly kind: 'native';
  /**
   * 新粘滞点标记：非 null = 本次决策替换了既有粘滞绑定（粘滞耗尽或已不在
   * 健康候选集），上游从幸存集选定后装配层须把选定者重设为该会话粘滞点；
   * 具体目标由上游策略决定，本函数不越权点名。null = 无粘滞语境。
   */
  readonly newStickyFromProviderId: string | null;
}

/** 路由决策：选定供应商 | 降档目标 | 否决 | 交上游原生 */
export type RoutingDecision =
  | SelectRoutingDecision
  | DowngradeRoutingDecision
  | VetoRoutingDecision
  | NativeRoutingDecision;

// ─── 主入口 ──────────────────────────────────────────────────

/**
 * 路由决策主函数（SPEC #1「路由决策纯函数」缝）。
 * 有 Agent 显式绑定走绑定否决钩子（注入点②），否则走池路径：粘滞优先 +
 * 前置过滤（注入点①）。两条路径互斥（绑定绕过池，container-runner 语义）。
 */
export function decideRouting(input: RoutingDecisionInput): RoutingDecision {
  if (input.agentBinding) {
    return decideBoundPath(input, input.agentBinding);
  }
  return decidePoolPath(input);
}

/**
 * T1 缝对齐：把决策幸存集装进 T1 的 QuotaRoutingDecision 形状。
 * 装配层（T6）把额度策略接到 QuotaRoutingPolicy 时用本函数收口——
 * { candidates: survivors } 与 types.ts 的缝契约逐字段同名。
 */
export function toQuotaRoutingDecision(
  decision: RoutingDecision,
): QuotaRoutingDecision {
  return { candidates: decision.survivors };
}

// ─── 绑定路径（注入点②：绑定否决两级） ─────────────────────

function decideBoundPath(
  input: RoutingDecisionInput,
  binding: AgentModelBinding,
): RoutingDecision {
  const degradations = collectDegradations(input, binding);
  const boundId = binding.modelConfigId;
  const fallback = fallbackSequence(input.candidates, boundId);
  const survivors: readonly ProviderPoolMember[] = input.candidates.map(
    (c) => c.member,
  );

  const snapshot = binding.candidate ? binding.candidate.quota.snapshot : null;
  if (!snapshot || isMissingSnapshot(snapshot)) {
    return {
      kind: 'select',
      providerId: boundId,
      stickyKept: false,
      adminOverride: false,
      survivors,
      fallbackSequence: fallback,
      degradations,
      reason: `绑定放行：供应商 ${boundId} 无额度快照，缺失不否决（fail-open），绑定照常生效`,
    };
  }
  if (snapshot.tier !== 'exhausted') {
    return {
      kind: 'select',
      providerId: boundId,
      stickyKept: false,
      adminOverride: false,
      survivors,
      fallbackSequence: fallback,
      degradations,
      reason: `绑定放行：供应商 ${boundId} 额度档位「${QUOTA_TIER_LABELS[snapshot.tier]}」，绑定照常生效`,
    };
  }
  // 两级否决：先降档（admin 放行只解除否决，不跳过降档），降无可降才落到放行/拒绝
  const target = pickDowngradeTarget(input.candidates);
  if (target) {
    return {
      kind: 'downgrade',
      providerId: target.member.profileId,
      fromProviderId: boundId,
      newStickyProviderId: target.member.profileId,
      survivors,
      fallbackSequence: fallback,
      degradations,
      reason: downgradeReason(boundId, target),
    };
  }
  if (input.adminOverride) {
    return {
      kind: 'select',
      providerId: boundId,
      stickyKept: false,
      adminOverride: true,
      survivors,
      fallbackSequence: fallback,
      degradations,
      reason: `admin 放行：绑定供应商 ${boundId} 额度档位「耗尽」，显式放行并记告警（记账由装配层处理）`,
    };
  }
  return {
    kind: 'veto',
    providerId: boundId,
    survivors: [],
    fallbackSequence: [],
    degradations,
    reason: `额度否决：绑定供应商 ${boundId} 额度档位「耗尽」，候选集内无可用降档目标，降无可降`,
  };
}

// ─── 池路径（注入点①：粘滞优先 + 前置过滤） ────────────────

function decidePoolPath(input: RoutingDecisionInput): RoutingDecision {
  const degradations = collectDegradations(input, null);
  const stickyId = input.stickyProviderId;
  const stickyEntry = stickyId
    ? (input.candidates.find((c) => c.member.profileId === stickyId) ?? null)
    : null;

  if (stickyEntry) {
    const snapshot = stickyEntry.quota.snapshot;
    if (isMissingSnapshot(snapshot) || snapshot.tier !== 'exhausted') {
      return stickyKeptDecision(input, stickyEntry, degradations);
    }
    // 粘滞耗尽：轮边界迁移——幸存集交上游策略裁决，标记装配层重设粘滞点
    const survivorCount = orderSurvivorCandidates(input.candidates).length;
    const tail =
      survivorCount > 0
        ? `轮边界交上游 ${input.strategy} 策略从幸存集（${survivorCount} 家）选定新粘滞点`
        : `幸存集为空，轮边界交上游 ${input.strategy} 策略处置（上游自行兜底）`;
    return nativeDecision(
      input,
      degradations,
      stickyId,
      `粘滞迁移：供应商 ${stickyId} 额度档位「耗尽」，${tail}`,
    );
  }

  if (stickyId) {
    // 粘滞绑定不在健康候选集（已禁用/不健康/已移除）：无法维持，按无粘滞处理
    return nativeDecision(
      input,
      degradations,
      stickyId,
      `粘滞供应商 ${stickyId} 不在健康候选集，按无粘滞处理，交上游 ${input.strategy} 策略选定`,
    );
  }
  return nativeDecision(
    input,
    degradations,
    null,
    nativePreFilterReason(input),
  );
}

/** 维持粘滞：幸存集收缩为粘滞点本身（任何策略下上游都会选它） */
function stickyKeptDecision(
  input: RoutingDecisionInput,
  stickyEntry: QuotaCandidateInput,
  degradations: RoutingDegradation[],
): SelectRoutingDecision {
  const stickyId = stickyEntry.member.profileId;
  const snapshot = stickyEntry.quota.snapshot;
  let reason: string;
  if (isMissingSnapshot(snapshot)) {
    reason = `维持粘滞：供应商 ${stickyId} 无额度快照，缺失不否决（fail-open），无需迁移`;
  } else {
    const tierLabel = QUOTA_TIER_LABELS[snapshot.tier];
    const staleness = stalenessOf(snapshot, input);
    const staleNote = staleness.stale
      ? `；快照已陈旧（数据时间 ${snapshot.fetchedAt}），照用`
      : '';
    reason = `维持粘滞：供应商 ${stickyId} 额度档位「${tierLabel}」，无需迁移${staleNote}`;
  }
  return {
    kind: 'select',
    providerId: stickyId,
    stickyKept: true,
    adminOverride: false,
    survivors: [stickyEntry.member],
    fallbackSequence: fallbackSequence(input.candidates, stickyId),
    degradations,
    reason,
  };
}

function nativeDecision(
  input: RoutingDecisionInput,
  degradations: RoutingDegradation[],
  replacedStickyId: string | null,
  reason: string,
): NativeRoutingDecision {
  const survivorCandidates = orderSurvivorCandidates(input.candidates);
  return {
    kind: 'native',
    newStickyFromProviderId: replacedStickyId,
    survivors: survivorCandidates.map((c) => c.member),
    fallbackSequence: survivorCandidates.map((c) => c.member.profileId),
    degradations,
    reason,
  };
}

function nativePreFilterReason(input: RoutingDecisionInput): string {
  const total = input.candidates.length;
  if (total === 0) {
    return `额度前置过滤：候选集为空，交上游 ${input.strategy} 策略处置`;
  }
  const exhaustedIds = input.candidates
    .filter((c) => {
      const snapshot = c.quota.snapshot;
      return !isMissingSnapshot(snapshot) && snapshot.tier === 'exhausted';
    })
    .map((c) => c.member.profileId);
  if (exhaustedIds.length === 0) {
    const allMissing = input.candidates.every((c) =>
      isMissingSnapshot(c.quota.snapshot),
    );
    return allMissing
      ? `额度快照缺失：${total} 家候选均无快照，全部放行并按档位序+成本序排序，交上游 ${input.strategy} 策略（fail-open）`
      : `额度前置过滤：${total} 家候选均未耗尽，原样交上游 ${input.strategy} 策略`;
  }
  const survivorCount = orderSurvivorCandidates(input.candidates).length;
  return `额度前置过滤：耗尽出局 ${exhaustedIds.join('、')}，幸存 ${survivorCount}/${total} 家交上游 ${input.strategy} 策略`;
}

// ─── 排序与挑选（档位序 + 成本序，同序按入参顺序兜底） ─────

/** 已知档位偏好序：充足 > 紧张 > 临界；快照缺失殿后（仍可选，绝不出局） */
const DOWNGRADE_TIER_RANK: Record<QuotaTier, number> = {
  plenty: 3,
  tight: 2,
  critical: 1,
  exhausted: 0,
};

function downgradeRank(candidate: QuotaCandidateInput): number {
  const snapshot = candidate.quota.snapshot;
  return isMissingSnapshot(snapshot) ? 0 : DOWNGRADE_TIER_RANK[snapshot.tier];
}

/** 成本水平：单价已知 → 输入+输出每百万美元；未知 → Infinity（同档位殿后） */
function costLevel(candidate: QuotaCandidateInput): number {
  const price = candidate.quota.modelPrice;
  return isMissingModelPrice(price)
    ? Number.POSITIVE_INFINITY
    : price.inputCostPerMillion + price.outputCostPerMillion;
}

function isSurvivorCandidate(candidate: QuotaCandidateInput): boolean {
  const snapshot = candidate.quota.snapshot;
  return isMissingSnapshot(snapshot) || snapshot.tier !== 'exhausted';
}

/** 幸存集口径的统一排序：档位序 desc → 成本序 asc → 入参顺序兜底（稳定） */
function orderSurvivorCandidates(
  candidates: readonly QuotaCandidateInput[],
): QuotaCandidateInput[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => isSurvivorCandidate(candidate))
    .sort(
      (a, b) =>
        downgradeRank(b.candidate) - downgradeRank(a.candidate) ||
        costLevel(a.candidate) - costLevel(b.candidate) ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate);
}

/** 降档目标挑选：幸存者按「档位序+成本序」取最优（MVP 硬约束只看档位） */
function pickDowngradeTarget(
  candidates: readonly QuotaCandidateInput[],
): QuotaCandidateInput | null {
  const ordered = orderSurvivorCandidates(candidates);
  return ordered.length > 0 ? ordered[0] : null;
}

/** 后备序列：幸存者统一排序后剔除主选供应商（注入点③的产出） */
function fallbackSequence(
  candidates: readonly QuotaCandidateInput[],
  excludeId: string | null,
): string[] {
  return orderSurvivorCandidates(candidates)
    .map((c) => c.member.profileId)
    .filter((id) => id !== excludeId);
}

// ─── 陈旧判定与降级标注（fail-open 证据链） ─────────────────

interface SnapshotStaleness {
  readonly stale: boolean;
  readonly ageMs: number;
}

/** 陈旧判定：数据时间距注入时钟超过 TTL 即陈旧；fetchedAt 不可解析按陈旧（ageMs=-1） */
function stalenessOf(
  snapshot: StoredQuotaSnapshot,
  input: RoutingDecisionInput,
): SnapshotStaleness {
  const fetchedMs = Date.parse(snapshot.fetchedAt);
  if (Number.isNaN(fetchedMs)) return { stale: true, ageMs: -1 };
  const ageMs = Math.max(0, input.nowMs - fetchedMs);
  return { stale: ageMs > input.snapshotTtlMs, ageMs };
}

function collectDegradations(
  input: RoutingDecisionInput,
  binding: AgentModelBinding | null,
): RoutingDegradation[] {
  const seen = new Set<string>();
  const out: RoutingDegradation[] = [];
  const push = (degradation: RoutingDegradation): void => {
    const key = `${degradation.kind}:${degradation.providerId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(degradation);
  };
  const entries =
    binding && binding.candidate
      ? [...input.candidates, binding.candidate]
      : input.candidates;
  for (const entry of entries) {
    const providerId = entry.member.profileId;
    const { quota } = entry;
    const snapshot = quota.snapshot;
    if (isMissingSnapshot(snapshot)) {
      push({ kind: 'snapshot-missing', providerId });
    } else {
      const staleness = stalenessOf(snapshot, input);
      if (staleness.stale) {
        push({
          kind: 'snapshot-stale',
          providerId,
          ageMs: staleness.ageMs,
        });
      }
    }
    if (isMissingModelPrice(quota.modelPrice)) {
      push({ kind: 'price-missing', providerId });
    }
    if (isMissingProviderSpentCost(quota.spentCost)) {
      push({ kind: 'spent-cost-missing', providerId });
    }
    if (isMissingUserBalance(quota.userBalance)) {
      push({ kind: 'user-balance-missing', providerId });
    }
  }
  return out;
}

// ─── reason 文案（一行中文，可解释性硬要求） ────────────────

function downgradeReason(boundId: string, target: QuotaCandidateInput): string {
  const price = target.quota.modelPrice;
  const priceFragment = isMissingModelPrice(price)
    ? '目标单价未知（不阻塞选路）'
    : `单价 输入 ${price.inputCostPerMillion}/输出 ${price.outputCostPerMillion} 美元每百万 tokens`;
  const snapshot = target.quota.snapshot;
  const tierFragment = isMissingSnapshot(snapshot)
    ? '额度档位未知（快照缺失，fail-open 兜底可选）'
    : `额度档位「${QUOTA_TIER_LABELS[snapshot.tier]}」`;
  return `额度降档：绑定供应商 ${boundId} 额度档位「耗尽」，轮边界降档至 ${target.member.profileId}（${tierFragment}，${priceFragment}），并重设为新粘滞点`;
}
