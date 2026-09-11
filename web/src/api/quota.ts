/**
 * 额度面板 API 客户端（T7，HClaw 新增）
 * 端点：GET /api/quota/panel（admin 鉴权）；类型与 src/routes/quota.ts 响应逐字段镜像。
 */
import { api } from './client';

export type QuotaTier = 'plenty' | 'tight' | 'critical' | 'exhausted';
export type QuotaSignalKind = 'absolute' | 'percentage' | 'currency';

export interface QuotaWindow {
  label: string;
  total: number | null;
  used: number | null;
  remaining: number | null;
  percentage: number | null;
  resetAt: string | null;
  unit: string;
}

export interface QuotaSummaryItem {
  label: string;
  value: string | number;
}

export interface QuotaPanelProviderRow {
  providerId: string;
  displayName: string;
  enabled: boolean;
  mapped: boolean;
  tier: QuotaTier | null;
  tierLabel: string | null;
  signalKind: QuotaSignalKind | null;
  score: number | null;
  fetchedAt: string | null;
  storedAt: string | null;
  stale: boolean;
  ageMs: number | null;
  windows: QuotaWindow[];
  summary: QuotaSummaryItem[];
}

export interface QuotaPanelResponse {
  configured: boolean;
  snapshotTtlMs: number;
  providers: QuotaPanelProviderRow[];
}

export function fetchQuotaPanel(): Promise<QuotaPanelResponse> {
  return api.get<QuotaPanelResponse>('/api/quota/panel');
}
