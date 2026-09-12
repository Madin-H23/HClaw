/**
 * 额度快照库 — 独立 SQLite data/db/quota-router.db（HClaw 原创模块，ADR-0006）
 *
 * 由 quota-router 模块独占拥有：建表/迁移/丢弃重建均在本文件内闭环，
 * 上游 messages.db（db.ts）零改动、不共享连接（归属以文件划界）。
 * 衍生数据可整体丢弃：文件删掉即重建，迁移以 PRAGMA user_version 递增。
 *
 * 存的是归一化后的快照：档位 + 信号类别 + 原始窗口/汇总 + 数据时间
 * （fetchedAt=quota-tool updatedAt 本源）。读写接口保持干净，供后续票的
 * 路由决策层与额度面板消费；陈旧判定（TTL）不在库内做——库只存事实，
 * 新鲜度由刷新器与消费方按数据时间裁决（ADR-0004：陈旧照用，标注时间）。
 */
import fs from 'node:fs';
import path from 'path';

import DatabaseConstructor from '../sqlite-compat.js';
import type {
  QuotaSignalKind,
  QuotaSummaryItem,
  QuotaTier,
  QuotaWindow,
} from './tiers.js';

interface Database {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

/** 已落库的额度快照：fetchedAt 即「数据时间」，storedAt 即入库时间 */
export interface StoredQuotaSnapshot {
  /** HClaw 供应商池里的 profile id（quota-tool 厂家映射的目标键） */
  readonly providerId: string;
  readonly tier: QuotaTier;
  readonly signalKind: QuotaSignalKind;
  /** 剩余分（归一化标量，越高额度越足；口径见 tiers.ts） */
  readonly score: number;
  /** 数据时间：quota-tool 侧 updatedAt（ISO） */
  readonly fetchedAt: string;
  /** 入库时间（ISO） */
  readonly storedAt: string;
  readonly windows: readonly QuotaWindow[];
  readonly summary: readonly QuotaSummaryItem[];
}

/** 数据源缺失标记：无窗口无汇总，消费侧按 fail-open 处理（ADR-0004） */
export interface MissingQuotaSnapshot {
  readonly providerId: string;
  readonly missing: true;
}

export type QuotaSnapshotOrMissing = StoredQuotaSnapshot | MissingQuotaSnapshot;

export function isMissingSnapshot(
  snapshot: QuotaSnapshotOrMissing,
): snapshot is MissingQuotaSnapshot {
  return (snapshot as MissingQuotaSnapshot).missing === true;
}

const CURRENT_VERSION = 1;

const CREATE_SNAPSHOTS_SQL = `
  CREATE TABLE IF NOT EXISTS quota_snapshots (
    provider_id  TEXT PRIMARY KEY,
    tier         TEXT NOT NULL,
    signal_kind  TEXT NOT NULL,
    score        REAL NOT NULL,
    fetched_at   TEXT NOT NULL,
    stored_at    TEXT NOT NULL,
    windows_json TEXT NOT NULL,
    summary_json TEXT NOT NULL
  )
`;

export class QuotaSnapshotStore {
  private readonly db: Database;

  /** dbPath 指向 data/db/quota-router.db（生产默认，由装配侧传入） */
  constructor(dbPath: string) {
    ensureDbDir(dbPath);
    this.db = new DatabaseConstructor(dbPath) as Database;
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  /** 覆盖式写入一个供应商的快照（同主键即更新） */
  upsert(snapshot: StoredQuotaSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO quota_snapshots
           (provider_id, tier, signal_kind, score, fetched_at, stored_at, windows_json, summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           tier = excluded.tier,
           signal_kind = excluded.signal_kind,
           score = excluded.score,
           fetched_at = excluded.fetched_at,
           stored_at = excluded.stored_at,
           windows_json = excluded.windows_json,
           summary_json = excluded.summary_json`,
      )
      .run(
        snapshot.providerId,
        snapshot.tier,
        snapshot.signalKind,
        snapshot.score,
        snapshot.fetchedAt,
        snapshot.storedAt,
        JSON.stringify(snapshot.windows),
        JSON.stringify(snapshot.summary),
      );
  }

  /** 读取一个供应商的快照；无记录返回 null（missing 由调用侧构造） */
  get(providerId: string): StoredQuotaSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT provider_id, tier, signal_kind, score, fetched_at, stored_at,
                windows_json, summary_json
         FROM quota_snapshots WHERE provider_id = ?`,
      )
      .get(providerId) as Record<string, unknown> | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  /** 全量快照（额度面板/决策层批量消费） */
  all(): StoredQuotaSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT provider_id, tier, signal_kind, score, fetched_at, stored_at,
                windows_json, summary_json
         FROM quota_snapshots ORDER BY provider_id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToSnapshot);
  }

  close(): void {
    this.db.close();
  }

  // ─── 内部：迁移（本模块独占，PRAGMA user_version 递增） ─────────

  private migrate(): void {
    const version =
      Number(this.db.pragma('user_version', { simple: true })) || 0;
    if (version >= CURRENT_VERSION) return;
    this.db.exec(CREATE_SNAPSHOTS_SQL);
    this.db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
  }
}

function rowToSnapshot(row: Record<string, unknown>): StoredQuotaSnapshot {
  return {
    providerId: String(row.provider_id),
    tier: row.tier as QuotaTier,
    signalKind: row.signal_kind as QuotaSignalKind,
    score: Number(row.score),
    fetchedAt: String(row.fetched_at),
    storedAt: String(row.stored_at),
    windows: parseJsonArray(row.windows_json) as QuotaWindow[],
    summary: parseJsonArray(row.summary_json) as QuotaSummaryItem[],
  };
}

function parseJsonArray(raw: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** SQLite 文件落 data/db/——目录不存在时先建（与上游 STORE_DIR 同级独立文件） */
function ensureDbDir(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
