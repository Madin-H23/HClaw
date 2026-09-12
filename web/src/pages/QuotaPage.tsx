/**
 * 额度面板页（T7 初版；U1 信息设计升级 —— HClaw 新增中文 UI）
 *
 * 信息层级自上而下：顶部汇总行（供应商总数 + 四档分布色点计数 + 最紧供应商
 * 点名，安静的数据行）→ 每供应商一行卡：卡内左侧「炉心温度计」表盘（签名
 * 元素：纯 SVG 环形，弧长 = 最紧窗口剩余比，中心剩余大数字），右侧档位徽标、
 * 原始信号、窗口明细（默认只展示最紧窗口，其余折叠展开）与数据时间。
 *
 * 降级形态（沿 T7 五态，绝不空白报错）：映射缺失「未配置额度源」/ 快照缺失
 * 「暂无额度数据」/ 数据陈旧「数据已过期」标注 / 档位未知徽标 + 表盘虚线环
 * 「—」/ 空池整卡文案。
 *
 * 色板纪律：表盘色阶只从 globals.css tokens 取值（success/warning/error +
 * color-mix 派生的深 warning），无硬编码新色；美元余额信号无窗口占比 → 表盘
 * 不画弧、中心展示余额本身。数字过渡 200ms CSS transition（prefers-reduced-
 * motion 由 globals.css 全局 `transition-duration: 0.01ms !important` 覆盖）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import {
  fetchQuotaPanel,
  type QuotaPanelProviderRow,
  type QuotaPanelResponse,
  type QuotaSignalKind,
  type QuotaTier,
  type QuotaWindow,
} from '../api/quota';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * 四档徽标样式（充足绿/紧张黄/临界橙/耗尽红）。
 * 色板全走 globals.css 语义 token（随主题/暗色联动）：临界为紧张的实底
 * 强调形态——warning 实底白字（dark 下亮黄底配 error-bg 深字保证对比度），
 * 与耗尽（error 系）拉开色相档位递进。
 */
const TIER_BADGE_CLASS: Record<QuotaTier, string> = {
  plenty:
    'bg-success-bg text-success dark:bg-success/20 dark:text-success border-transparent',
  tight:
    'bg-warning-bg text-warning dark:bg-warning/20 dark:text-warning border-transparent',
  critical:
    'bg-warning text-white dark:bg-warning dark:text-error-bg border-transparent',
  exhausted:
    'bg-error-bg text-error dark:bg-error/20 dark:text-error border-transparent',
};

/**
 * 四档档位中文标签与展示顺序（与 src/quota-router/tiers.ts 的
 * QUOTA_TIERS/QUOTA_TIER_LABELS 同口径；web 不跨包引用，本地镜像）。
 */
const TIER_ORDER: readonly QuotaTier[] = [
  'plenty',
  'tight',
  'critical',
  'exhausted',
];
const TIER_LABELS: Record<QuotaTier, string> = {
  plenty: '充足',
  tight: '紧张',
  critical: '临界',
  exhausted: '耗尽',
};

/**
 * 表盘/色点四档色阶（炉心温度计色阶 token 映射，U1 设计钉死）：
 * 充足=success → 紧张=warning → 临界=warning/error 派生深 warning
 * （color-mix 由既有 token 调配，不引入体系外新色）→ 耗尽=error。
 * 档位未知回退 muted-foreground（灰环形态）。
 */
export const TIER_GAUGE_COLOR: Record<QuotaTier, string> = {
  plenty: 'var(--success)',
  tight: 'var(--warning)',
  critical: 'color-mix(in srgb, var(--warning) 45%, var(--error))',
  exhausted: 'var(--error)',
};
const GAUGE_UNKNOWN_COLOR = 'var(--muted-foreground)';

/** 表盘几何：viewBox 72×72，环半径 30，线宽 7（数字区留内径 ≈53px） */
const GAUGE_RADIUS = 30;

/**
 * 弧长映射（纯函数，测试钉死）：剩余比 0..1 → stroke-dasharray
 * 「弧长 周长」。超界比值夹取到 [0,1]。
 */
export function gaugeArc(ratio: number, radius: number = GAUGE_RADIUS): string {
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, ratio));
  return `${(clamped * circumference).toFixed(4)} ${circumference.toFixed(4)}`;
}

/**
 * 剩余比（0..1）：仅 percentage / absolute 两类信号有真实窗口占比
 * （score 口径见 src/quota-router/tiers.ts：两者均为 0-100 的剩余百分比）；
 * currency 是美元余额、无比率 → null（表盘不画弧）。
 */
function gaugeRatio(row: QuotaPanelProviderRow): number | null {
  if (!row.mapped || row.score === null) return null;
  if (row.signalKind === 'percentage' || row.signalKind === 'absolute') {
    return Math.max(0, Math.min(1, row.score / 100));
  }
  return null;
}

/**
 * 单窗口剩余占比（0-100，纯函数）：与 src/quota-router/tiers.ts 的
 * windowScore 同口径（百分比窗口 = 100-已用；绝对窗口 = 剩余/总量），
 * 用于裁决「最紧窗口」。无法折算 → null。
 */
export function windowRemainPct(
  w: QuotaWindow,
  kind: QuotaSignalKind | null,
): number | null {
  if (kind === 'percentage') {
    if (w.percentage !== null) return Math.max(0, 100 - w.percentage);
    return w.remaining !== null ? Math.max(0, w.remaining) : null;
  }
  if (kind === 'absolute') {
    if (w.total !== null && w.total > 0 && w.remaining !== null) {
      return Math.max(0, (w.remaining / w.total) * 100);
    }
    if (w.percentage !== null) return Math.max(0, 100 - w.percentage);
  }
  return null;
}

/** 最紧窗口下标（纯函数，测试钉死）：取剩余占比最小的一窗；均不可折算回退首窗 */
export function pickTightestWindowIndex(
  windows: readonly QuotaWindow[],
  kind: QuotaSignalKind | null,
): number {
  let best = 0;
  let bestPct = Number.POSITIVE_INFINITY;
  windows.forEach((w, index) => {
    const pct = windowRemainPct(w, kind);
    if (pct !== null && pct < bestPct) {
      bestPct = pct;
      best = index;
    }
  });
  return best;
}

/** 汇总行统计（纯函数，测试钉死）：总数 + 四档计数 + 最紧供应商（剩余分最小） */
export function summarizeTiers(providers: readonly QuotaPanelProviderRow[]): {
  total: number;
  counts: Record<QuotaTier, number>;
  tightest: QuotaPanelProviderRow | null;
} {
  const counts: Record<QuotaTier, number> = {
    plenty: 0,
    tight: 0,
    critical: 0,
    exhausted: 0,
  };
  let tightest: QuotaPanelProviderRow | null = null;
  let tightestScore = Number.POSITIVE_INFINITY;
  for (const p of providers) {
    if (p.tier) counts[p.tier] += 1;
    if (p.tier && p.score !== null && p.score < tightestScore) {
      tightestScore = p.score;
      tightest = p;
    }
  }
  return { total: providers.length, counts, tightest };
}

const SIGNAL_KIND_LABELS: Record<string, string> = {
  absolute: '绝对剩余',
  percentage: '窗口百分比',
  currency: '美元余额',
};

function formatRelativeAge(ageMs: number | null): string {
  if (ageMs === null) return '未知';
  if (ageMs < 60_000) return '刚刚刷新';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatAbsoluteTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString('zh-CN', { hour12: false });
}

function formatScore(score: number | null): string {
  if (score === null) return '—';
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/**
 * 炉心温度计表盘（签名元素，纯 SVG）：底环=轨道，前弧=最紧窗口剩余比
 * （stroke-dasharray 弧长映射，12 点钟起点顺时针），中心=剩余大数字。
 * 形态三态：比率信号→色弧+百分比；美元余额→不画弧+中心余额；
 * 未映射/无快照→虚线灰环+「—」。弧长与色阶 200ms 过渡（CSS transition，
 * prefers-reduced-motion 由 globals.css 全局降级覆盖）。
 */
function FurnaceGauge({ row }: { row: QuotaPanelProviderRow }) {
  const ratio = gaugeRatio(row);
  const missing = !row.mapped || row.score === null;
  const arcColor = row.tier ? TIER_GAUGE_COLOR[row.tier] : GAUGE_UNKNOWN_COLOR;

  const ariaLabel = missing
    ? `${row.displayName}：暂无额度数据`
    : row.signalKind === 'currency'
      ? `${row.displayName}：余额 $${formatScore(row.score)}`
      : `${row.displayName}：剩余 ${formatScore(row.score)}%`;

  return (
    <svg
      data-testid="quota-gauge"
      viewBox="0 0 72 72"
      role="img"
      aria-label={ariaLabel}
      className="h-[72px] w-[72px] flex-shrink-0"
    >
      {/* 轨道底环：缺失态转虚线灰环 */}
      <circle
        data-testid="quota-gauge-track"
        cx="36"
        cy="36"
        r={GAUGE_RADIUS}
        fill="none"
        strokeWidth="7"
        strokeDasharray={missing ? '3 4' : undefined}
        style={{
          stroke: missing
            ? 'color-mix(in srgb, var(--muted-foreground) 35%, transparent)'
            : 'color-mix(in srgb, var(--muted-foreground) 18%, transparent)',
        }}
      />
      {/* 前弧：ratio>0 才渲染（0 长度圆头线帽会画出假圆点） */}
      {ratio !== null && ratio > 0 && (
        <circle
          data-testid="quota-gauge-arc"
          cx="36"
          cy="36"
          r={GAUGE_RADIUS}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          transform="rotate(-90 36 36)"
          style={{
            stroke: arcColor,
            strokeDasharray: gaugeArc(ratio, GAUGE_RADIUS),
            transition: 'stroke-dasharray 200ms ease, stroke 200ms ease',
          }}
        />
      )}
      {/* 中心读数 */}
      {missing ? (
        <text
          data-testid="quota-gauge-value"
          x="36"
          y="42"
          textAnchor="middle"
          fontSize="16"
          fontWeight="600"
          style={{ fill: 'var(--muted-foreground)' }}
        >
          —
        </text>
      ) : row.signalKind === 'currency' ? (
        <text
          data-testid="quota-gauge-value"
          x="36"
          y="40"
          textAnchor="middle"
          fontSize="12"
          fontWeight="600"
          className="tabular-nums"
          style={{ fill: 'var(--foreground)' }}
        >
          ${formatScore(row.score)}
        </text>
      ) : (
        <text
          data-testid="quota-gauge-value"
          x="36"
          y="46"
          textAnchor="middle"
          fontSize="16"
          fontWeight="700"
          className="tabular-nums"
          style={{ fill: arcColor }}
        >
          {formatScore(row.score)}
          <tspan fontSize="10" fontWeight="600">
            %
          </tspan>
        </text>
      )}
    </svg>
  );
}

/** 原始信号一行值：按 signalKind 呈现（百分比 / 绝对剩余 / 美元余额） */
function RawSignalLine({ row }: { row: QuotaPanelProviderRow }) {
  const kindLabel =
    row.signalKind !== null ? SIGNAL_KIND_LABELS[row.signalKind] : null;
  if (row.signalKind === null || row.score === null) {
    return <div className="text-sm text-muted-foreground">暂无信号值</div>;
  }
  if (row.signalKind === 'currency') {
    return (
      <div className="text-sm text-foreground">
        余额{' '}
        <span className="font-semibold text-brand-600 dark:text-brand-400">
          ${formatScore(row.score)}
        </span>
        <span className="ml-1 text-xs text-muted-foreground">
          （{kindLabel}）
        </span>
      </div>
    );
  }
  if (row.signalKind === 'percentage') {
    return (
      <div className="text-sm text-foreground">
        剩余{' '}
        <span className="font-semibold text-brand-600 dark:text-brand-400">
          {formatScore(row.score)}%
        </span>
        <span className="ml-1 text-xs text-muted-foreground">
          （{kindLabel}）
        </span>
      </div>
    );
  }
  // absolute：剩余分 = 最紧窗口剩余占比；窗口明细单独成行
  return (
    <div className="text-sm text-foreground">
      剩余{' '}
      <span className="font-semibold text-brand-600 dark:text-brand-400">
        {formatScore(row.score)}%
      </span>
      <span className="ml-1 text-xs text-muted-foreground">
        （最紧窗口占比）
      </span>
    </div>
  );
}

/** 单窗口明细短文案（与 T7 文案同口径） */
function windowDetailText(w: QuotaWindow): string {
  if (w.remaining !== null && w.total !== null) {
    return `剩 ${w.remaining}/${w.total}${w.unit}`;
  }
  if (w.remaining !== null) return `剩 ${w.remaining}${w.unit}`;
  if (w.percentage !== null) return `已用 ${w.percentage}%`;
  return w.label || '窗口';
}

/**
 * 窗口明细（U1 折叠交互）：多窗口时默认只展示最紧一窗（剩余占比最小，
 * 与表盘弧长同源），其余收进「展开其余 N 窗」；单窗口/无窗口不出现开关。
 */
function WindowDetails({ row }: { row: QuotaPanelProviderRow }) {
  const [expanded, setExpanded] = useState(false);
  const windows = row.windows.filter(
    (w) => w.remaining !== null || w.percentage !== null || w.total !== null,
  );
  if (windows.length === 0) {
    const numericSummary = row.summary.filter(
      (item) => typeof item.value === 'number',
    );
    if (numericSummary.length === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {numericSummary.map((item) => (
          <span key={item.label} className="text-xs text-muted-foreground">
            {item.label || '汇总'}：
            <span className="text-foreground">{String(item.value)}</span>
          </span>
        ))}
      </div>
    );
  }
  const collapsible = windows.length > 1;
  const tightestIndex = collapsible
    ? pickTightestWindowIndex(windows, row.signalKind)
    : 0;
  const visible = collapsible && !expanded ? [windows[tightestIndex]] : windows;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {visible.map((w, index) => (
          <span
            key={`${w.label}-${index}`}
            className="text-xs text-muted-foreground"
          >
            {w.label || '窗口'}：{windowDetailText(w)}
            {collapsible && !expanded && index === 0 && (
              <span className="text-foreground/70">（最紧）</span>
            )}
          </span>
        ))}
      </div>
      {collapsible && (
        <button
          type="button"
          data-testid="quota-windows-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          {expanded ? '收起窗口明细' : `展开其余 ${windows.length - 1} 窗`}
        </button>
      )}
    </div>
  );
}

function ProviderQuotaCard({ row }: { row: QuotaPanelProviderRow }) {
  return (
    <Card data-testid={`quota-card-${row.providerId}`}>
      <CardContent className="p-4">
        <div className="flex gap-3">
          <FurnaceGauge row={row} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate text-sm font-semibold text-foreground"
                  title={row.providerId}
                >
                  {row.displayName}
                </span>
                {!row.enabled && (
                  <Badge variant="outline" className="text-[10px]">
                    已停用
                  </Badge>
                )}
              </div>
              {row.tier ? (
                <Badge className={TIER_BADGE_CLASS[row.tier]}>
                  {row.tierLabel}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-dashed text-muted-foreground"
                >
                  档位未知
                </Badge>
              )}
            </div>

            <div className="mt-2">
              {!row.mapped ? (
                <div className="text-sm text-muted-foreground">
                  未配置额度源
                </div>
              ) : row.tier === null ? (
                <div className="text-sm text-muted-foreground">
                  暂无额度数据（等待首次刷新）
                </div>
              ) : (
                <>
                  <RawSignalLine row={row} />
                  <WindowDetails row={row} />
                </>
              )}
            </div>

            {row.fetchedAt && (
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span title={formatAbsoluteTime(row.fetchedAt)}>
                  数据时间：{formatRelativeAge(row.ageMs)}
                </span>
                {row.stale && (
                  <Badge variant="outline" className="text-error text-[10px]">
                    数据已过期
                  </Badge>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 顶部汇总行（U1）：安静的数据行——供应商总数 + 四档分布（色点+计数）+
 * 最紧供应商点名。降级形态：未配置 → 静默一句；已配置但全无档位 →
 * 「暂无档位数据」；空池不渲染（整卡「供应商池为空」口径不变）。
 */
function QuotaSummary({ data }: { data: QuotaPanelResponse }) {
  const { total, counts, tightest } = summarizeTiers(data.providers);
  const tieredCount =
    counts.plenty + counts.tight + counts.critical + counts.exhausted;
  return (
    <div
      data-testid="quota-summary"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card/40 px-4 py-2.5 text-sm"
    >
      <span className="text-muted-foreground">
        共{' '}
        <span className="tabular-nums font-semibold text-foreground">
          {total}
        </span>{' '}
        家供应商
      </span>
      {!data.configured ? (
        <span className="text-muted-foreground">尚未配置额度源映射</span>
      ) : tieredCount === 0 ? (
        <span className="text-muted-foreground">
          暂无档位数据（等待首次刷新）
        </span>
      ) : (
        <>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {TIER_ORDER.map((tier) => (
              <span
                key={tier}
                data-testid={`quota-summary-tier-${tier}`}
                className={`inline-flex items-center gap-1 text-muted-foreground ${
                  counts[tier] === 0 ? 'opacity-50' : ''
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: TIER_GAUGE_COLOR[tier] }}
                />
                {TIER_LABELS[tier]}
                <span className="tabular-nums font-medium text-foreground">
                  {counts[tier]}
                </span>
              </span>
            ))}
          </span>
          {tightest && tightest.score !== null && (
            <span
              data-testid="quota-summary-tightest"
              className="text-muted-foreground"
            >
              最紧：
              <span className="font-medium text-foreground">
                {tightest.displayName}
              </span>
              （剩余{' '}
              <span className="tabular-nums">
                {tightest.signalKind === 'currency'
                  ? `$${formatScore(tightest.score)}`
                  : `${formatScore(tightest.score)}%`}
              </span>
              ）
            </span>
          )}
        </>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div
      data-testid="quota-loading"
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-28 rounded-xl" />
      ))}
    </div>
  );
}

export function QuotaPage() {
  const [data, setData] = useState<QuotaPanelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    if (mode === 'refresh') setRefreshing(true);
    try {
      const panel = await fetchQuotaPanel();
      setData(panel);
      setLoadError(false);
    } catch {
      setLoadError(true);
      toast.error('额度面板加载失败，请稍后重试');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load('initial');
  }, [load]);

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">额度面板</h1>
            <p className="text-sm text-muted-foreground">
              各供应商额度档位、原始信号与数据时间一览
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load('refresh')}
            disabled={refreshing}
          >
            <RefreshCw
              className={`mr-1 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            />
            刷新
          </Button>
        </div>

        {data && !data.configured && (
          <div
            data-testid="quota-unconfigured"
            className="mb-4 flex items-start gap-2 rounded-xl border border-border bg-card/40 p-4 text-sm text-muted-foreground"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
            <span>
              尚未配置任何供应商额度源映射：请在 data/config/quota-router.json
              的 providers 中登记供应商与 quota-tool 的映射；配置前选路按上游
              原生策略执行。
            </span>
          </div>
        )}

        {loading ? (
          <LoadingSkeleton />
        ) : loadError ? (
          <Card>
            <CardContent className="p-6">
              <div className="text-sm text-muted-foreground">
                额度面板加载失败：后端暂时不可用，请稍后重试。
              </div>
              <Button
                data-testid="quota-retry"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void load('refresh')}
                disabled={refreshing}
              >
                <RefreshCw
                  className={`mr-1 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
                />
                重试
              </Button>
            </CardContent>
          </Card>
        ) : !data || data.providers.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              供应商池为空：请先在设置中添加模型供应商。
            </CardContent>
          </Card>
        ) : (
          <>
            <QuotaSummary data={data} />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.providers.map((row) => (
                <ProviderQuotaCard key={row.providerId} row={row} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
