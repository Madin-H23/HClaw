/**
 * 快照刷新器 — TTL 可配的懒刷新 + single-flight 防抖（HClaw 原创模块）
 *
 * 刷新策略（推荐方案，票面采纳）：**选路访问时懒刷新**，不做后台定时线程——
 * 与 fail-open 同语义（访问点即降级点，绝不阻塞选路）、免后台任务、不触碰
 * src/index.ts 禁增逻辑红线。并发访问同一供应商时 single-flight 合并成一次
 * 真实查询，防止惊群。
 *
 * 各分支（ADR-0004，全部放行不阻塞）：
 * - 快照新鲜（数据时间 + TTL 未到）→ 原样返回，零网络请求
 * - 快照陈旧 → 懒刷新；刷新成功覆盖落库（数据时间=quota-tool updatedAt）
 * - 刷新失败（不可达/凭证拒绝/ok:false）→ **陈旧快照照用**（其数据时间即
 *   陈旧标注）；无快照 → missing 标记
 * - 供应商未登记映射 / 未登记凭证 → missing（缺省行为，fail-open 放行）
 */
import { logger } from '../logger.js';
import type {
  ProviderQuotaMapping,
  QuotaRouterConfigLoader,
} from './config.js';
import type { QuotaCredentialStore } from './credentials.js';
import {
  queryQuotaTool,
  type QuotaToolEndpoint,
  type QuotaToolOutcome,
} from './quota-tool-client.js';
import {
  QuotaSnapshotStore,
  type MissingQuotaSnapshot,
  type QuotaSnapshotOrMissing,
  type StoredQuotaSnapshot,
} from './snapshot-store.js';
import { normalizeQuotaTier, type TierThresholdTable } from './tiers.js';

export interface QuotaSnapshotRefresherOptions {
  readonly config: QuotaRouterConfigLoader;
  readonly credentials: QuotaCredentialStore;
  readonly snapshots: QuotaSnapshotStore;
  /** 查询函数可注入（测试吃 fake-quota-tool 桩或脚本桩）；缺省走真实 HTTP 客户端 */
  readonly query?: typeof queryQuotaTool;
  /** 可注入时钟（毫秒），缺省 Date.now——测试确定性 */
  readonly nowMs?: () => number;
}

export class QuotaSnapshotRefresher {
  private readonly config: QuotaRouterConfigLoader;
  private readonly credentials: QuotaCredentialStore;
  private readonly snapshots: QuotaSnapshotStore;
  private readonly query: typeof queryQuotaTool;
  private readonly nowMs: () => number;
  /** single-flight：同一供应商在飞的刷新 promise（并发访问合并为一次查询） */
  private readonly inflight = new Map<
    string,
    Promise<QuotaSnapshotOrMissing>
  >();

  constructor(options: QuotaSnapshotRefresherOptions) {
    this.config = options.config;
    this.credentials = options.credentials;
    this.snapshots = options.snapshots;
    this.query = options.query ?? queryQuotaTool;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * 决策层/面板的读入口：新鲜快照直读，陈旧快照懒刷新，无数据 missing。
   * 全部分支返回快照或 missing 标记，不抛异常、不阻塞选路。
   */
  async getSnapshot(providerId: string): Promise<QuotaSnapshotOrMissing> {
    const mapping = this.mappingOf(providerId);
    if (!mapping) return missing(providerId);

    const existing = this.snapshots.get(providerId);
    if (existing && this.ageMs(existing) < this.config.get().snapshotTtlMs) {
      return existing;
    }
    return this.refreshShared(providerId, mapping, existing);
  }

  /** 强制刷新（绕过 TTL；测试与手动排障用），失败分支与懒刷新一致 */
  async refreshNow(providerId: string): Promise<QuotaSnapshotOrMissing> {
    const mapping = this.mappingOf(providerId);
    if (!mapping) return missing(providerId);
    return this.refreshShared(
      providerId,
      mapping,
      this.snapshots.get(providerId),
    );
  }

  // ─── 内部 ─────────────────────────────────────────────────

  private mappingOf(providerId: string): ProviderQuotaMapping | null {
    return this.config.get().providers[providerId] ?? null;
  }

  private ageMs(snapshot: StoredQuotaSnapshot): number {
    return Math.max(0, this.nowMs() - Date.parse(snapshot.fetchedAt));
  }

  /** single-flight 合并：同供应商并发刷新只发起一次真实查询 */
  private refreshShared(
    providerId: string,
    mapping: ProviderQuotaMapping,
    existing: StoredQuotaSnapshot | null,
  ): Promise<QuotaSnapshotOrMissing> {
    const shared = this.inflight.get(providerId);
    if (shared) return shared;

    const promise = this.doRefresh(providerId, mapping, existing).finally(
      () => {
        this.inflight.delete(providerId);
      },
    );
    this.inflight.set(providerId, promise);
    return promise;
  }

  private async doRefresh(
    providerId: string,
    mapping: ProviderQuotaMapping,
    existing: StoredQuotaSnapshot | null,
  ): Promise<QuotaSnapshotOrMissing> {
    const config = this.config.get();
    const record = this.credentials.get(providerId);
    if (!record) {
      logger.warn(
        { providerId, quotaToolProvider: mapping.quotaToolProvider },
        'quota-router credentials not configured; snapshot stays missing (fail-open)',
      );
      return missing(providerId);
    }

    const endpoint: QuotaToolEndpoint = config.quotaTool;
    const outcome = await this.query(
      endpoint,
      record.quotaToolProvider,
      record.credentials,
    );
    if (!outcome.ok) {
      return this.staleOrMissing(providerId, existing, outcome);
    }

    const normalized = normalizeQuotaTier(
      outcome.payload,
      config.tierThresholds as TierThresholdTable,
      mapping.signal,
    );
    if (!normalized) {
      return this.staleOrMissing(providerId, existing, {
        ok: false,
        kind: 'unexpected',
        error: 'quota-tool 响应无法归一化出额度档位',
      });
    }

    const snapshot: StoredQuotaSnapshot = {
      providerId,
      tier: normalized.tier,
      signalKind: normalized.signalKind,
      score: normalized.score,
      fetchedAt: outcome.payload.updatedAt,
      storedAt: new Date(this.nowMs()).toISOString(),
      windows: outcome.payload.windows,
      summary: outcome.payload.summary,
    };
    this.snapshots.upsert(snapshot);
    return snapshot;
  }

  /**
   * fail-open 落点：刷新失败时陈旧快照照用（数据时间即陈旧标注，消费方
   * 按 TTL 自行判断可信度）；无快照则 missing。绝不抛错阻塞选路。
   */
  private staleOrMissing(
    providerId: string,
    existing: StoredQuotaSnapshot | null,
    outcome: Extract<QuotaToolOutcome, { ok: false }>,
  ): QuotaSnapshotOrMissing {
    logger.warn(
      { providerId, kind: outcome.kind, error: outcome.error },
      'quota-router snapshot refresh failed; serving stale snapshot or missing (fail-open)',
    );
    return existing ?? missing(providerId);
  }
}

function missing(providerId: string): MissingQuotaSnapshot {
  return { providerId, missing: true };
}
