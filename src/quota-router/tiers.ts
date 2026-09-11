/**
 * 额度档位归一化 — 异构信号 → 统一四档（HClaw 原创模块，CONTEXT.md 术语）
 *
 * 归一化核心：把三类异构供应商额度信号折算成一个「剩余分」标量
 * （越高额度越足），再对照阈值表落四档：
 * - absolute   火山 AFP 绝对剩余窗口 → sum/每窗剩余占比 %（min 最紧窗口裁决）
 * - percentage OpenCode 整数百分比窗口（total=100 unit='%'，percentage=已用）→ 剩余分 = 100 - 已用
 * - currency   DeepSeek 美元余额（windows 空、summary 承载数值）→ 剩余分 = 余额本身
 * 阈值与信号形态走配置文件（data/config/quota-router.json），不设 UI；
 * 未指定 signal 时按统一契约自动判别（unit '%' → 百分比 / 数值 total → 绝对 /
 * 数值 summary → 美元余额）。无法归一化 → null（调用侧按数据缺失 fail-open
 * 处理，ADR-0004：绝不因缺数据否决候选）。
 *
 * 档位形态与 T2 测试基座 tests/quota-router-stubs/fake-snapshot.ts 的草稿类型
 * 逐字段对齐（该文件约定：生产类型落地时以此对齐）。
 */

/** 额度档位：统一四档标尺（充足 / 紧张 / 临界 / 耗尽） */
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

/** 异构信号类别 */
export type QuotaSignalKind = 'absolute' | 'percentage' | 'currency';

/**
 * 统一契约窗口：七字段固定；total/used/remaining/percentage 允许 null
 * （异构供应商只给百分比或只给余额是真实约束）。
 */
export interface QuotaWindow {
  readonly label: string;
  readonly total: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly percentage: number | null;
  readonly resetAt: string | null;
  readonly unit: string;
}

/** 统一契约汇总条目：value 既有字符串（套餐名）也有数值（美元余额） */
export interface QuotaSummaryItem {
  readonly label: string;
  readonly value: string | number;
}

/** 阈值表：剩余分 ≤ exhausted → 耗尽；≤ critical → 临界；≤ tight → 紧张；否则充足 */
export interface TierThresholds {
  readonly tight: number;
  readonly critical: number;
  readonly exhausted: number;
}

/** 三类信号各自的阈值（currency 用美元绝对值，其余用剩余占比 %） */
export type TierThresholdTable = Record<QuotaSignalKind, TierThresholds>;

/** 缺省阈值：与 T2 基座确定性样本（TIER_SAMPLE_*）逐档吻合 */
export const DEFAULT_TIER_THRESHOLDS: TierThresholdTable = {
  absolute: { tight: 25, critical: 10, exhausted: 0 },
  percentage: { tight: 25, critical: 10, exhausted: 0 },
  currency: { tight: 20, critical: 5, exhausted: 0 },
};

/** 归一化输入：统一契约的窗口与汇总（quota-tool 成功载荷的子集） */
export interface NormalizeQuotaInput {
  readonly windows: readonly QuotaWindow[];
  readonly summary: readonly QuotaSummaryItem[];
}

/** 归一化结果：档位 + 实际采用的信号类别 + 折算出的剩余分 */
export interface NormalizedQuotaTier {
  readonly tier: QuotaTier;
  readonly signalKind: QuotaSignalKind;
  /** 剩余分：越高额度越足（% 或美元，取决于信号类别；无法折算时 null） */
  readonly score: number;
}

/**
 * 档位归一化主入口。signal 缺省时自动判别；无法归一化返回 null
 * （调用侧按缺失处理，fail-open 放行）。
 */
export function normalizeQuotaTier(
  input: NormalizeQuotaInput,
  thresholds: TierThresholdTable = DEFAULT_TIER_THRESHOLDS,
  signal?: QuotaSignalKind,
): NormalizedQuotaTier | null {
  const kind = signal ?? detectSignalKind(input);
  if (!kind) return null;
  const score = remainingScore(input, kind);
  if (score === null) return null;
  return {
    tier: tierOf(score, thresholds[kind]),
    signalKind: kind,
    score,
  };
}

/** 剩余分 → 四档（≤ 阈值取更低档，边界值归更紧一档） */
export function tierOf(score: number, thresholds: TierThresholds): QuotaTier {
  if (score <= thresholds.exhausted) return 'exhausted';
  if (score <= thresholds.critical) return 'critical';
  if (score <= thresholds.tight) return 'tight';
  return 'plenty';
}

/**
 * 信号自动判别（统一契约启发式）：
 * unit '%' → 百分比；具数 total 的窗口 → 绝对；数值 summary → 美元余额。
 */
export function detectSignalKind(
  input: NormalizeQuotaInput,
): QuotaSignalKind | null {
  if (input.windows.some((w) => w.unit === '%')) return 'percentage';
  if (input.windows.some((w) => typeof w.total === 'number' && w.total > 0)) {
    return 'absolute';
  }
  if (input.summary.some((s) => typeof s.value === 'number')) return 'currency';
  return null;
}

/**
 * 剩余分折算。多窗口取最紧一窗（min）——5h 窗口耗尽不该被月度余量稀释；
 * 数值截到 0 下限，负余额/负剩余一并视为耗尽量级。
 */
function remainingScore(
  input: NormalizeQuotaInput,
  kind: QuotaSignalKind,
): number | null {
  if (kind === 'currency') return currencyBalance(input);
  const scores = input.windows
    .map((w) => windowScore(w, kind))
    .filter((s): s is number => s !== null);
  if (!scores.length) return null;
  return Math.max(0, Math.min(...scores));
}

/** 单窗口剩余分：绝对窗口用剩余占比，百分比窗口用 100 - 已用 */
function windowScore(w: QuotaWindow, kind: QuotaSignalKind): number | null {
  if (kind === 'percentage') {
    if (typeof w.percentage === 'number') return clamp0(100 - w.percentage);
    return typeof w.remaining === 'number' ? clamp0(w.remaining) : null;
  }
  // absolute：优先 remaining/total；total 缺失时退回 100 - percentage
  if (
    typeof w.total === 'number' &&
    w.total > 0 &&
    typeof w.remaining === 'number'
  ) {
    return clamp0((w.remaining / w.total) * 100);
  }
  if (typeof w.percentage === 'number') return clamp0(100 - w.percentage);
  return null;
}

/**
 * 美元余额：取 summary 里第一个数值项（真实 DeepSeek 把总余额排首位）。
 * 已知取舍：若某厂家调整汇总顺序或多币种并存，可能取错项——阈值/映射可在
 * 配置侧局部校正，见 issue #4 追评披露。
 */
function currencyBalance(input: NormalizeQuotaInput): number | null {
  const item = input.summary.find(
    (s): s is QuotaSummaryItem & { value: number } =>
      typeof s.value === 'number',
  );
  return item ? clamp0(item.value) : null;
}

function clamp0(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
