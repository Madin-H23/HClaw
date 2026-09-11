/**
 * CC Switch 成本源适配器 — 只读对接 ~/.cc-switch/cc-switch.db（HClaw 原创模块）
 *
 * 三源只读对接（ADR-0003）：模型单价（model_pricing）与按供应商聚合的已花成本
 * （usage_daily_rollups）从 CC Switch 本地 SQLite 取数。**绝不写入**：连接以
 * SQLITE_OPEN_READONLY 通道打开（better-sqlite3 {readonly:true, fileMustExist:true}，
 * 等价 SQLite URI mode=ro；实测 v12.10.0 不解析 file: URI，readonly 连接标志是
 * 同一保证——写语句在本连接直接被 SQLite 拒绝）。
 *
 * 失败形态（显式降级，绝不抛异常——ADR-0004 fail-open，消费侧按 missing 放行）：
 * - 文件不存在 → lastFailure {kind:'file-missing'}，查询折 missing
 * - 锁冲突（CC Switch 正在写）→ busy 超时后 {kind:'locked'}，折 missing
 * - 表/列缺失（schema 演进）→ {kind:'schema-missing'}，折 missing
 * - 其他（数据异常等）→ {kind:'unexpected'}，折 missing
 * 打开失败不永久化：下次查询自动重试（锁冲突可恢复）；真实 schema 实证
 * （2026-09-11，SQLite 3.53）——两表 cost 列均为 TEXT 十进制串、journal_mode=delete
 * （非 WAL，只读连接零副产物文件）、rollups.provider_id 含 `_session`/`_codex_ses`
 * 伪供应商（不在 providers 表，聚合照常按 provider_id 分组）。
 */
import os from 'node:os';
import path from 'node:path';

import { logger } from '../logger.js';
import DatabaseConstructor from '../sqlite-compat.js';

interface UnknownDatabase {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  exec(sql: string): void;
  close(): void;
}

/** better-sqlite3 只读打开选项（bun:sqlite 同名兼容 readonly，fileMustExist 冗余无害） */
type ReadonlyDatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => UnknownDatabase;

// ─── 输出类型（消费侧：T5 决策层 / 额度面板；单点转出口见 routing-inputs.ts） ───

/** 模型单价：USD / 百万 tokens（model_pricing TEXT 十进制串解析） */
export interface ModelPrice {
  readonly modelId: string;
  readonly displayName: string;
  readonly inputCostPerMillion: number;
  readonly outputCostPerMillion: number;
  readonly cacheReadCostPerMillion: number;
  readonly cacheCreationCostPerMillion: number;
}

/** 单价缺失标记：模型未定价 / 值无法解析；决策侧 fail-open 处理 */
export interface MissingModelPrice {
  readonly modelId: string;
  readonly missing: true;
}

export type ModelPriceOrMissing = ModelPrice | MissingModelPrice;

export function isMissingModelPrice(
  price: ModelPriceOrMissing,
): price is MissingModelPrice {
  return (price as MissingModelPrice).missing === true;
}

/** 供应商已花成本：usage_daily_rollups 按供应商聚合（可限定时间窗口） */
export interface ProviderSpentCost {
  /** CC Switch 侧供应商 id（usage_daily_rollups.provider_id 域，含伪供应商前缀） */
  readonly providerId: string;
  /** 窗口内已花成本合计（USD） */
  readonly totalCostUsd: number;
  readonly requestCount: number;
  /** 聚合窗口首/末日（CC Switch date 域 YYYY-MM-DD）；无记录为 null */
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  /** 聚合窗口天数；null = 全历史 */
  readonly windowDays: number | null;
}

/** 已花成本缺失标记：该供应商无任何用量记录（或源降级） */
export interface MissingProviderSpentCost {
  readonly providerId: string;
  readonly missing: true;
}

export type ProviderSpentCostOrMissing =
  | ProviderSpentCost
  | MissingProviderSpentCost;

export function isMissingProviderSpentCost(
  cost: ProviderSpentCostOrMissing,
): cost is MissingProviderSpentCost {
  return (cost as MissingProviderSpentCost).missing === true;
}

// ─── 降级表示 ────────────────────────────────────────────────

/** 源级降级类别：票面点名的三类（文件不存在/锁冲突/表结构缺失）+ 兜底 */
export type CcSwitchFailureKind =
  | 'file-missing'
  | 'locked'
  | 'schema-missing'
  | 'unexpected';

export interface CcSwitchSourceFailure {
  readonly kind: CcSwitchFailureKind;
  readonly error: string;
}

export interface CcSwitchCostSourceOptions {
  /** cc-switch.db 路径；缺省 ~/.cc-switch/cc-switch.db（测试注入 fixture 副本） */
  readonly dbPath?: string;
  /** busy 超时（毫秒）；缺省 5000，与快照库同口径（测试注入小值防挂起） */
  readonly busyTimeoutMs?: number;
  /** 可注入时钟（毫秒），缺省 Date.now——窗口截止日的确定性 */
  readonly nowMs?: () => number;
}

const REQUIRED_TABLES = ['model_pricing', 'usage_daily_rollups'] as const;

export class CcSwitchCostSource {
  private readonly dbPath: string;
  private readonly busyTimeoutMs: number;
  private readonly nowMs: () => number;
  private db: UnknownDatabase | null = null;
  private failure: CcSwitchSourceFailure | null = null;

  constructor(options?: CcSwitchCostSourceOptions) {
    this.dbPath = options?.dbPath ?? defaultCcSwitchDbPath();
    this.busyTimeoutMs = options?.busyTimeoutMs ?? 5000;
    this.nowMs = options?.nowMs ?? Date.now;
  }

  /** 查询一个模型的单价；模型未定价/源降级 → missing（不抛异常） */
  getModelPrice(modelId: string): ModelPriceOrMissing {
    const row = this.safeQuery(
      '查询模型单价',
      () =>
        this.db
          ?.prepare(
            `SELECT model_id, display_name,
                    input_cost_per_million, output_cost_per_million,
                    cache_read_cost_per_million, cache_creation_cost_per_million
             FROM model_pricing WHERE model_id = ?`,
          )
          .get(modelId) as Record<string, unknown> | undefined,
    );
    if (!row) return { modelId, missing: true };

    const input = parseUsdPerMillion(row.input_cost_per_million);
    const output = parseUsdPerMillion(row.output_cost_per_million);
    const cacheRead = parseUsdPerMillion(row.cache_read_cost_per_million);
    const cacheCreation = parseUsdPerMillion(
      row.cache_creation_cost_per_million,
    );
    if (
      input === null ||
      output === null ||
      cacheRead === null ||
      cacheCreation === null
    ) {
      this.failure = {
        kind: 'unexpected',
        error: `model_pricing 行含不可解析的价格串（model_id=${modelId}）`,
      };
      return { modelId, missing: true };
    }
    return {
      modelId: String(row.model_id),
      displayName: String(row.display_name),
      inputCostPerMillion: input,
      outputCostPerMillion: output,
      cacheReadCostPerMillion: cacheRead,
      cacheCreationCostPerMillion: cacheCreation,
    };
  }

  /**
   * 查询一个供应商的已花成本（usage_daily_rollups 按 provider_id 聚合）。
   * windowDays 缺省 = 全历史；指定时按「今日（UTC 日期域）往前 N 天」截取。
   * 无任何用量记录 / 源降级 → missing（不抛异常）。
   */
  getProviderSpentCost(
    providerId: string,
    options?: { windowDays?: number },
  ): ProviderSpentCostOrMissing {
    const windowDays =
      typeof options?.windowDays === 'number' &&
      Number.isFinite(options.windowDays) &&
      options.windowDays > 0
        ? Math.floor(options.windowDays)
        : null;
    const params: unknown[] = [providerId];
    let sql = `SELECT provider_id,
                      SUM(CAST(total_cost_usd AS REAL)) AS total_cost,
                      SUM(request_count) AS requests,
                      MIN(date) AS first_date,
                      MAX(date) AS last_date
               FROM usage_daily_rollups WHERE provider_id = ?`;
    if (windowDays !== null) {
      sql += ' AND date >= ?';
      params.push(utcDateOffset(this.nowMs(), -windowDays));
    }
    sql += ' GROUP BY provider_id';

    const row = this.safeQuery(
      '查询供应商已花成本',
      () =>
        this.db?.prepare(sql).get(...params) as
          | Record<string, unknown>
          | undefined,
    );
    if (!row) return { providerId, missing: true };
    return {
      providerId: String(row.provider_id),
      totalCostUsd: Number(row.total_cost) || 0,
      requestCount: Number(row.requests) || 0,
      firstDate: row.first_date == null ? null : String(row.first_date),
      lastDate: row.last_date == null ? null : String(row.last_date),
      windowDays,
    };
  }

  /** 最近一次降级原因（可解释性：面板/日志展示）；无降级时 null */
  lastFailure(): CcSwitchSourceFailure | null {
    return this.failure;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // close 阶段的异常无消费意义：句柄状态清零即可
    }
    this.db = null;
  }

  // ─── 内部：只读打开 + 就地吸收任何异常 ─────────────────────

  /**
   * 打开失败/查询抛错统一在此吸收：记降级原因、折 null 返回，绝不向上抛。
   * 打开失败不缓存失败状态——下次查询重试（锁冲突是瞬态的）。
   */
  private safeQuery<T>(
    action: string,
    run: () => T | undefined,
  ): T | undefined {
    if (!this.ensureOpen()) return undefined;
    try {
      const value = run();
      // 本次查询成功（含查无行）：源当前健康，清除最近降级标记
      this.failure = null;
      return value;
    } catch (err) {
      this.failure = classifyFailure(err);
      logger.warn(
        { dbPath: this.dbPath, action, err: this.failure.error },
        'cc-switch.db read failed; cost source degraded (fail-open, ADR-0004)',
      );
      // 连接可能已坏（schema 变更等）：丢弃句柄，下次查询重开
      this.close();
      return undefined;
    }
  }

  private ensureOpen(): boolean {
    if (this.db) return true;
    let opened: UnknownDatabase | null = null;
    try {
      const ctor = DatabaseConstructor as unknown as ReadonlyDatabaseCtor;
      opened = new ctor(this.dbPath, {
        readonly: true,
        fileMustExist: true,
      });
      // 连接级设置（不触文件）：锁冲突短超时快速降级
      opened.exec(`PRAGMA busy_timeout = ${Math.max(0, this.busyTimeoutMs)}`);
      if (!this.hasRequiredTables(opened)) {
        opened.close();
        this.failure = {
          kind: 'schema-missing',
          error: `cc-switch.db 缺少必需表（${REQUIRED_TABLES.join('/')}），schema 可能已演进`,
        };
        return false;
      }
      this.db = opened;
      return true;
    } catch (err) {
      // 半开句柄就地关闭，杜绝泄漏（如锁冲突打断 schema 检查时连接已打开）
      try {
        opened?.close();
      } catch {
        // 已关闭/不可关：忽略
      }
      this.failure = classifyFailure(err);
      logger.warn(
        { dbPath: this.dbPath, err: this.failure.error },
        'cc-switch.db open failed; cost source degraded (fail-open, ADR-0004)',
      );
      return false;
    }
  }

  private hasRequiredTables(db: UnknownDatabase): boolean {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => '?').join(', ')})`,
      )
      .all(...REQUIRED_TABLES) as Array<Record<string, unknown>>;
    return rows.length === REQUIRED_TABLES.length;
  }
}

/** 生产默认路径：~/.cc-switch/cc-switch.db（装配侧可显式传路径覆盖） */
export function defaultCcSwitchDbPath(): string {
  return path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
}

// ─── 内部：解析与降级分类 ───────────────────────────────────

/**
 * TEXT 十进制串 → USD 数值；空串/纯空白/非十进制形态 → null（调用侧折 missing）。
 * 严格十进制正则（真实库实证全是 '5'/'25'/'0.50' 类串）：`Number('')===0` 会把
 * 空串误判成"免费模型"，`0x10`/`1e3` 等形态会被 Number 静默接受——一律拒绝。
 */
function parseUsdPerMillion(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** 窗口截止日期（UTC YYYY-MM-DD；CC Switch rollups.date 同域） */
function utcDateOffset(nowMs: number, deltaDays: number): string {
  return new Date(nowMs + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function classifyFailure(err: unknown): CcSwitchSourceFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (/unable to open database file|SQLITE_CANTOPEN/i.test(message)) {
    return { kind: 'file-missing', error: message };
  }
  if (
    /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(
      message,
    )
  ) {
    return { kind: 'locked', error: message };
  }
  if (/no such table|no such column/i.test(message)) {
    return { kind: 'schema-missing', error: message };
  }
  return { kind: 'unexpected', error: message };
}
