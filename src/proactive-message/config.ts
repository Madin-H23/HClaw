/**
 * 频控配置装载 — 三层频控与每渠道默认私聊目标走配置文件，不设 UI（票 #22）
 *
 * 文件：data/config/proactive-message.json（非密，明文 JSON；沿 quota-router.json
 * 模式——热生效不做 UI：每次访问按 mtime 检查，变了才重读；读取/解析失败保留
 * 上一次可用配置（last-good），首次失败给缺省。缺省方向 = 最少节制：限速取
 * 默认 10 条/分钟（票面钉死的唯一默认值），静默窗口与冷却去重不启用——频控
 * 的 fail-open 是宁多勿丢（ADR-0008），配置缺失/坏文件不许造成少发。
 *
 * schema 示例（各字段含义见 ProactiveMessageConfig 注释）：
 * {
 *   "version": 1,
 *   "rateLimitPerMinute": 10,        // 全局默认：渠道全局限速（条/分钟）；
 *                                    // ⚠ 0 判非法回落默认 10——没有 0=不限速
 *                                    // 的语义（与 cooldownMs 的 0=关闭不对称）
 *   "cooldownMs": 3600000,           // 全局默认：冷却去重窗（毫秒；0 = 关闭）
 *   "timeZoneOffsetMinutes": 480,    // 静默窗口时区：固定 UTC 偏移（缺省 UTC+8）
 *   "channels": {
 *     "feishu": {
 *       "rateLimitPerMinute": 5,     // 渠道覆盖；非法（含 0）回落全局默认
 *       "cooldownMs": 1800000,       // 渠道覆盖；缺省回落全局默认
 *       "defaultTarget": "<该渠道默认私聊目标 id>"   // 缺省 null = 未配置
 *     }
 *   },
 *   "quietWindows": {                // 任务级静默窗口：key = 任务/触发源 key
 *     "morning-check": [
 *       { "start": "23:00", "end": "07:00" },          // 跨零点合法
 *       { "start": "12:30", "end": "13:30", "days": [0, 6] }  // 0=周日..6=周六
 *     ]
 *   }
 * }
 *
 * 静默窗口采用**时段声明**而非 cron 表达式（格式选型说明）：频控判定需要的是
 * 「nowMs 是否落在窗口区间内」的区间语义，cron 表达式只锚定触发时刻，要折成
 * 区间得先算下一次触发时间（引入 cron-parser 到决策路径且语义绕）；时段声明
 * 天然是区间、跨零点与星期过滤都直给，且让投递决策纯函数零字符串解析、零
 * cron 依赖（0 依赖红线不动）。时区用固定 UTC 偏移声明（不做 DST）——个人
 * 自托管场景一个固定偏移够用，还换来纯函数的完全确定性。
 *
 * 渠道 key 以 channel-registry（shared/channel-registry.ts，ADR-0009 单一事实
 * 源）的 ChannelId 为准：登记外的渠道条目跳过并告警，漏登记/拼错 id 不会进
 * 生效配置。
 */
import fs from 'node:fs';

import { CHANNEL_IDS, type ChannelId } from '../channel-registry.js';
import { logger } from '../logger.js';
import type { QuietWindow } from './delivery-decision.js';

/** 每渠道频控条目（解析后形态；数值字段已回落全局默认，无空位） */
export interface ChannelRateControlConfig {
  /** ① 渠道全局限速：滑动窗口（60 秒）内允许的最大发送条数 */
  readonly rateLimitPerMinute: number;
  /** ③ 冷却去重窗（毫秒）；0 = 该渠道关闭去重 */
  readonly cooldownMs: number;
  /** 每渠道默认私聊目标；null = 未配置（装配侧跳过该渠道的主动消息） */
  readonly defaultTarget: string | null;
}

/** 频控配置（解析后形态；一切字段可缺省，缺省 = 最少节制） */
export interface ProactiveMessageConfig {
  /** ① 渠道全局限速的全局默认（条/分钟） */
  readonly rateLimitPerMinute: number;
  /** ③ 冷却去重窗的全局默认（毫秒；0 = 关闭） */
  readonly cooldownMs: number;
  /** ② 静默窗口的默认时区：固定 UTC 偏移（分钟；480 = UTC+8） */
  readonly timeZoneOffsetMinutes: number;
  /** 每渠道频控条目；未登记渠道按全局默认（限速生效、无目标不投递） */
  readonly channels: Partial<Record<ChannelId, ChannelRateControlConfig>>;
  /** ② 任务级静默窗口表：任务/触发源 key → 窗口表（解析后分钟形态） */
  readonly quietWindows: Readonly<Record<string, readonly QuietWindow[]>>;
}

export const DEFAULT_PROACTIVE_MESSAGE_CONFIG: ProactiveMessageConfig = {
  rateLimitPerMinute: 10,
  cooldownMs: 0,
  timeZoneOffsetMinutes: 480,
  channels: {},
  quietWindows: {},
};

/** 渠道条目解析时回落全局默认用的中间形态（字段可空） */
interface RawChannelEntry {
  rateLimitPerMinute: number | null;
  cooldownMs: number | null;
  defaultTarget: string | null;
}

export class ProactiveMessageConfigLoader {
  private readonly filePath: string;
  private cached: ProactiveMessageConfig = DEFAULT_PROACTIVE_MESSAGE_CONFIG;
  private cachedMtimeMs: number | null = null;

  /** filePath 指向 data/config/ 体系内的配置 JSON（由装配侧传入） */
  constructor(filePath: string) {
    this.filePath = filePath;
    this.cached = this.readOrDefault(null);
  }

  /** 取当前配置；文件 mtime 变化才重读（热生效），失败保留上次可用 */
  get(): ProactiveMessageConfig {
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

  private readOrDefault(mtimeMs: number | null): ProactiveMessageConfig {
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
          'proactive-message config reload failed; keeping last-good config',
        );
      } else {
        logger.info(
          { file: this.filePath },
          'proactive-message config absent; using minimal-suppression defaults',
        );
      }
      return mtimeMs === null && this.cachedMtimeMs === null
        ? DEFAULT_PROACTIVE_MESSAGE_CONFIG
        : this.cached;
    }
  }
}

/**
 * 渠道频控解析：渠道覆盖 → 全局默认 → 模块缺省，三级回落一次算清。
 * 装配侧（B3 接线）对任意渠道取用，不自行拼默认值。
 */
export function resolveChannelRateControl(
  config: ProactiveMessageConfig,
  channelId: ChannelId,
): ChannelRateControlConfig {
  const channel = config.channels[channelId];
  return (
    channel ?? {
      rateLimitPerMinute: config.rateLimitPerMinute,
      cooldownMs: config.cooldownMs,
      defaultTarget: null,
    }
  );
}

// ─── 内部：宽松解析（非法字段回缺省/跳过条目，不让坏配置炸掉投递） ──

function parseConfig(raw: Record<string, unknown>): ProactiveMessageConfig {
  const rateLimitPerMinute = positiveInt(raw.rateLimitPerMinute) ?? 10;
  const cooldownMs = nonNegativeInt(raw.cooldownMs) ?? 0;
  const timeZoneOffsetMinutes =
    utcOffsetMinutes(raw.timeZoneOffsetMinutes) ?? 480;
  return {
    rateLimitPerMinute,
    cooldownMs,
    timeZoneOffsetMinutes,
    channels: parseChannels(raw.channels, {
      rateLimitPerMinute,
      cooldownMs,
    }),
    quietWindows: parseQuietWindowTable(
      raw.quietWindows,
      timeZoneOffsetMinutes,
    ),
  };
}

function parseChannels(
  raw: unknown,
  globalDefaults: { rateLimitPerMinute: number; cooldownMs: number },
): Partial<Record<ChannelId, ChannelRateControlConfig>> {
  const source = asObject(raw);
  if (!source) return {};
  const knownIds = new Set<string>(CHANNEL_IDS);
  const channels: Partial<Record<ChannelId, ChannelRateControlConfig>> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!knownIds.has(key)) {
      // 渠道 key 必须 ∈ 注册表派生联合：登记外条目不进生效配置
      logger.warn(
        { channel: key },
        'proactive-message config has unknown channel id (not in channel-registry); entry skipped',
      );
      continue;
    }
    const entry = asObject(value);
    if (!entry) continue;
    const target = entry.defaultTarget;
    channels[key as ChannelId] = {
      rateLimitPerMinute:
        positiveInt(entry.rateLimitPerMinute) ??
        globalDefaults.rateLimitPerMinute,
      cooldownMs: nonNegativeInt(entry.cooldownMs) ?? globalDefaults.cooldownMs,
      defaultTarget:
        typeof target === 'string' && target.trim() ? target : null,
    };
  }
  return channels;
}

function parseQuietWindowTable(
  raw: unknown,
  timeZoneOffsetMinutes: number,
): Record<string, readonly QuietWindow[]> {
  const source = asObject(raw);
  if (!source) return {};
  const table: Record<string, readonly QuietWindow[]> = {};
  for (const [taskKey, value] of Object.entries(source)) {
    if (!Array.isArray(value)) continue;
    const windows: QuietWindow[] = [];
    for (const item of value) {
      const entry = asObject(item);
      const start = parseMinuteOfDay(entry?.start);
      const end = parseMinuteOfDay(entry?.end);
      if (start === null || end === null) {
        logger.warn(
          { taskKey },
          'proactive-message config has invalid quiet window (need "HH:mm" start/end); entry skipped',
        );
        continue;
      }
      windows.push({
        startMinuteOfDay: start,
        endMinuteOfDay: end,
        days: parseDays(entry?.days),
        timeZoneOffsetMinutes,
      });
    }
    if (windows.length > 0) table[taskKey] = windows;
  }
  return table;
}

/** days 声明：0..6 整数过滤去重；声明缺失/非法 → 空数组（= 每天生效） */
function parseDays(raw: unknown): readonly number[] {
  if (!Array.isArray(raw)) return [];
  const days = raw
    .filter(
      (day): day is number =>
        typeof day === 'number' &&
        Number.isInteger(day) &&
        day >= 0 &&
        day <= 6,
    )
    .map((day) => day);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** "HH:mm" → 当天分钟数；非法声明返回 null（调用方跳过该条目） */
function parseMinuteOfDay(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 固定 UTC 偏移（分钟）：现实时区范围 -12:00..+14:00 */
function utcOffsetMinutes(raw: unknown): number | null {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < -720 ||
    raw > 840
  ) {
    return null;
  }
  return raw;
}

function positiveInt(raw: unknown): number | null {
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    Number.isFinite(raw) &&
    raw > 0
    ? raw
    : null;
}

function nonNegativeInt(raw: unknown): number | null {
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    Number.isFinite(raw) &&
    raw >= 0
    ? raw
    : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
