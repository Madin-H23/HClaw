/**
 * 投递决策纯函数 — 主动消息三层频控的裁决缝（批二 B2，票 #22，SPEC #20）
 *
 * 输入 = 渠道 id（channel-registry 派生联合）+ 目标 + 消息类型 key + 内容摘要
 * + 三层频控配置 + 频控状态快照 + 注入时钟；输出 = 送达 | 持有 | 丢弃 + 一行
 * 中文理由（可解释性硬要求，沿 quota-router 路由决策纯函数 T5 的形态）。
 * 零 IO、零全局时钟——nowMs 与状态全部由参数注入，同输入必同输出（幂等），
 * 时间推进只体现为 nowMs 变化，函数自身无任何隐藏读取。
 *
 * 三层语义（票面 #22，与 CONTEXT.md「频控」词条逐条对齐）：
 * ① 渠道全局限速：滑动窗口（60 秒，RATE_WINDOW_MS）内该渠道实际发送已达上限
 *   → 持有（限速只针对「已实际发出」的记录，持有本身不占额度）；
 * ② 任务级静默窗口：当前时刻落在该任务的窗口表内 → 持有；窗口结束后的首次
 *   触发自然满足「窗口外」条件而送达——持有没有独立定时器，补发 = 调用方
 *   下次触发时重新决策（MVP 语义，SPEC #20 Implementation Decisions）；
 * ③ 冷却去重：同渠道 + 同目标 + 同消息类型 key 在冷却窗内已发过**同内容**
 *   （contentDigest 相同）→ 丢弃（重复播报没有投递价值，永久放弃）。
 *
 * 评估顺序（刻意，与票面①②③的taxonomy序不同）：fail-open → 冷却丢弃 →
 * 静默持有 → 限速持有 → 送达。理由：
 * - 冷却最先：丢弃是最强节制，且冷却窗常比静默窗口更长——若先持有，窗口结束
 *   补发时冷却多半已把该消息判为重复（或更糟：冷却恰好过期让过期重复补发出去，
 *   违背去重意图）。重复消息当场丢弃，不为它保留重试预算。
 * - 静默先于限速：两者都是持有，但静默窗口决定了消息最早何时能走（限速只延迟
 *   分钟级，静默延迟小时级），对人有信息量的理由是静默。
 *
 * fail-open 方向辨析（钉死，评审与测试按此方向双钉——SPEC #20 Further Notes）：
 * - **额度路由（ADR-0004）fail-open = 宁可不放行**：准入语义，额度数据缺失时
 *   放行候选去撞上游原生策略，绝不因额度组件故障拒绝服务；
 * - **频控（ADR-0008，本函数）fail-open = 宁可放行（宁多勿丢）**：通知语义，
 *   频控组件自身拿不到频控状态（状态存储故障，state=null）时消息**直发**——
 *   一个坏掉的节流阀永远不应该成为静音键。两条方向相反且都成立，不可混淆：
 *   前者防「数据坏了挡服务」，后者防「节流器坏了吞通知」。
 * - 存储层自身的读失败折空状态（state-store 公开面不抛错，折空 = 无记录 =
 *   三层全放行），与本函数的 null 分支同向：任何一环拿不到状态都是多发而非
 *   少发。冷却去重在状态缺失时同样放行——宁多勿丢没有「该去重时去重」的例外。
 *
 * 边界口径（测试逐条钉死）：
 * - 限速滑动窗口：统计 sentAtMs > nowMs - RATE_WINDOW_MS 的记录（恰好整窗老
 *   的记录过期不计；含未来时间戳——时钟回拨保守处理，宁可多算不多发）；
 * - 静默窗口：起点含、终点不含（[start, end)，分钟粒度）——终点分钟已在窗外，
 *   窗口结束那一刻的首次触发即送达（补发语义的落点）；跨零点窗口 start > end
 *   合法；start === end 视为全天静默；星期锚定窗口起点所在日（跨零点段锚昨日）；
 * - 冷却窗：nowMs - sentAtMs < cooldownMs 判重复（恰好等于冷却窗即过期放行）；
 *   cooldownMs <= 0 视为去重关闭。
 */
import type { ChannelId } from '../channel-registry.js';

// ─── 输入形状 ────────────────────────────────────────────────

/** 渠道全局限速的滑动窗口宽度：channelLimitPerMinute 的「分钟」即 60 秒整 */
export const RATE_WINDOW_MS = 60_000;

/**
 * 任务级静默窗口（解析后形态）：配置层的 HH:mm 声明在装载时折算为分钟数，
 * 本函数不再做字符串解析——时间语义全部数值化，保证纯函数确定性。
 */
export interface QuietWindow {
  /** 窗口起点，一天内的分钟数（0..1439，窗口时区） */
  readonly startMinuteOfDay: number;
  /** 窗口终点，同上；跨零点 = start > end；start === end 视为全天静默 */
  readonly endMinuteOfDay: number;
  /**
   * 生效星期（0=周日..6=周六，锚定窗口起点所在日、按窗口时区）；
   * 空数组 = 每天生效。
   */
  readonly days: readonly number[];
  /** 窗口时区的固定 UTC 偏移（分钟）；个人自托管场景用固定偏移，不做 DST */
  readonly timeZoneOffsetMinutes: number;
}

/** 频控状态快照（由调用方从状态存储读取后组装；本函数零 IO） */
export interface RateControlState {
  /**
   * 该渠道（全目标合并——限速是渠道全局语义）滑动窗口查询范围内的发送时间戳
   * （毫秒）。调用方按 nowMs - RATE_WINDOW_MS 起查即可；本函数仍按自身 nowMs
   * 过滤，保证任意超集输入下结论一致。
   */
  readonly recentSendTimesMs: readonly number[];
  /**
   * 同渠道 + 同目标 + 同消息类型 key 的近期发送记录（冷却去重比对用，含内容
   * 摘要）；调用方按冷却窗上限起查。同 key 存在 A-B-A 交替内容时，任一窗内
   * 同摘要记录都构成重复（不只因「最近一条」）。
   */
  readonly recentSendsOfKey: readonly {
    readonly sentAtMs: number;
    readonly contentDigest: string;
  }[];
}

/** 投递决策输入：三层配置 + 状态 + 时钟全部显式注入（无隐藏读取） */
export interface DeliveryDecisionInput {
  /** 渠道 id：channel-registry 派生联合（ChannelId），不收裸字符串 */
  readonly channelId: ChannelId;
  /** 私聊目标（会话/收件 id）；限速不看它，冷却去重按渠道+目标+类型隔离 */
  readonly target: string;
  /** 消息类型 key（任务/触发源侧的身份键，冷却去重第二维） */
  readonly messageKey: string;
  /** 内容摘要：调用侧自行摘要化后的稳定标识，冷却去重的「同内容」判据 */
  readonly contentDigest: string;
  /** ① 渠道全局限速：滑动窗口（RATE_WINDOW_MS）内允许的最大发送条数 */
  readonly channelLimitPerMinute: number;
  /** ② 任务级静默窗口表（该消息所属任务解析后的窗口；空表 = 无静默） */
  readonly quietWindows: readonly QuietWindow[];
  /** ③ 冷却窗毫秒：同渠道+目标+类型+同内容在该窗内只发一次；<=0 = 关闭 */
  readonly cooldownMs: number;
  /**
   * 频控状态快照；**null = 频控状态不可用（状态存储故障）→ fail-open 送达**
   * （宁多勿丢，ADR-0008——方向与额度路由 ADR-0004 相反，见文件头辨析）。
   */
  readonly state: RateControlState | null;
  /** 注入时钟（毫秒时间戳）——纯函数禁止自取时钟 */
  readonly nowMs: number;
}

// ─── 输出形状 ────────────────────────────────────────────────

/** 送达：三层均未命中，或 fail-open 放行（failOpen=true 标记供审计/测试） */
export interface DeliverDecision {
  readonly kind: 'deliver';
  /** 一行中文理由（非空、非黑话——验收硬要求） */
  readonly reason: string;
  /** true = 状态不可用走 fail-open 放行（宁多勿丢）；false = 三层正常放行 */
  readonly failOpen: boolean;
}

/** 持有：本次不发也不弃，调用方下次触发时重新决策（窗口结束自然补发） */
export interface HoldDecision {
  readonly kind: 'hold';
  readonly reason: string;
  /** 持有因由：静默窗口（等待窗口结束）| 渠道限速（等待滑动窗口腾位） */
  readonly holdKind: 'quiet-window' | 'rate-limit';
}

/** 丢弃：冷却去重命中的重复内容，永久放弃（持有才有补发，丢弃没有） */
export interface DiscardDecision {
  readonly kind: 'discard';
  readonly reason: string;
}

/** 投递决策：送达 | 持有 | 丢弃（每个决策附一行中文理由） */
export type DeliveryDecision = DeliverDecision | HoldDecision | DiscardDecision;

// ─── 主入口 ──────────────────────────────────────────────────

/**
 * 投递决策主函数（SPEC #20「投递决策纯函数」缝）。
 * 评估顺序见文件头；全程零 IO、零时钟读取，同输入必同输出。
 */
export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  // fail-open 第一优先：状态不可用 → 直发。一个坏掉的节流阀不该成为静音键
  // （宁多勿丢，ADR-0008；与额度路由「故障不放行」方向刻意相反）。
  if (input.state === null) {
    return {
      kind: 'deliver',
      failOpen: true,
      reason: `送达：渠道 ${input.channelId} 频控状态不可用，按 fail-open 放行直发（通知宁多勿丢）`,
    };
  }

  // ③ 冷却去重 → 丢弃（最先评估：重复消息当场放弃，不为它保留重试预算）
  if (input.cooldownMs > 0) {
    const duplicate = input.state.recentSendsOfKey.find(
      (send) =>
        input.nowMs - send.sentAtMs < input.cooldownMs &&
        send.contentDigest === input.contentDigest,
    );
    if (duplicate) {
      const ageMinutes = Math.max(
        0,
        Math.round((input.nowMs - duplicate.sentAtMs) / 60_000),
      );
      return {
        kind: 'discard',
        reason: `丢弃：同渠道同类型消息约 ${ageMinutes} 分钟前已发过相同内容，冷却去重命中（冷却窗 ${Math.round(input.cooldownMs / 60_000)} 分钟），重复播报不再投递`,
      };
    }
  }

  // ② 任务级静默窗口 → 持有（窗口结束后首次触发自然补发，见文件头）
  const activeWindow = activeQuietWindow(input.quietWindows, input.nowMs);
  if (activeWindow) {
    return {
      kind: 'hold',
      holdKind: 'quiet-window',
      reason: `持有：当前处于任务级静默窗口（${formatMinuteOfDay(activeWindow.startMinuteOfDay)}–${formatMinuteOfDay(activeWindow.endMinuteOfDay)}），窗口结束后首次触发补发`,
    };
  }

  // ① 渠道全局限速 → 持有（滑动窗口内已实际发送达上限）
  const limit = input.channelLimitPerMinute;
  if (limit > 0) {
    const sentCount = input.state.recentSendTimesMs.filter(
      (sentAtMs) => sentAtMs > input.nowMs - RATE_WINDOW_MS,
    ).length;
    if (sentCount >= limit) {
      return {
        kind: 'hold',
        holdKind: 'rate-limit',
        reason: `持有：渠道 ${input.channelId} 滑动窗口内已发送 ${sentCount} 条，达到每分钟上限 ${limit} 条，待窗口腾位后随下次触发重试`,
      };
    }
  }

  return {
    kind: 'deliver',
    failOpen: false,
    reason: `送达：渠道 ${input.channelId} 频控三层均未命中（未达限速、无静默窗口、无冷却重复）`,
  };
}

// ─── 内部：静默窗口判定（分钟粒度，起点含终点不含） ───────────

/** 命中当前时刻的静默窗口；未命中返回 null（决策只需知道「在不在窗口内」） */
function activeQuietWindow(
  windows: readonly QuietWindow[],
  nowMs: number,
): QuietWindow | null {
  for (const window of windows) {
    if (!inWindowSpan(window, nowMs)) continue;
    if (windowDaysInclude(window, nowMs)) return window;
  }
  return null;
}

/** 时间段判定：[start, end) 分钟粒度；跨零点（start > end）环形区间；
 * start === end 视为全天静默。用固定 UTC 偏移平移后取 UTC 分量，
 * 不触碰系统时区（零全局状态）。 */
function inWindowSpan(window: QuietWindow, nowMs: number): boolean {
  const minuteOfDay = minuteOfDayAt(nowMs, window.timeZoneOffsetMinutes);
  if (window.startMinuteOfDay === window.endMinuteOfDay) return true;
  if (window.startMinuteOfDay < window.endMinuteOfDay) {
    return (
      minuteOfDay >= window.startMinuteOfDay &&
      minuteOfDay < window.endMinuteOfDay
    );
  }
  return (
    minuteOfDay >= window.startMinuteOfDay ||
    minuteOfDay < window.endMinuteOfDay
  );
}

/** 星期判定：锚定窗口起点所在日——跨零点窗口的凌晨段（minuteOfDay < start）
 * 属于「昨天开始的那个窗口」，按昨天的星期过滤。 */
function windowDaysInclude(window: QuietWindow, nowMs: number): boolean {
  if (window.days.length === 0) return true;
  const shiftedMs = nowMs + window.timeZoneOffsetMinutes * 60_000;
  const minuteOfDay = minuteOfDayAt(nowMs, window.timeZoneOffsetMinutes);
  const anchorIsYesterday =
    window.startMinuteOfDay > window.endMinuteOfDay &&
    minuteOfDay < window.startMinuteOfDay;
  const anchorDow = new Date(
    anchorIsYesterday ? shiftedMs - 86_400_000 : shiftedMs,
  ).getUTCDay();
  return window.days.includes(anchorDow);
}

/** 窗口时区的「当天分钟数」：固定偏移平移后读 UTC 分量（分钟粒度截断） */
function minuteOfDayAt(nowMs: number, offsetMinutes: number): number {
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** 理由文案用的 HH:mm（窗口声明原样折算，不涉时区回读） */
function formatMinuteOfDay(minuteOfDay: number): string {
  const hours = String(Math.floor(minuteOfDay / 60) % 24).padStart(2, '0');
  const minutes = String(minuteOfDay % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}
