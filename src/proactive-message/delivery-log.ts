/**
 * 投递记录审计库 — 独立 SQLite data/db/proactive-message-deliveries.db（票 #24）
 *
 * SPEC #20 user story 10「投递记录可审计」的落点：每一次主动消息投递尝试的
 * 可观察结果（渠道/目标/时间/送达结果/来源任务）一行一条。与 B2 频控状态库
 * （proactive-message.db send_records）**分工不同、互为补充**：
 *   - send_records 只记「实际发送成功」的频控事实（限速/冷却窗口裁剪，
 *     keepWindowMs 小时级即清），存的是「频控记的账」；
 *   - 本库存「投递链路观察到的结果」——sent/hold/discard/skipped/send-failed/
 *     send-timeout 全量审计，天级保留。同一频控库被 prune 清掉的历史在审计库
 *     仍可查；悬挂超时后迟到的真实发送在频控库记「实际发生」、审计库记
 *     「观察到的超时」，两边口径差异是有意为之（见 trigger-dispatch.ts）。
 *
 * **落点选型（票面「落点你定」）**：独立库文件 + 本模块独占，不扩 B2 状态库
 * ——两者保留策略相反（频控事实要 prune 省空间、审计事实要天级留存），同表
 * 会互相误伤；同库异表则共用 user_version 迁移坐标与连接生命周期，把两种
 * 保留策略耦在一个文件里。沿 ADR-0006 独立库先例（上游 messages.db 零改动
 * 红线不触碰），库文件与本模块划界。
 *
 * **公开面不抛错**（沿 B2 state-store 承诺）：读写失败就地吸收（记 WARN、
 * 读折空 / 写静默丢弃）。审计故障不许打断投递链路——通知宁多勿丢（ADR-0008）
 * 的存储侧镜像：审计缺一行好过投递断一次。
 *
 * 查询接口：queryDeliveries(filter) 供未来 UI/CLI 消费（SPEC：频控/目标零 UI
 * 是批二边界，接口先行不接线）；retention prune 由写入侧顺带调用（30 天，
 * 与上游 task_run_logs 保留期同数量级）。
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

/** 一次投递尝试的审计记录（全量结果：含被频控压制的尝试） */
export interface ProactiveDeliveryRecord {
  readonly channelId: string;
  /** 私聊目标；null = 决策阶段未解析到目标（hold/discard/skipped） */
  readonly target: string | null;
  /** 消息类型 key（= 触发源 key：任务 key / 未来事件 key） */
  readonly messageKey: string;
  /**
   * 送达结果：sent | hold | discard | skipped | send-failed | send-timeout。
   * 与 ProactiveNotifyResult 的映射见 trigger-dispatch.ts（notify 调用本身
   * reject 时折 send-failed；per-send 超时为 send-timeout）。
   */
  readonly outcome: string;
  /** 决策/失败的一行中文理由（透传，供审计回读） */
  readonly reason: string | null;
  /** 触发源种类：'scheduled-task'（批三事件总线可扩新值；接口与具体触发源解耦，调度器只是第一个实现者） */
  readonly triggerKind: string;
  /**
   * 本次运行的触发方式：'manual'=手动触发 / 'scheduled'=按计划触发；
   * 审计据此区分手动与定时投递。v1 旧行（无此列时代）回读折 'scheduled'。
   */
  readonly triggerType: string;
  /** 来源任务 id（触发源为调度器时）；事件总线触发源可为 null */
  readonly taskId: string | null;
  /** 来源任务运行 id（可空：脚本任务无 V2 运行 id） */
  readonly runId: string | null;
  /** 记录时刻（毫秒时间戳，注入时钟） */
  readonly createdAtMs: number;
}

/** 查询过滤条件（全部可缺省；缺省 = 不过滤） */
export interface DeliveryRecordFilter {
  readonly channelId?: string;
  readonly taskId?: string;
  readonly messageKey?: string;
  readonly outcome?: string;
  /** 返回条数上限；缺省 50，硬上限 500（审计查询不做全表导出） */
  readonly limit?: number;
}

const CURRENT_VERSION = 2;

const CREATE_DELIVERY_RECORDS_SQL = `
  CREATE TABLE IF NOT EXISTS delivery_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id     TEXT NOT NULL,
    target         TEXT,
    message_key    TEXT NOT NULL,
    outcome        TEXT NOT NULL,
    reason         TEXT,
    trigger_kind   TEXT NOT NULL,
    task_id        TEXT,
    run_id         TEXT,
    created_at_ms  INTEGER NOT NULL
  )
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_delivery_records_time
    ON delivery_records(created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_delivery_records_task
    ON delivery_records(task_id, created_at_ms)
`;

/** 审计保留窗：30 天（与上游 task_run_logs 清理期同数量级） */
export const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const QUERY_DEFAULT_LIMIT = 50;
const QUERY_MAX_LIMIT = 500;

export class ProactiveDeliveryLogStore {
  private readonly db: Database;

  /** dbPath 指向 data/db/proactive-message-deliveries.db（生产默认，装配传入） */
  constructor(dbPath: string) {
    ensureDbDir(dbPath);
    this.db = new DatabaseConstructor(dbPath) as Database;
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  /** 记录一次投递尝试（全量结果）；失败仅告警不抛出（审计不打断投递） */
  recordDelivery(record: ProactiveDeliveryRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO delivery_records
             (channel_id, target, message_key, outcome, reason,
              trigger_kind, trigger_type, task_id, run_id, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.channelId,
          record.target,
          record.messageKey,
          record.outcome,
          record.reason,
          record.triggerKind,
          record.triggerType,
          record.taskId,
          record.runId,
          record.createdAtMs,
        );
    } catch (err) {
      this.warn('recordDelivery', err);
    }
  }

  /**
   * 查询投递记录：按过滤条件倒序（新→旧）返回。读失败折空数组（审计查询
   * 故障不抛出）；limit 缺省 50、钳到 500。
   */
  queryDeliveries(
    filter: DeliveryRecordFilter = {},
  ): ProactiveDeliveryRecord[] {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filter.channelId !== undefined) {
        conditions.push('channel_id = ?');
        params.push(filter.channelId);
      }
      if (filter.taskId !== undefined) {
        conditions.push('task_id = ?');
        params.push(filter.taskId);
      }
      if (filter.messageKey !== undefined) {
        conditions.push('message_key = ?');
        params.push(filter.messageKey);
      }
      if (filter.outcome !== undefined) {
        conditions.push('outcome = ?');
        params.push(filter.outcome);
      }
      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = Math.min(
        Math.max(filter.limit ?? QUERY_DEFAULT_LIMIT, 1),
        QUERY_MAX_LIMIT,
      );
      const rows = this.db
        .prepare(
          `SELECT channel_id, target, message_key, outcome, reason,
                  trigger_kind, trigger_type, task_id, run_id, created_at_ms
           FROM delivery_records ${where}
           ORDER BY created_at_ms DESC, id DESC
           LIMIT ?`,
        )
        .all(...params, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        channelId: String(row.channel_id),
        target: row.target === null ? null : String(row.target),
        messageKey: String(row.message_key),
        outcome: String(row.outcome),
        reason: row.reason === null ? null : String(row.reason),
        triggerKind: String(row.trigger_kind),
        // v1 旧行（迁移补列默认 'scheduled'）与新行统一回读
        triggerType:
          row.trigger_type === null || row.trigger_type === undefined
            ? 'scheduled'
            : String(row.trigger_type),
        taskId: row.task_id === null ? null : String(row.task_id),
        runId: row.run_id === null ? null : String(row.run_id),
        createdAtMs: Number(row.created_at_ms),
      }));
    } catch (err) {
      this.warn('queryDeliveries', err);
      return [];
    }
  }

  /**
   * 清理保留窗之外的旧行；由写入侧（装配工厂闭包）顺带调用。失败仅告警。
   * 与 B2 prune 不同：这里没有语义下限约束——保留窗是纯运维参数，剪早了
   * 只损失审计历史，不影响任何频控判定。
   */
  prune(nowMs: number, retentionMs: number = DELIVERY_RETENTION_MS): void {
    try {
      this.db
        .prepare('DELETE FROM delivery_records WHERE created_at_ms < ?')
        .run(nowMs - retentionMs);
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
      'proactive-message delivery log failed; delivery pipeline unaffected',
    );
  }

  /** 迁移（本模块独占，PRAGMA user_version 递增，ADR-0006 模式） */
  private migrate(): void {
    const version =
      Number(this.db.pragma('user_version', { simple: true })) || 0;
    if (version >= CURRENT_VERSION) return;
    this.db.exec(CREATE_DELIVERY_RECORDS_SQL);
    this.db.exec(CREATE_INDEX_SQL);
    if (version < 2) {
      // v1 -> v2：补 trigger_type 列（v1 时代全部按计划触发，缺省 'scheduled'）
      this.db.exec(
        `ALTER TABLE delivery_records ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'scheduled'`,
      );
    }
    this.db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
  }
}

/** SQLite 文件落 data/db/——目录不存在时先建（与上游 STORE_DIR 同级独立文件） */
function ensureDbDir(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
