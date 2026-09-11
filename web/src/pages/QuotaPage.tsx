/**
 * 额度面板页（T7，HClaw 新增中文 UI —— SPEC #1「新增中文 UI 仅两块」之一）
 *
 * 每供应商一行卡：中文名或 id、四档档位徽标（充足/紧张/临界/耗尽）、原始信号
 * 值（百分比/绝对剩余/美元余额按 signalKind 呈现）、数据时间（相对时间展示+
 * 绝对时间 title）；映射缺失/快照缺失/数据陈旧均有降级展示，绝不空白报错。
 * 色板沿上游 design tokens（success/warning/error + Tailwind 语义色）。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import {
  fetchQuotaPanel,
  type QuotaPanelProviderRow,
  type QuotaPanelResponse,
  type QuotaTier,
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

function WindowDetails({ row }: { row: QuotaPanelProviderRow }) {
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
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {windows.map((w, index) => {
        const detail =
          w.remaining !== null && w.total !== null
            ? `剩 ${w.remaining}/${w.total}${w.unit}`
            : w.remaining !== null
              ? `剩 ${w.remaining}${w.unit}`
              : w.percentage !== null
                ? `已用 ${w.percentage}%`
                : w.label;
        return (
          <span
            key={`${w.label}-${index}`}
            className="text-xs text-muted-foreground"
          >
            {w.label || '窗口'}：{detail}
          </span>
        );
      })}
    </div>
  );
}

function ProviderQuotaCard({ row }: { row: QuotaPanelProviderRow }) {
  return (
    <Card data-testid={`quota-card-${row.providerId}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
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
            <div className="text-sm text-muted-foreground">未配置额度源</div>
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
      </CardContent>
    </Card>
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.providers.map((row) => (
              <ProviderQuotaCard key={row.providerId} row={row} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
