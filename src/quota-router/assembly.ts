/**
 * 装配模块 — 把 T5 决策函数接进生产选路（T6，SPEC #1 三处注入点，HClaw 原创模块）
 *
 * 本文件是「通电」层：决策逻辑全在 routing-decision.ts（T5）与数据面（T3/T4），
 * 这里只做依赖组装与决策副作用消费（日志/告警/粘滞重设），并经 T1 缝
 * （provider-pool.setQuotaRoutingPolicy）与上游最小 wiring 接入：
 *
 * - 注入点①选路前置过滤：quotaPolicy —— decideRouting 池路径决策经
 *   toQuotaRoutingDecision 收口成 T1 QuotaRoutingPolicy；快照经 T3 refresher
 *   懒刷新（选路访问即刷新点，fire-and-forget 绝不阻塞选路，ADR-0004），
 *   成本/余额经 T4 成本源/余额源组装 RoutingQuotaInputs。
 * - 注入点②绑定否决钩子：bindingGate —— decideRouting 绑定路径决策交给上游
 *   binding 分支消费（降档重指绑定 / 否决拒绝）；admin 显式放行输出结构化
 *   记账告警（一行：providerId/档位/时间戳）。
 * - 注入点③运行中 fallback 源：fallbackModel —— 以 T5 fallbackSequence
 *   （档位序+成本序）为基础、装配层叠余额可负担分段（承接清单 #3：装配层
 *   重算，T5 缝产出不动），映射成上游 MINICLAW_FALLBACK_MODEL 的模型 id。
 * - 粘滞标记消费（T5 移交清单 #2）：bindingGate 消费 newStickyProviderId
 *   （降档 → 经注入的 resetSticky 重设会话粘滞点）；stickyGate 消费
 *   newStickyFromProviderId（池路径粘滞迁移 → 上游选路尾部既有重绑落地）。
 *
 * 失败语义（ADR-0004 fail-open）：本模块公开面绝不抛错——决策/数据任何异常
 * 都折成「不激活」返回值（quotaPolicy 原样放行、gate 返回 null、fallback 返回
 * null），上游调用方按各自的原生行为继续。未配置 quota-router（无映射）时
 * isConfigured()=false，全部入口零工作直通，与 no-op 注入行为逐一同。
 *
 * 上游依赖全部经构造参数注入（可构造可注入，供测试与未来 desktop 装配复用）；
 * 文件尾部才是生产装配工厂（DATA_DIR 约定路径 + 上游既有导出，惰性单例）。
 * 注意：本模块**不**经 quota-router/index.ts barrel 转出——provider-pool 已
 * import 该 barrel，转出会制造 import 环，上游文件直接 import 本文件。
 */
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getUserBalance, setSessionProviderId } from '../db.js';
import { logger } from '../logger.js';
import { providerPool } from '../provider-pool.js';
import type { ProviderPoolMember } from '../provider-pool.js';
import type { BalancingConfig } from '../runtime-config.js';
import {
  getBalancingConfig,
  getEnabledProviders,
  getProviders,
} from '../runtime-config.js';
import {
  CcSwitchCostSource,
  type ModelPriceOrMissing,
  type ProviderSpentCostOrMissing,
} from './cc-switch-cost-source.js';
import {
  DEFAULT_QUOTA_ROUTER_CONFIG,
  QuotaRouterConfigLoader,
} from './config.js';
import {
  BillingBalanceSource,
  type UserBalanceOrMissing,
} from './billing-balance-source.js';
import { QuotaCredentialStore } from './credentials.js';
import { isMissingModelPrice, isMissingSnapshot } from './routing-inputs.js';
import type { RoutingQuotaInputs } from './routing-inputs.js';
import {
  decideRouting,
  toQuotaRoutingDecision,
  type RoutingDecision,
  type RoutingDecisionInput,
  type RoutingDegradation,
} from './routing-decision.js';
import { QuotaSnapshotRefresher } from './refresher.js';
import {
  QuotaSnapshotStore,
  type StoredQuotaSnapshot,
} from './snapshot-store.js';
import { QUOTA_TIER_LABELS } from './tiers.js';
import { emitQuotaTurnCard, type QuotaCardKind } from './turn-cards.js';
import type {
  QuotaRoutingContext,
  QuotaRoutingDecision,
  QuotaRoutingPolicy,
} from './types.js';

// ─── 注入契约（全部可构造可注入） ─────────────────────────────

/** 会话作用域：粘滞重设与 admin 放行探针的最小身份（groupFolder+agentId） */
export interface QuotaSessionScope {
  readonly groupFolder: string;
  readonly agentId?: string | null;
}

/** T4 成本源最小面（装配只需要这两个查询；测试给桩实现即可） */
export interface RoutingCostSource {
  getModelPrice(modelId: string): ModelPriceOrMissing;
  getProviderSpentCost(providerId: string): ProviderSpentCostOrMissing;
}

/** T4 余额源最小面（上游 billing 只读消费） */
export interface RoutingBalanceSource {
  getUserBalance(userId: string): UserBalanceOrMissing;
}

/** 粘滞重设回调：生产传上游 db.setSessionProviderId（上游既有函数，语义原样） */
export type StickyResetWriter = (
  scope: QuotaSessionScope,
  providerId: string,
) => void;

/** admin 显式放行探针：生产接线为 quota-router.json 的 adminOverride 旋钮（缺省 false） */
export type AdminOverrideProbe = (
  scope: QuotaSessionScope,
  providerId: string,
) => boolean;

export interface QuotaRouterAssemblyOptions {
  readonly config: QuotaRouterConfigLoader;
  readonly snapshots: QuotaSnapshotStore;
  readonly refresher: QuotaSnapshotRefresher;
  readonly costSource: RoutingCostSource;
  readonly balanceSource: RoutingBalanceSource;
  /** 供应商池 profileId → 该供应商服务的模型 id（无模型配置返回 null） */
  readonly modelIdOf: (profileId: string) => string | null;
  /** 会话级决策（gate/fallback）的候选集；池路径策略用 T1 缝自带候选 */
  readonly listCandidates: () => readonly ProviderPoolMember[];
  /** 粘滞重设（降档消费 newStickyProviderId 的落点） */
  readonly resetSticky: StickyResetWriter;
  /** 会话级决策引用的均衡策略名（池路径策略用 T1 缝自带 strategy） */
  readonly strategyOf: () => BalancingConfig['strategy'];
  readonly adminOverrideProbe?: AdminOverrideProbe;
  /** 可注入时钟（毫秒）；纯决策层同样吃注入时钟，测试确定性 */
  readonly nowMs?: () => number;
}

/** 注入点②产出：null = quota-router 未激活/异常（上游按原样放行处理） */
export type BindingGateVerdict =
  | {
      readonly action: 'allow';
      readonly providerId: string;
      readonly reason: string;
    }
  | {
      readonly action: 'downgrade';
      readonly providerId: string;
      readonly fromProviderId: string;
      /** 新粘滞点（T5 决策字段原样；装配层已在决策消费时重设粘滞） */
      readonly newStickyProviderId: string;
      readonly reason: string;
    }
  | {
      readonly action: 'veto';
      readonly providerId: string;
      readonly reason: string;
    };

/** 粘滞闸产出：keep = 维持粘滞复用；migrate = 额度耗尽轮边界迁移 */
export type StickyGateVerdict = 'keep' | 'migrate';

// ─── 装配类 ──────────────────────────────────────────────────

export class QuotaRouterAssembly {
  private readonly options: QuotaRouterAssemblyOptions;
  private readonly nowMs: () => number;

  constructor(options: QuotaRouterAssemblyOptions) {
    this.options = options;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** 未配置映射 = 全链零工作直通（缺省不激活，上游行为不变） */
  isConfigured(): boolean {
    return Object.keys(this.options.config.get().providers).length > 0;
  }

  // ─── 注入点①：选路前置过滤（T1 缝宿主） ─────────────────────

  /**
   * T1 QuotaRoutingPolicy：decideRouting 池路径（粘滞不在缝层——上游 sticky
   * 复用发生在 selectProvider 之前，会话级粘滞决策走 stickyGate）。快照经
   * refresher 懒刷新 fire-and-forget（#4 AC4：refresher 接入选路路径），
   * 决策用最近一次落库快照（陈旧照用，ADR-0004）。任何异常 → 原样放行。
   *
   * 候选集一律以缝上下文 context.candidates 为准（上游健康过滤后的幸存者，
   * QuotaRoutingContext 契约）——绝不经 listCandidates 重建，否则不健康候选
   * 会回流击穿上游熔断语义。幸存集是 context.candidates 的子集。
   */
  readonly quotaPolicy: QuotaRoutingPolicy = (
    context: QuotaRoutingContext,
  ): QuotaRoutingDecision => {
    if (!this.isConfigured()) return context;
    try {
      const candidates = context.candidates.map((member) => ({
        member,
        quota: this.inputFor(member.profileId, null),
      }));
      // 全部候选无任何额度快照 → 真等价无额度感知：原样直通（同引用），
      // 连幸存集排序都不做——T5 native 路径此时会按档位序+成本序重排，
      // 缺额度数据语境下那是无依据的排序，与「上游行为不变」不符。
      if (
        candidates.length === 0 ||
        candidates.every((c) => isMissingSnapshot(c.quota.snapshot))
      ) {
        logger.debug(
          { strategy: context.strategy, candidates: candidates.length },
          'quota-router 全部候选无额度快照，缝上下文原样直通（fail-open）',
        );
        return context;
      }
      const decision = decideRouting({
        strategy: context.strategy,
        candidates,
        agentBinding: null,
        stickyProviderId: null,
        adminOverride: false,
        snapshotTtlMs: this.options.config.get().snapshotTtlMs,
        nowMs: this.nowMs(),
      });
      this.logDecision('pool-pre-filter', decision);
      return toQuotaRoutingDecision(decision);
    } catch (err) {
      this.warnFailOpen('quotaPolicy', err);
      return context;
    }
  };

  // ─── 注入点②：绑定否决钩子 ─────────────────────────────────

  /**
   * Agent 绑定（含系统默认绑定）的额度否决两级：先降档（重指绑定并重设
   * 粘滞点），降无可降才否决；admin 显式放行解除否决并出记账告警。
   * 返回 null = 未激活/异常 → 上游按原样放行（fail-open）。
   */
  bindingGate(
    scope: QuotaSessionScope,
    boundProviderId: string,
  ): BindingGateVerdict | null {
    if (!this.isConfigured()) return null;
    try {
      const candidates = this.buildCandidateInputs(null);
      const boundMember = candidates.find(
        (c) => c.member.profileId === boundProviderId,
      )?.member ?? {
        profileId: boundProviderId,
        weight: 1,
        enabled: true,
      };
      const decision = decideRouting({
        strategy: this.options.strategyOf(),
        candidates,
        agentBinding: {
          modelConfigId: boundProviderId,
          candidate: {
            member: boundMember,
            quota: this.inputFor(boundProviderId, null),
          },
        },
        stickyProviderId: null,
        adminOverride:
          this.options.adminOverrideProbe?.(scope, boundProviderId) ?? false,
        snapshotTtlMs: this.options.config.get().snapshotTtlMs,
        nowMs: this.nowMs(),
      });
      this.logDecision('binding-gate', decision);
      this.emitBindingTurnCard(scope, decision);

      if (decision.kind === 'downgrade') {
        // 消费 newStickyProviderId（T5 移交清单 #2）：降档目标即新粘滞点。
        // 重设失败不阻塞降档（上游 binding 分支的既有重绑随后落同值兜底）。
        try {
          this.options.resetSticky(scope, decision.newStickyProviderId);
        } catch (err) {
          this.warnFailOpen('resetSticky(downgrade)', err);
        }
        return {
          action: 'downgrade',
          providerId: decision.providerId,
          fromProviderId: decision.fromProviderId,
          newStickyProviderId: decision.newStickyProviderId,
          reason: decision.reason,
        };
      }
      if (decision.kind === 'select') {
        if (decision.adminOverride) {
          // 记账告警（SPEC 注入点②）：一行结构化日志，含 providerId/档位/时间戳
          logger.warn(
            {
              providerId: decision.providerId,
              tier: this.boundTierOf(boundProviderId),
              at: new Date(this.nowMs()).toISOString(),
              adminOverride: true,
            },
            '额度记账告警：admin 显式放行额度耗尽的绑定供应商',
          );
        }
        return {
          action: 'allow',
          providerId: decision.providerId,
          reason: decision.reason,
        };
      }
      if (decision.kind === 'veto') {
        return {
          action: 'veto',
          providerId: decision.providerId,
          reason: decision.reason,
        };
      }
      // native 决策在绑定路径类型上不可能出现（decideBoundPath 不产 native）；
      // 类型兜底按未激活处理（fail-open 原样放行）
      return null;
    } catch (err) {
      this.warnFailOpen('bindingGate', err);
      return null;
    }
  }

  // ─── A4：粘滞迁移闸（池路径粘滞标记消费） ───────────────────

  /**
   * 会话粘滞供应商是否应在本轮边界迁移：decideRouting 池路径以粘滞入参
   * 裁决——维持粘滞 → 'keep'（上游照旧复用）；native（粘滞耗尽迁移，带
   * newStickyFromProviderId 标记）→ 'migrate'（上游跳过粘滞复用落池选路，
   * 选路尾部既有 setSessionProviderId 重绑即完成重设）。
   * null = 未激活/异常 → 维持上游原样（复用粘滞）。
   */
  stickyGate(
    scope: QuotaSessionScope,
    stickyProviderId: string,
  ): StickyGateVerdict | null {
    if (!this.isConfigured()) return null;
    try {
      const decision = decideRouting({
        strategy: this.options.strategyOf(),
        candidates: this.buildCandidateInputs(null),
        agentBinding: null,
        stickyProviderId,
        adminOverride: false,
        snapshotTtlMs: this.options.config.get().snapshotTtlMs,
        nowMs: this.nowMs(),
      });
      this.logDecision('sticky-gate', decision);
      if (decision.kind === 'select' && decision.stickyKept) return 'keep';
      if (decision.kind === 'native') return 'migrate';
      // 池路径不该出现 select(非 kept)/downgrade/veto：保守维持粘滞
      return 'keep';
    } catch (err) {
      this.warnFailOpen('stickyGate', err);
      return null;
    }
  }

  // ─── 注入点③：运行中 fallback 源（按余额与档位的降档序列） ──

  /**
   * 上游 MINICLAW_FALLBACK_MODEL 的新源：以 T5 fallbackSequence（档位序+
   * 成本序，T5 缝产出原样）为基础，装配层叠「余额可负担」分段（承接清单
   * #3 落点二选一取装配层重算，不改 T5 排序语义）：
   * - 余额已知：单模型输入+输出每百万成本 ≤ 余额者属可负担段；单价缺失属
   *   未知段（fail-open 只排序不剔除，绝不造余额闸门）；已知超支殿后。
   * - 余额缺失：与 T5 fallbackSequence 同序（等价无余额维度）。
   * 然后剔除「当前主选模型自身」与无模型 id 的条目，取队头模型 id。
   * null = 未激活/序列为空 → 上游回退 SystemSettings 单值（fail-open）。
   *
   * 已知取舍：MINICLAW_FALLBACK_MODEL 在 agent-runner 内是「同端点换模型」
   * 语义，跨供应商条目是否在当前端点可用无法静态验证——与上游全局单值的
   * 约束同类（admin 手填单值同样只对部分端点有效），MVP 不做端点可用性
   * 校验（已记入 issue #7 证据评论的取舍论证）。
   */
  fallbackModel(input: {
    readonly excludeModelId?: string | null;
    readonly balanceUserId?: string | null;
  }): string | null {
    if (!this.isConfigured()) return null;
    try {
      // 同一 userId 的余额每决策只取一次（上游 getUserBalance auto-init 有
      // 写放大，且多候选各取一次是 N+1 浪费）
      const balance = input.balanceUserId
        ? this.options.balanceSource.getUserBalance(input.balanceUserId)
        : null;
      const decision = decideRouting({
        strategy: this.options.strategyOf(),
        candidates: this.buildCandidateInputs(balance),
        agentBinding: null,
        stickyProviderId: null,
        adminOverride: false,
        snapshotTtlMs: this.options.config.get().snapshotTtlMs,
        nowMs: this.nowMs(),
      });
      const ordered = this.rebandByAffordability(
        decision.fallbackSequence,
        balance,
      );
      const modelId = ordered
        .map((id) => this.options.modelIdOf(id))
        .find(
          (candidate) =>
            !!candidate &&
            (!input.excludeModelId || candidate !== input.excludeModelId),
        );
      if (!modelId) return null;
      logger.debug(
        {
          sequence: ordered,
          excludeModelId: input.excludeModelId ?? null,
          balanceUserId: input.balanceUserId ?? null,
        },
        'quota-router fallback 源：按余额与档位计算的降档序列取队头',
      );
      return modelId;
    } catch (err) {
      this.warnFailOpen('fallbackModel', err);
      return null;
    }
  }

  // ─── 内部：输入组装与决策消费 ───────────────────────────────

  /**
   * 会话内提示卡片（T7）：绑定路径三类决策各发一张——降档/否决/admin 放行，
   * 徽标+一行 reason（T5 透传）；数据时间取被否决/被降档供应商快照的
   * fetchedAt（可选展示）。普通绑定放行不发卡（无事件发生）。
   * fire-and-forget：卡片任何失败由 turn-cards 内部吸收，绝不影响裁决返回。
   */
  private emitBindingTurnCard(
    scope: QuotaSessionScope,
    decision: RoutingDecision,
  ): void {
    let kind: QuotaCardKind | null;
    let exhaustedId: string;
    if (decision.kind === 'downgrade') {
      kind = 'downgrade';
      exhaustedId = decision.fromProviderId;
    } else if (decision.kind === 'veto') {
      kind = 'veto';
      exhaustedId = decision.providerId;
    } else if (decision.kind === 'select' && decision.adminOverride) {
      kind = 'override-allow';
      exhaustedId = decision.providerId;
    } else {
      return;
    }
    const snapshot = this.options.snapshots.get(exhaustedId);
    const dataTime =
      snapshot && !isMissingSnapshot(snapshot)
        ? (snapshot as StoredQuotaSnapshot).fetchedAt
        : null;
    void emitQuotaTurnCard({ scope, kind, reason: decision.reason, dataTime });
  }

  // ─── 额度面板只读口径（T7） ─────────────────────────────────

  /**
   * 面板单条目快照读取：同步直读快照库 + refresher 懒刷新 fire-and-forget
   * （面板访问点即刷新点，与选路 inputFor 同一语义，绝不等待网络）。
   * stale/ageMs 以注入时钟与配置 TTL 裁决（陈旧照用，只标注——ADR-0004）。
   */
  panelEntry(providerId: string): {
    snapshot: StoredQuotaSnapshot | null;
    stale: boolean;
    ageMs: number | null;
  } {
    void this.options.refresher.getSnapshot(providerId).catch(() => {});
    const snapshot = this.options.snapshots.get(providerId);
    const fetchedMs = snapshot ? Date.parse(snapshot.fetchedAt) : NaN;
    const ageMs = Number.isFinite(fetchedMs)
      ? Math.max(0, this.nowMs() - fetchedMs)
      : null;
    const ttlMs = this.options.config.get().snapshotTtlMs;
    return {
      snapshot,
      ageMs,
      stale: ageMs !== null && ageMs > ttlMs,
    };
  }

  /**
   * 三源统一输入组装（T4 四槽位）：快照槽位 = 同步直读快照库 + refresher
   * 懒刷新 fire-and-forget（访问点即刷新点，刷新结果供下一轮决策，选路
   * 永不等待网络——ADR-0004）；成本/余额槽位缺失由各源自带 missing 表示。
   */
  private inputFor(
    providerId: string,
    balance: UserBalanceOrMissing | null,
  ): RoutingQuotaInputs {
    // refresher 生产接线（#4 AC4 兑现点）：选路路径上真实调用 getSnapshot，
    // 新鲜直读/陈旧懒刷新/失败折 missing，全部在其内部吸收（绝不 reject）
    void this.options.refresher.getSnapshot(providerId).catch(() => {});
    const snapshot = this.options.snapshots.get(providerId);
    const modelId = this.options.modelIdOf(providerId);
    return {
      providerId,
      snapshot: snapshot ?? { providerId, missing: true },
      modelPrice: modelId
        ? this.options.costSource.getModelPrice(modelId)
        : { modelId: '', missing: true },
      spentCost: this.options.costSource.getProviderSpentCost(providerId),
      userBalance: balance ?? { userId: '', missing: true },
    };
  }

  private buildCandidateInputs(
    balance: UserBalanceOrMissing | null,
  ): RoutingDecisionInput['candidates'] {
    return this.options.listCandidates().map((member) => ({
      member,
      quota: this.inputFor(member.profileId, balance),
    }));
  }

  /** 绑定供应商当前档位（记账告警字段；无快照 = unknown） */
  private boundTierOf(providerId: string): string {
    const snapshot = this.options.snapshots.get(providerId);
    if (!snapshot || isMissingSnapshot(snapshot)) return 'unknown';
    return QUOTA_TIER_LABELS[snapshot.tier];
  }

  /**
   * 余额可负担分段（稳定三分段，不改同段相对序）：
   * 0 = 单价已知且 ≤ 余额；1 = 单价未知（fail-open 居中）；2 = 已知超支。
   * 余额缺失 → 全 0（与 T5 fallbackSequence 同序）。
   */
  private rebandByAffordability(
    sequence: readonly string[],
    balance: UserBalanceOrMissing | null,
  ): string[] {
    const balanceUsd =
      balance && !('missing' in balance) ? balance.balance_usd : null;
    if (balanceUsd === null) return [...sequence];
    const rankOf = (providerId: string): number => {
      const modelId = this.options.modelIdOf(providerId);
      const price = modelId
        ? this.options.costSource.getModelPrice(modelId)
        : null;
      if (!price || isMissingModelPrice(price)) return 1;
      const perMillion = price.inputCostPerMillion + price.outputCostPerMillion;
      return perMillion <= balanceUsd ? 0 : 2;
    };
    return sequence
      .map((id, index) => ({ id, index, rank: rankOf(id) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.id);
  }

  /**
   * 决策审计一行日志（SPEC 用户故事 14）：kind/主选/幸存集/后备序列/
   * 降级标注（陈旧条目带 ageMs 与数据时间——T5 移交清单 #4）/一行理由。
   */
  private logDecision(surface: string, decision: RoutingDecision): void {
    logger.info(
      {
        surface,
        kind: decision.kind,
        providerId: 'providerId' in decision ? decision.providerId : null,
        newStickyFromProviderId:
          decision.kind === 'native' ? decision.newStickyFromProviderId : null,
        newStickyProviderId:
          decision.kind === 'downgrade' ? decision.newStickyProviderId : null,
        survivors: decision.survivors.map((m) => m.profileId),
        fallbackSequence: [...decision.fallbackSequence],
        degradations: decision.degradations.map((d) =>
          this.degradationForLog(d),
        ),
        reason: decision.reason,
      },
      'quota-router 路由决策',
    );
  }

  /** 降级标注补数据时间（陈旧标注的 ageMs 为决策层产出，-1 = 时间不可解析） */
  private degradationForLog(
    degradation: RoutingDegradation,
  ): Record<string, unknown> {
    const snapshot = this.options.snapshots.get(degradation.providerId);
    const dataTime =
      snapshot && !isMissingSnapshot(snapshot)
        ? (snapshot as StoredQuotaSnapshot).fetchedAt
        : null;
    if (degradation.kind === 'snapshot-stale') {
      return {
        kind: degradation.kind,
        providerId: degradation.providerId,
        ageMs: degradation.ageMs,
        dataTime,
      };
    }
    return {
      kind: degradation.kind,
      providerId: degradation.providerId,
      dataTime,
    };
  }

  private warnFailOpen(surface: string, err: unknown): void {
    logger.warn(
      { surface, err: err instanceof Error ? err.message : String(err) },
      'quota-router assembly failed; failing open (ADR-0004)',
    );
  }
}

// ─── 生产装配工厂（上游 wiring 的唯一取用点） ─────────────────
//
// 上游文件只允许「取注入对象→调用→返回」级 wiring；这里把「注入对象」的
// 构造收拢到 quota-router 模块内：DATA_DIR 约定路径（配置 data/config/
// quota-router.json、加密凭证 data/config/quota-router-credentials.json、
// 独立快照库 data/db/quota-router.db，ADR-0006）+ 上游既有导出
// （getProviders / getEnabledProviders / getUserBalance / setSessionProviderId）。
// 惰性单例：首次取用时才建（SQLite/加密存储不进 import 副作用）；
// 构造失败降级为永久 null（全链不激活，上游行为不变，日志明示）。

export interface QuotaRouterFacade {
  /** 把注入点①策略挂上上游 provider 池单例（幂等；一次装配全程有效） */
  ensureInstalled(): void;
  bindingGate(
    groupFolder: string,
    agentId: string | null | undefined,
    boundProviderId: string,
  ): BindingGateVerdict | null;
  stickyGate(
    groupFolder: string,
    agentId: string | null | undefined,
    stickyProviderId: string,
  ): StickyGateVerdict | null;
  fallbackModel(input: {
    excludeModelId?: string | null;
    balanceUserId?: string | null;
  }): string | null;
  /** 额度面板只读取数（T7）：不暴露任何凭证；未配置时 entries 全部 mapped=false */
  quotaPanel(): QuotaPanelData;
}

/** 额度面板条目（T7）：快照或缺失 + 陈旧标注（展示口径由 routes/quota.ts 组装） */
export interface QuotaPanelEntry {
  readonly providerId: string;
  /** 是否已在 quota-router.json 登记额度源映射 */
  readonly mapped: boolean;
  /** 已落库快照；null = 无快照（未刷新过/刷新失败/构造降级），消费侧降级展示 */
  readonly snapshot: StoredQuotaSnapshot | null;
  /** 数据时间超过 TTL（陈旧照用，只标注——ADR-0004） */
  readonly stale: boolean;
  /** 数据年龄（毫秒）；fetchedAt 不可解析时 null */
  readonly ageMs: number | null;
}

export interface QuotaPanelData {
  readonly configured: boolean;
  readonly snapshotTtlMs: number;
  readonly entries: readonly QuotaPanelEntry[];
}

/**
 * 面板数据组装（纯函数，facade 与测试共用）：供应商全集 = 供应商池 ∪ 已登记
 * 映射；panelEntryOf 返回 null = 重件装配不可用（构造降级）→ 快照槽位按缺失。
 */
export function buildQuotaPanelData(input: {
  readonly mappedProviders: Readonly<Record<string, unknown>>;
  readonly snapshotTtlMs: number;
  readonly poolProviderIds: readonly string[];
  readonly panelEntryOf: (providerId: string) => {
    snapshot: StoredQuotaSnapshot | null;
    stale: boolean;
    ageMs: number | null;
  } | null;
}): QuotaPanelData {
  const mappedIds = Object.keys(input.mappedProviders);
  const ids = [...new Set([...input.poolProviderIds, ...mappedIds])].sort();
  const entries = ids.map((providerId) => ({
    providerId,
    mapped: mappedIds.includes(providerId),
    ...(input.panelEntryOf(providerId) ?? {
      snapshot: null,
      stale: false,
      ageMs: null,
    }),
  }));
  return {
    configured: mappedIds.length > 0,
    snapshotTtlMs: input.snapshotTtlMs,
    entries,
  };
}

let productionFacade: QuotaRouterFacade | null | undefined;

/** 生产装配取用点（惰性单例；构造失败返回 null 并降级为原生选路） */
export function getQuotaRouterFacade(): QuotaRouterFacade | null {
  if (productionFacade !== undefined) return productionFacade;
  try {
    productionFacade = buildProductionFacade();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'quota-router assembly init failed; routing stays native (fail-open)',
    );
    productionFacade = null;
  }
  return productionFacade;
}

function buildProductionFacade(): QuotaRouterFacade {
  // 轻量件（配置装载）先建；重量级装配（快照库连接/刷新器/成本源）惰性到
  // 「确有映射配置」的首次使用才建——未激活态零句柄（测试环境对临时
  // DATA_DIR 做 rmSync 清理时，不因打开中的 SQLite 文件而 EPERM）
  const config = new QuotaRouterConfigLoader(
    path.join(DATA_DIR, 'config', 'quota-router.json'),
  );
  const isConfigured = () => Object.keys(config.get().providers).length > 0;

  let assembly: QuotaRouterAssembly | null = null;
  // 重件构造失败态记忆（P1-2）：构造可抛（快照库打不开/磁盘故障等），
  // 就地吸收——记一条 WARN 后按「未激活」处理，进程内不再重试重抛刷屏，
  // 四个 facade 入口统一 fail-open（ADR-0004：绝不因 quota-router 拒绝服务）
  let assemblyBroken = false;
  const getAssembly = (): QuotaRouterAssembly | null => {
    if (assembly) return assembly;
    if (assemblyBroken) return null;
    try {
      const credentials = new QuotaCredentialStore(
        path.join(DATA_DIR, 'config', 'quota-router-credentials.json'),
      );
      const snapshots = new QuotaSnapshotStore(
        path.join(DATA_DIR, 'db', 'quota-router.db'),
      );
      const built = new QuotaRouterAssembly({
        config,
        snapshots,
        refresher: new QuotaSnapshotRefresher({
          config,
          credentials,
          snapshots,
        }),
        costSource: new CcSwitchCostSource(),
        balanceSource: new BillingBalanceSource({
          readBalance: (userId: string) => getUserBalance(userId),
        }),
        modelIdOf: (profileId) =>
          getProviders().find((p) => p.id === profileId)?.anthropicModel ||
          null,
        listCandidates: () =>
          getEnabledProviders().map((p) => ({
            profileId: p.id,
            weight: p.weight,
            enabled: p.enabled,
          })),
        resetSticky: (scope, providerId) =>
          setSessionProviderId(scope.groupFolder, scope.agentId, providerId),
        strategyOf: () => getBalancingConfig().strategy,
        // C 补口（票 #8）：adminOverride 旋钮即生产放行探针——true 时放行被
        // 否决绑定（降档优先）并走既有记账告警 + 「额度放行」卡片；热生效
        // （config.get() 按 mtime 重读）
        adminOverrideProbe: () => config.get().adminOverride,
      });
      assembly = built;
      return built;
    } catch (err) {
      assemblyBroken = true;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'quota-router 装配构造失败（快照库/凭证不可用）；额度路由保持未激活（fail-open，进程内不再重试）',
      );
      return null;
    }
  };

  let installed = false;
  return {
    ensureInstalled() {
      if (installed) return;
      installed = true;
      // 挂上池的策略自带「未配置/构造失败直通」守卫：不激活时零装配、零句柄
      providerPool.setQuotaRoutingPolicy((context) =>
        isConfigured()
          ? (getAssembly()?.quotaPolicy(context) ?? context)
          : context,
      );
      logger.info(
        {
          mappedProviders: Object.keys(config.get().providers).length,
        },
        'quota-router 装配完成：额度前置过滤已挂上 provider 池（T6 注入点①）',
      );
    },
    bindingGate: (groupFolder, agentId, boundProviderId) =>
      isConfigured()
        ? (getAssembly()?.bindingGate(
            { groupFolder, agentId },
            boundProviderId,
          ) ?? null)
        : null,
    stickyGate: (groupFolder, agentId, stickyProviderId) =>
      isConfigured()
        ? (getAssembly()?.stickyGate(
            { groupFolder, agentId },
            stickyProviderId,
          ) ?? null)
        : null,
    fallbackModel: (input) =>
      isConfigured() ? (getAssembly()?.fallbackModel(input) ?? null) : null,
    quotaPanel: () =>
      buildQuotaPanelData({
        mappedProviders: config.get().providers,
        snapshotTtlMs: config.get().snapshotTtlMs,
        poolProviderIds: getProviders().map((p) => p.id),
        // 构造降级（assemblyBroken）→ panelEntryOf=null → 快照按缺失展示
        panelEntryOf: (providerId) =>
          getAssembly()?.panelEntry(providerId) ?? null,
      }),
  };
}

// ─── 上游 wiring 门面（container-runner 的「取注入对象→调用→返回」面） ──

/** 幂等装配：把注入点①策略挂上 provider 池（未激活也挂——no-op 等价） */
export function ensureQuotaRoutingInstalled(): void {
  getQuotaRouterFacade()?.ensureInstalled();
}

/**
 * 注入点②：绑定否决钩子。null = quota-router 未激活（上游原样放行）。
 */
export function quotaBindingGate(
  groupFolder: string,
  agentId: string | null | undefined,
  boundProviderId: string,
): BindingGateVerdict | null {
  return (
    getQuotaRouterFacade()?.bindingGate(
      groupFolder,
      agentId,
      boundProviderId,
    ) ?? null
  );
}

/**
 * A4：粘滞迁移闸。null = quota-router 未激活（上游原样复用粘滞）。
 */
export function quotaStickyGate(
  groupFolder: string,
  agentId: string | null | undefined,
  stickyProviderId: string,
): StickyGateVerdict | null {
  return (
    getQuotaRouterFacade()?.stickyGate(
      groupFolder,
      agentId,
      stickyProviderId,
    ) ?? null
  );
}

/**
 * 注入点③：运行中 fallback 源。null = 未激活/序列为空（上游回退
 * SystemSettings 单值）。
 */
export function quotaFallbackModel(input: {
  excludeModelId?: string | null;
  balanceUserId?: string | null;
}): string | null {
  return getQuotaRouterFacade()?.fallbackModel(input) ?? null;
}

/**
 * 额度面板只读取数（T7，src/routes/quota.ts 取用点）。装配构造失败时降级为
 * 「未配置 + 池供应商全部缺快照」（fail-open：面板永不因 quota-router 异常
 * 报错，只降级展示）。
 */
export function quotaPanelData(): QuotaPanelData {
  return (
    getQuotaRouterFacade()?.quotaPanel() ?? {
      configured: false,
      snapshotTtlMs: DEFAULT_QUOTA_ROUTER_CONFIG.snapshotTtlMs,
      entries: getProviders().map((p) => ({
        providerId: p.id,
        mapped: false,
        snapshot: null,
        stale: false,
        ageMs: null,
      })),
    }
  );
}
