/**
 * quota-tool 剩余额度源适配器 — HTTP 客户端（HClaw 原创模块）
 *
 * 对接外部额度监控工具 quota-tool 的统一查询入口：POST /api/query，
 * 请求 body {provider, credentials}。失败形态实证（T2 对真实服务核对）：
 * - 供应商级失败（凭证拒绝/未知厂家/脚本错误）→ **HTTP 200 {ok:false,error}**，
 *   不是 4xx/5xx —— 客户端必须按 body.ok 分流，不能只看状态码
 * - 请求体不是合法 JSON → HTTP 400 {error}
 * - 服务整体不可达（连接拒绝/超时）→ fetch 层异常
 * 成功载荷：{ok:true, updatedAt, summary, windows, details}，windows 项七字段
 * 固定契约（数值字段允许 null——异构供应商只给百分比或只给余额是真实约束）。
 *
 * 全部失败都折成 QuotaToolOutcome 的失败分支返回，绝不抛异常——
 * 上层刷新器据此走 fail-open（ADR-0004）：陈旧照用 / 无快照 missing。
 */
import type { QuotaSummaryItem, QuotaWindow } from './tiers.js';

/** quota-tool 服务定位与查询超时（配置文件 data/config/quota-router.json） */
export interface QuotaToolEndpoint {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

/** 查询成功载荷：统一契约四件（details 原样透传不归一化） */
export interface QuotaQueryPayload {
  /** 数据时间：quota-tool 侧的查询完成时间（快照「数据时间」的本源） */
  readonly updatedAt: string;
  readonly summary: readonly QuotaSummaryItem[];
  readonly windows: readonly QuotaWindow[];
  readonly details: readonly unknown[];
}

/** 查询结果：成功 / 供应商级失败 / 服务不可达 / 契约外响应 */
export type QuotaToolOutcome =
  | { readonly ok: true; readonly payload: QuotaQueryPayload }
  | {
      readonly ok: false;
      readonly kind: 'provider-error' | 'unreachable' | 'unexpected';
      readonly error: string;
    };

/**
 * 查询一个供应商的剩余额度。凭证由调用方从加密存储解出后传入
 * （本函数不触碰凭证文件）。任何失败都返回结构化结果，不抛异常。
 */
export async function queryQuotaTool(
  endpoint: QuotaToolEndpoint,
  provider: string,
  credentials: unknown,
): Promise<QuotaToolOutcome> {
  let response: Response;
  try {
    response = await fetch(`${endpoint.baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, credentials }),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: 'unreachable',
      error: `quota-tool 不可达（${endpoint.baseUrl}）：${message}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: 'unexpected',
      error: `quota-tool 返回 HTTP ${response.status}（契约外状态码）`,
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      kind: 'unexpected',
      error: 'quota-tool 响应不是合法 JSON',
    };
  }

  // 供应商级失败：HTTP 200 + ok:false（凭证拒绝/未知厂家等原话透传）
  if (body.ok !== true) {
    const error = typeof body.error === 'string' ? body.error : '未知错误';
    return { ok: false, kind: 'provider-error', error };
  }

  const windows = parseWindows(body.windows);
  if (!windows) {
    return {
      ok: false,
      kind: 'unexpected',
      error: 'quota-tool 响应缺少统一契约 windows 数组',
    };
  }

  const updatedAt =
    typeof body.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(body.updatedAt))
      ? body.updatedAt
      : new Date().toISOString();

  return {
    ok: true,
    payload: {
      updatedAt,
      summary: parseSummary(body.summary),
      windows,
      details: Array.isArray(body.details) ? body.details : [],
    },
  };
}

// ─── 内部：宽松字段解析（数值字段允许 null/缺失是真实契约的一部分） ───

function parseWindows(raw: unknown): QuotaWindow[] | null {
  if (!Array.isArray(raw)) return null;
  const windows: QuotaWindow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    windows.push({
      label: typeof w.label === 'string' ? w.label : '',
      total: nullableNumber(w.total),
      used: nullableNumber(w.used),
      remaining: nullableNumber(w.remaining),
      percentage: nullableNumber(w.percentage),
      resetAt: typeof w.resetAt === 'string' ? w.resetAt : null,
      unit: typeof w.unit === 'string' ? w.unit : '',
    });
  }
  return windows;
}

function parseSummary(raw: unknown): QuotaSummaryItem[] {
  if (!Array.isArray(raw)) return [];
  const summary: QuotaSummaryItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.label !== 'string') continue;
    if (typeof s.value === 'number' || typeof s.value === 'string') {
      summary.push({ label: s.label, value: s.value });
    }
  }
  return summary;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
