/**
 * quota-router 配置装载 — 映射/阈值/TTL 走配置文件，不设 UI（SPEC #1）
 *
 * 文件：data/config/quota-router.json（非密，明文 JSON；凭证另册加密存
 * quota-router-credentials.json）。热生效不做 UI：每次访问按 mtime 检查，
 * 变了才重读；读取/解析失败保留上一次可用配置（首次失败给缺省——
 * 无映射 → 全部供应商 missing → 选路 fail-open，ADR-0004）。
 *
 * schema 示例（各字段含义见 QuotaRouterConfig 注释）：
 * {
 *   "version": 1,
 *   "quotaTool": { "baseUrl": "http://127.0.0.1:7788", "timeoutMs": 8000 },
 *   "snapshotTtlMs": 300000,
 *   "tierThresholds": {
 *     "absolute":   { "tight": 25, "critical": 10, "exhausted": 0 },
 *     "percentage": { "tight": 25, "critical": 10, "exhausted": 0 },
 *     "currency":   { "tight": 20, "critical": 5,  "exhausted": 0 }
 *   },
 *   "providers": {
 *     "<供应商池 profileId>": { "quotaToolProvider": "volcano" }
 *   }
 * }
 */
import fs from 'fs';

import { logger } from '../logger.js';
import {
  DEFAULT_TIER_THRESHOLDS,
  type QuotaSignalKind,
  type TierThresholdTable,
} from './tiers.js';

/** providers 映射项：供应商池 profileId → quota-tool 厂家 */
export interface ProviderQuotaMapping {
  /** quota-tool /api/query 的 provider 参数（真实工具里的厂家 id） */
  readonly quotaToolProvider: string;
  /** 信号形态：缺省按统一契约自动判别（tiers.ts detectSignalKind） */
  readonly signal?: QuotaSignalKind;
}

/** quota-router 配置（解析后形态；一切字段可缺省，缺省即 fail-open） */
export interface QuotaRouterConfig {
  readonly quotaTool: { readonly baseUrl: string; readonly timeoutMs: number };
  /** 快照 TTL（毫秒）：数据时间超过该值触发懒刷新；陈旧快照照用不阻塞 */
  readonly snapshotTtlMs: number;
  readonly tierThresholds: TierThresholdTable;
  /** 供应商池 profileId → quota-tool 映射；未登记的供应商 = missing = 放行 */
  readonly providers: Readonly<Record<string, ProviderQuotaMapping>>;
}

export const DEFAULT_QUOTA_ROUTER_CONFIG: QuotaRouterConfig = {
  quotaTool: { baseUrl: 'http://127.0.0.1:7788', timeoutMs: 8000 },
  snapshotTtlMs: 300_000,
  tierThresholds: DEFAULT_TIER_THRESHOLDS,
  providers: {},
};

export class QuotaRouterConfigLoader {
  private readonly filePath: string;
  private cached: QuotaRouterConfig = DEFAULT_QUOTA_ROUTER_CONFIG;
  private cachedMtimeMs: number | null = null;

  /** filePath 指向 data/config/ 体系内的配置 JSON（由装配侧传入） */
  constructor(filePath: string) {
    this.filePath = filePath;
    this.cached = this.readOrDefault(null);
  }

  /** 取当前配置；文件 mtime 变化才重读（热生效），失败保留上次可用 */
  get(): QuotaRouterConfig {
    let mtimeMs: number | null = null;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      // 文件不存在：维持缓存（缺省或上次可用），不打日志刷屏
      return this.cached;
    }
    if (mtimeMs !== this.cachedMtimeMs) {
      this.cached = this.readOrDefault(mtimeMs);
    }
    return this.cached;
  }

  private readOrDefault(mtimeMs: number | null): QuotaRouterConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const config = parseConfig(raw);
      this.cachedMtimeMs = mtimeMs;
      return config;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (mtimeMs !== null) {
        // 文件确实存在但读不了/解析失败：保留上次可用，并明示降级
        logger.warn(
          { file: this.filePath, err: message },
          'quota-router config reload failed; keeping last-good config',
        );
      } else {
        logger.info(
          { file: this.filePath },
          'quota-router config absent; using fail-open defaults (no providers mapped)',
        );
      }
      return mtimeMs === null && this.cachedMtimeMs === null
        ? DEFAULT_QUOTA_ROUTER_CONFIG
        : this.cached;
    }
  }
}

// ─── 内部：宽松解析（非法字段回缺省，不让坏配置炸掉选路） ─────────

function parseConfig(raw: Record<string, unknown>): QuotaRouterConfig {
  const quotaToolRaw = asObject(raw.quotaTool);
  const thresholdsRaw = asObject(raw.tierThresholds);
  return {
    quotaTool: {
      baseUrl:
        typeof quotaToolRaw?.baseUrl === 'string' && quotaToolRaw.baseUrl
          ? quotaToolRaw.baseUrl
          : DEFAULT_QUOTA_ROUTER_CONFIG.quotaTool.baseUrl,
      timeoutMs:
        positiveNumber(quotaToolRaw?.timeoutMs) ??
        DEFAULT_QUOTA_ROUTER_CONFIG.quotaTool.timeoutMs,
    },
    snapshotTtlMs:
      positiveNumber(raw.snapshotTtlMs) ??
      DEFAULT_QUOTA_ROUTER_CONFIG.snapshotTtlMs,
    tierThresholds: parseThresholds(thresholdsRaw),
    providers: parseProviders(raw.providers),
  };
}

function parseThresholds(
  raw: Record<string, unknown> | null,
): TierThresholdTable {
  const parsed = {} as TierThresholdTable;
  for (const kind of ['absolute', 'percentage', 'currency'] as const) {
    const entry = asObject(raw?.[kind]);
    const fallback = DEFAULT_TIER_THRESHOLDS[kind];
    parsed[kind] = {
      tight: positiveNumber(entry?.tight) ?? fallback.tight,
      critical: positiveNumber(entry?.critical) ?? fallback.critical,
      exhausted: numberOrNull(entry?.exhausted) ?? fallback.exhausted,
    };
  }
  return parsed;
}

function parseProviders(
  raw: unknown,
): Readonly<Record<string, ProviderQuotaMapping>> {
  const source = asObject(raw);
  if (!source) return {};
  const providers: Record<string, ProviderQuotaMapping> = {};
  for (const [profileId, value] of Object.entries(source)) {
    const entry = asObject(value);
    if (!entry || typeof entry.quotaToolProvider !== 'string') continue;
    if (!entry.quotaToolProvider) continue;
    const signal =
      entry.signal === 'absolute' ||
      entry.signal === 'percentage' ||
      entry.signal === 'currency'
        ? entry.signal
        : undefined;
    providers[profileId] = signal
      ? { quotaToolProvider: entry.quotaToolProvider, signal }
      : { quotaToolProvider: entry.quotaToolProvider };
  }
  return providers;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
