/**
 * 频控状态存储 — 独立 SQLite data/db/proactive-message.db（票 #22，ADR-0006 先例）
 *
 * 由主动消息模块独占拥有：建表/迁移/丢弃重建均在本文件内闭环，上游
 * messages.db（db.ts 巨石）零改动、不共享连接（归属以文件划界）。存两类事实：
 * - 渠道级发送时间戳（渠道全局限速的滑动窗口用）；
 * - 渠道+目标+消息类型级的发送记录（含内容摘要，冷却去重用）。
 * 一行发送记录同时供两层消费，库只存事实不做判定——窗口/冷却的语义裁决在
 * 投递决策纯函数（delivery-decision.ts），存储不掺策略。
 *
 * **公开面不抛错**（沿 quota-router refresher 先例）：读写失败就地吸收（记
 * WARN、读折空 / 写静默丢弃）。这不是吞错，而是 fail-open 的存储侧落点——
 * 折空状态 = 无记录 = 三层全放行，存储故障永远朝「多发」方向退化而非「少发」
 * （通知宁多勿丢，ADR-0008；注意与额度路由的 fail-open 方向辨析，见
 * delivery-decision.ts 文件头）。重启不重置冷却：数据落盘，进程重启后
 * 冷却窗照常生效（票面硬要求，测试钉死）。
 *
 * 记录量控制：发送时间戳只对滑动窗口（分钟级）与冷却窗（小时级）有意义，
 * prune(nowMs, keepWindowMs) 清掉更老的行；由装配侧在发送后顺带调用即可。
 */
import fs from 'node:fs';
import path from 'path';

import DatabaseConstructor from '../sqlite-compat.js';
import { logger } from '../logger.js';

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

/** 一次实际发送的记录（发送成功后由装配侧落库；持有/丢弃不落库） */
export interface RecordedSend {
  readonly channelId: string;
  /** 私聊目标（会话/收件 id） */
  readonly target: string;
  /** 消息类型 key（任务/触发源侧身份键） */
  readonly messageKey: string;
  /** 内容摘要（冷却去重的「同内容」判据，与决策输入同口径） */
  readonly contentDigest: string;
  /** 发送时刻（毫秒时间戳，注入时钟，非 Date.now 自取） */
  readonly sentAtMs: number;
}

/** 冷却去重比对的查询结果：同渠道+目标+类型的发送事实 */
export interface KeySendRecord {
  readonly sentAtMs: number;
  readonly contentDigest: string;
}

const CURRENT_VERSION = 1;

const CREATE_SEND_RECORDS_SQL = `
  CREATE TABLE IF NOT EXISTS send_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id     TEXT NOT NULL,
    target         TEXT NOT NULL,
    message_key    TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    sent_at_ms     INTEGER NOT NULL
  )
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_send_records_channel_time
    ON send_records(channel_id, sent_at_ms);
  CREATE INDEX IF NOT EXISTS idx_send_records_key
    ON send_records(channel_id, target, message_key, sent_at_ms)
`;

export class RateControlStateStore {
  private readonly db: Database;

  /** dbPath 指向 data/db/proactive-message.db（生产默认，由装配侧传入） */
  constructor(dbPath: string) {
    ensureDbDir(dbPath);
    this.db = new DatabaseConstructor(dbPath) as Database;
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  /** 记录一次实际发送（滑动窗口 + 冷却去重共用一行事实）；失败仅告警不抛出 */
  recordSend(send: RecordedSend): void {
    try {
      this.db
        .prepare(
          `INSERT INTO send_records
             (channel_id, target, message_key, content_digest, sent_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          send.channelId,
          send.target,
          send.messageKey,
          send.contentDigest,
          send.sentAtMs,
        );
    } catch (err) {
      this.warn('recordSend', err);
    }
  }

  /**
   * 滑动窗口用：该渠道（全目标合并）[sinceMs, +∞) 的发送时间戳，升序。
   * 读失败折空数组（无记录 = 限速放行，宁多勿丢）。
   */
  recentSendTimesMs(channelId: string, sinceMs: number): number[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT sent_at_ms FROM send_records
           WHERE channel_id = ? AND sent_at_ms >= ? ORDER BY sent_at_ms`,
        )
        .all(channelId, sinceMs) as Array<Record<string, unknown>>;
      return rows.map((row) => Number(row.sent_at_ms));
    } catch (err) {
      this.warn('recentSendTimesMs', err);
      return [];
    }
  }

  /**
   * 冷却去重用：该渠道+目标+消息类型 key 在 [sinceMs, +∞) 的发送记录（升序，
   * 含内容摘要）。读失败折空数组（无记录 = 去重放行，宁多勿丢）。
   */
  recentSendsOfKey(
    channelId: string,
    target: string,
    messageKey: string,
    sinceMs: number,
  ): KeySendRecord[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT sent_at_ms, content_digest FROM send_records
           WHERE channel_id = ? AND target = ? AND message_key = ?
             AND sent_at_ms >= ? ORDER BY sent_at_ms`,
        )
        .all(channelId, target, messageKey, sinceMs) as Array<
        Record<string, unknown>
      >;
      return rows.map((row) => ({
        sentAtMs: Number(row.sent_at_ms),
        contentDigest: String(row.content_digest),
      }));
    } catch (err) {
      this.warn('recentSendsOfKey', err);
      return [];
    }
  }

  /**
   * 清理 keepWindowMs 之前的旧行（滑动窗口/冷却窗之外的记录对频控已无意义）；
   * 由装配侧发送后顺带调用。失败仅告警不抛出（残留只多占空间，不影响语义）。
   *
   * 不变量：keepWindowMs 必须 ≥ max(全渠道最大 cooldownMs, RATE_WINDOW_MS=60s
   * 滑窗)——本库只存事实不读配置，剪太狠会把冷却窗内/滑窗内的记录静默削掉，
   * 冷却去重层与限速层随之失效（调用侧装配时由配置取 max，勿写死小值）。
   */
  prune(nowMs: number, keepWindowMs: number): void {
    try {
      this.db
        .prepare('DELETE FROM send_records WHERE sent_at_ms < ?')
        .run(nowMs - keepWindowMs);
    } catch (err) {
      this.warn('prune', err);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      this.warn('close', err);
    }
  }

  // ─── 内部 ─────────────────────────────────────────────────

  private warn(operation: string, err: unknown): void {
    logger.warn(
      {
        operation,
        err: err instanceof Error ? err.message : String(err),
      },
      'proactive-message rate-control store failed; failing open (ADR-0008)',
    );
  }

  /** 迁移（本模块独占，PRAGMA user_version 递增，ADR-0006 模式） */
  private migrate(): void {
    const version =
      Number(this.db.pragma('user_version', { simple: true })) || 0;
    if (version >= CURRENT_VERSION) return;
    this.db.exec(CREATE_SEND_RECORDS_SQL);
    this.db.exec(CREATE_INDEX_SQL);
    this.db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
  }
}

/** SQLite 文件落 data/db/——目录不存在时先建（与上游 STORE_DIR 同级独立文件） */
function ensureDbDir(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
