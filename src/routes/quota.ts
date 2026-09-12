/**
 * 额度面板取数端点（T7，HClaw 原创路由模块）
 *
 * GET /api/quota/panel —— 每供应商一行：档位/原始信号/数据时间/降级标注。
 * 数据面只走 quota-router 装配 facade 的只读口径（quotaPanelData）：
 * - 快照/档位/原始信号/数据时间/映射配置存在性，绝不暴露任何凭证
 *   （UnifiedProvider 的 token 字段一律不出本模块，只取 id/name/enabled）；
 * - 面板访问点即快照懒刷新点（facade 内 fire-and-forget，与选路同口径）；
 * - 未配置映射/装配降级时返回降级形态（mapped=false / 快照缺失），前端明示
 *   「未配置额度源」，绝不报错（ADR-0004 fail-open）。
 *
 * 鉴权沿上游 admin 口径：authMiddleware + systemConfigMiddleware
 * （manage_system_config 权限，与 /api/monitor 一致）。
 */
import { Hono } from 'hono';

import { quotaPanelData } from '../quota-router/assembly.js';
import {
  QUOTA_TIER_LABELS,
  type QuotaSignalKind,
  type QuotaSummaryItem,
  type QuotaTier,
  type QuotaWindow,
} from '../quota-router/tiers.js';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { getProviders } from '../runtime-config.js';

const quotaRoutes = new Hono<{ Variables: Variables }>();
quotaRoutes.use('*', authMiddleware, systemConfigMiddleware);

/** 单供应商面板行（与 web/src/api/quota.ts 的镜像类型逐字段对齐） */
export interface QuotaPanelProviderRow {
  readonly providerId: string;
  /** 上游供应商池中的显示名；不在池内的映射目标回退为 id */
  readonly displayName: string;
  readonly enabled: boolean;
  /** 是否已登记 quota-tool 额度源映射 */
  readonly mapped: boolean;
  readonly tier: QuotaTier | null;
  readonly tierLabel: string | null;
  readonly signalKind: QuotaSignalKind | null;
  /** 剩余分（越高额度越足；口径见 tiers.ts） */
  readonly score: number | null;
  /** 数据时间：quota-tool 侧 updatedAt（ISO） */
  readonly fetchedAt: string | null;
  /** 入库时间（ISO） */
  readonly storedAt: string | null;
  /** 数据时间超过 TTL（陈旧照用，前端标注「数据已过期」） */
  readonly stale: boolean;
  /** 数据年龄（毫秒）；不可解析为 null */
  readonly ageMs: number | null;
  readonly windows: readonly QuotaWindow[];
  readonly summary: readonly QuotaSummaryItem[];
}

export interface QuotaPanelResponse {
  readonly configured: boolean;
  readonly snapshotTtlMs: number;
  readonly providers: readonly QuotaPanelProviderRow[];
}

quotaRoutes.get('/panel', (c) => {
  const panel = quotaPanelData();
  const providers = getProviders();
  const nameOf = new Map(providers.map((p) => [p.id, p.name]));
  const enabledOf = new Map(providers.map((p) => [p.id, p.enabled]));

  const rows: QuotaPanelProviderRow[] = panel.entries.map((entry) => {
    const snapshot = entry.snapshot;
    return {
      providerId: entry.providerId,
      displayName: nameOf.get(entry.providerId) ?? entry.providerId,
      enabled: enabledOf.get(entry.providerId) ?? false,
      mapped: entry.mapped,
      tier: snapshot?.tier ?? null,
      tierLabel: snapshot ? QUOTA_TIER_LABELS[snapshot.tier] : null,
      signalKind: snapshot?.signalKind ?? null,
      score: snapshot?.score ?? null,
      fetchedAt: snapshot?.fetchedAt ?? null,
      storedAt: snapshot?.storedAt ?? null,
      stale: entry.stale,
      ageMs: entry.ageMs,
      windows: snapshot?.windows ?? [],
      summary: snapshot?.summary ?? [],
    };
  });

  const body: QuotaPanelResponse = {
    configured: panel.configured,
    snapshotTtlMs: panel.snapshotTtlMs,
    providers: rows,
  };
  return c.json(body);
});

export default quotaRoutes;
