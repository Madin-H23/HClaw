/**
 * 假快照生成器 — 按意图产出额度快照（T2 测试基座，SPEC #1 mock 桩前置票）
 *
 * 快照的生产类型尚未在 src/quota-router 落地（T1 仅立缝，本票不改生产代码），
 * 故先在测试侧定义草稿形态，后续票落地生产快照类型时以此对齐。
 *
 * 意图三轴（对齐票面 AC）：
 * - 额度档位：充足 / 紧张 / 临界 / 耗尽（CONTEXT.md 统一四档标尺）
 * - 数据时间新旧：ageMs > 0 即陈旧快照（ADR-0004：陈旧照用，不阻塞选路）
 * - 数据源缺失：makeMissingSnapshot 产出缺席标记（fail-open，不否决）
 *
 * 异构信号三类入档样本，逐字段对齐真实 providers/*.mjs 的窗口形态：
 * - absolute   → 火山 AFP 绝对额度窗口（total/used/remaining 具数，unit 'AFP'）
 * - percentage → OpenCode 整数百分比窗口（total 100、remaining = 100-pct，unit '%'）
 * - currency   → DeepSeek 美元余额（windows 为空、summary 承载余额数值）
 * 档位对应的数值是确定性样本（TIER_SAMPLE_*），非官方阈值——阈值归后续票的
 * 配置化归一化逻辑裁决。
 */
export const QUOTA_TIERS = [
  'plenty',
  'tight',
  'critical',
  'exhausted',
] as const;
export type QuotaTier = (typeof QUOTA_TIERS)[number];

/** 四档中文标签（面板展示口径，CONTEXT.md） */
export const QUOTA_TIER_LABELS: Record<QuotaTier, string> = {
  plenty: '充足',
  tight: '紧张',
  critical: '临界',
  exhausted: '耗尽',
};

export type QuotaSignalKind = 'absolute' | 'percentage' | 'currency';

/** 四档确定性样本：已用百分比（0-100，语义同真实实现的 percentage=已用占比） */
export const TIER_SAMPLE_USED_PERCENTAGE: Record<QuotaTier, number> = {
  plenty: 10,
  tight: 75,
  critical: 96,
  exhausted: 100,
};

/** 四档确定性样本：美元余额（对齐 DeepSeek balance-only 形态） */
export const TIER_SAMPLE_USD_BALANCE: Record<QuotaTier, number> = {
  plenty: 100,
  tight: 15,
  critical: 3,
  exhausted: 0,
};

const ABSOLUTE_SAMPLE_TOTAL = 500_000;
const RESET_IN_MS = 5 * 60 * 60 * 1000;

/** 快照窗口：七字段契约与统一响应契约一致，数值字段允许 null */
export interface QuotaSnapshotWindow {
  readonly label: string;
  readonly total: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly percentage: number | null;
  readonly resetAt: string | null;
  readonly unit: string;
}

export interface QuotaSnapshotSummaryItem {
  readonly label: string;
  readonly value: string | number;
}

/** 额度快照（HClaw 侧缓存形态草稿）：fetchedAt 即「数据时间」 */
export interface FakeQuotaSnapshot {
  readonly providerId: string;
  readonly tier: QuotaTier;
  readonly signalKind: QuotaSignalKind;
  readonly fetchedAt: string;
  readonly windows: readonly QuotaSnapshotWindow[];
  readonly summary: readonly QuotaSnapshotSummaryItem[];
}

/** 数据源缺失标记：无窗口无汇总，选路侧应按 fail-open 处理（ADR-0004） */
export interface MissingQuotaSnapshot {
  readonly providerId: string;
  readonly missing: true;
}

export type QuotaSnapshotOrMissing = FakeQuotaSnapshot | MissingQuotaSnapshot;

export interface SnapshotIntent {
  readonly tier: QuotaTier;
  /** 异构信号类别，默认 'absolute' */
  readonly signal?: QuotaSignalKind;
  /** 快照陈旧量（毫秒），默认 0（新鲜） */
  readonly ageMs?: number;
  /** 可注入时钟（毫秒时间戳），默认 Date.now()——保证测试确定性 */
  readonly now?: number;
}

export function makeQuotaSnapshot(
  providerId: string,
  intent: SnapshotIntent,
): FakeQuotaSnapshot {
  const signal = intent.signal ?? 'absolute';
  const now = intent.now ?? Date.now();
  const fetchedAtMs = now - (intent.ageMs ?? 0);
  const usedPercentage = TIER_SAMPLE_USED_PERCENTAGE[intent.tier];
  return deepFreeze({
    providerId,
    tier: intent.tier,
    signalKind: signal,
    fetchedAt: isoOf(fetchedAtMs),
    windows: buildWindows(signal, usedPercentage, now),
    summary: buildSummary(signal, intent.tier),
  });
}

export function makeMissingSnapshot(providerId: string): MissingQuotaSnapshot {
  return deepFreeze({ providerId, missing: true as const });
}

export function isMissingSnapshot(
  snapshot: QuotaSnapshotOrMissing,
): snapshot is MissingQuotaSnapshot {
  return (snapshot as MissingQuotaSnapshot).missing === true;
}

/** 快照数据年龄（毫秒），时钟可注入 */
export function snapshotAgeMs(
  snapshot: FakeQuotaSnapshot,
  now = Date.now(),
): number {
  return now - Date.parse(snapshot.fetchedAt);
}

// ─── 内部：样本窗口/汇总按真实 provider 形态构造 ────────────

function buildWindows(
  signal: QuotaSignalKind,
  usedPercentage: number,
  now: number,
): QuotaSnapshotWindow[] {
  const resetAt = isoOf(now + RESET_IN_MS);

  // 火山 AFP（providers/volcano.mjs parseAfpTiers）：绝对额度，remaining = total - used
  if (signal === 'absolute') {
    const used = Math.round((ABSOLUTE_SAMPLE_TOTAL * usedPercentage) / 100);
    return [
      {
        label: '5h Rolling',
        total: ABSOLUTE_SAMPLE_TOTAL,
        used,
        remaining: ABSOLUTE_SAMPLE_TOTAL - used,
        percentage: usedPercentage,
        resetAt,
        unit: 'AFP',
      },
    ];
  }

  // OpenCode（providers/opencode.mjs）：百分比窗口，total 恒 100，unit '%'
  if (signal === 'percentage') {
    return [
      {
        label: '5h Rolling',
        total: 100,
        used: usedPercentage,
        remaining: 100 - usedPercentage,
        percentage: usedPercentage,
        resetAt,
        unit: '%',
      },
    ];
  }

  // DeepSeek（providers/deepseek.mjs）：余额只在 summary，windows 为空
  return [];
}

function buildSummary(
  signal: QuotaSignalKind,
  tier: QuotaTier,
): QuotaSnapshotSummaryItem[] {
  if (signal === 'currency') {
    return [{ label: 'USD 总余额', value: TIER_SAMPLE_USD_BALANCE[tier] }];
  }
  if (signal === 'absolute') {
    return [{ label: '套餐', value: 'Agent Plan 样本' }];
  }
  return [{ label: 'API 精度', value: '仅整数百分比(±0.5%)' }];
}

/** 真实实现的 resetAt/updatedAt 习惯输出秒级 ISO（去掉毫秒段） */
function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
  }
  return value;
}
