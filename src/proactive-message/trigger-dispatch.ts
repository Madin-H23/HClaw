/**
 * 触发源无关投递分发 — 调度器 = 第一个公民（票 #24，SPEC #20 seam 2 上游侧）
 *
 * 触发源接口（解耦设计，票面硬约束）：本模块定义**触发源无关**的投递请求形状
 * ProactiveTriggerRequest（triggerKind + triggerKey + content + channels +
 * source 身份），调度器只是它的第一个实现者——批三事件总线接入时构造同形
 * 请求（triggerKind: 'event-bus'）调 deliverProactiveTrigger 即可，**频控层
 * （delivery-decision/state-store）与渠道层（delivery-assembly/channel-registry）
 * 零改动**（SPEC Further Notes：触发源接口按「调度器只是第一个公民」设计）。
 * 本票不预写事件总线实现，只留接口位。
 *
 * 主流程 deliverProactiveTrigger：
 *   声明渠道逐一 → per-send 超时竞速包裹 assembly.notify → 结果映射为审计
 *   事实（outcome）→ 逐条落投递记录库（delivery-log.ts）→ 汇总返回。
 *   任何单渠道故障（notify reject / 超时 / 审计写失败）都**内化为该渠道的
 *   可区分结果**，不以 rejection 逃出本函数——调度循环的最终兜底仍由调度器
 *   侧 catch 承接（B3 审查移交承接②的「建议」层），两层防御各管一半。
 *
 * per-send 超时（B3 承接①，⚠ 必承接项）**选型论证**：二选一中取
 * 「per-send 超时（竞速）」并顺带获得并发隔离——
 *   1. 并发隔离（把 notify 扔进 detached 异步不 await）只解除「阻塞」，不
 *      给出**有界**完成时间：悬挂的发送永远占着一个 in-flight 槽，审计与
 *      运行日志都无从收口；超时给出确定性上界（默认 10s）。
 *   2. 超时结果本身是可观察行为（send-timeout 审计记录 + WARN），满足
 *      SPEC user story 10「事后可审计」；并发隔离的超时悬挂在审计上是盲区。
 *   3. AbortSignal 无法真正中止上游适配器的 WS/HTTP 发送（接口不收
 *      signal），竞速是零新依赖下唯一可行机械；被超时抛弃的 notify promise
 *      挂 catch 吸收迟到 rejection（不产生 unhandled rejection），若发送
 *      其后实际完成：频控库如实记「实际发生」（限速照算），审计库记
 *      「观察到的超时」——两账本口径差异有意为之，注释与测试钉死。
 *   4. 声明渠道间并行（Promise.all + 每渠道内部全承接）是超时的自然补充：
 *      一个慢渠道不再拖累其他渠道，最坏总耗时 = timeout 而非 N × timeout。
 *      渠道间无共享可变状态（频控状态按渠道分键，SQLite 写入自串行），并行
 *      安全。
 *
 * 补发语义（B3 承接③，不另建机制）：本分发器**无状态**——hold 的结果不
 * 重试、不排队、不记忆；触发源（调度器）按原节奏下次触发时重新走完整决策
 * 自然补发。测试以「静默窗口内 hold → 窗口外再触发 sent」端到端钉死。
 *
 * 与上游旧投递路径的关系（双投收敛，方案②已落地——票 #26，维护者终裁）：
 * 任务完成点的上游投递面（storeResultAndNotify → sendImWithRetry：agent 任务
 * 错误通知、脚本任务完成通知，投往任务绑定与 fan-out 渠道）在 notify_channels
 * **声明渠道上让位**——调度器两完成点把传给 storeResultAndNotify 的
 * notifyChannels 经 legacyFanOutChannelsAfterYield 收窄（声明中的注册表内渠道
 * 剔除，归本入口独占投递），旧 fan-out 对这些渠道不再产生发送，同轮双投消除。
 * 让位前核实过错误要素：本入口 content 在 error 场景已含错误详情（agent 完成点
 * taskSessionText = `执行出错: <error>`、脚本完成点 fullText =
 * `[脚本] 执行失败: <error>…`，均带任务头前缀进入 content），让位不丢错误感知
 * （集成测钉死）。注册表外声明 id **不让位**（normalizeDeclaredChannels 会跳过
 * 它们，本入口不投）——旧路径保持唯一投递者。绑定渠道（delivery_route_jid）
 * 投递、任务会话消息（groupJid 转写）不在让位范围，未声明渠道行为零变化。
 * 历史（悬置期结论，保留备查）：两路对同一渠道的重复投递不能靠冷却去重吸收
 * ——本入口内容带任务头前缀，SHA-256 摘要与旧路径原文必异（冷却键含摘要）；
 * 且旧路径不写频控库，跨路径无账可查——这正是选择让位（方案②）而非内容
 * 对齐（方案①）的实证依据。
 *
 * 生产工厂 createSchedulerProactiveNotifier：供 src/index.ts schedulerDeps
 * 注入级接线（构造不抛错——频控库/审计库构造失败分别降级 fail-open /
 * 免审计，调度启动不因主动消息域故障受阻）；渠道适配器解析缝生产绑定归 B5
 * （真机凭证步骤），B4 注入恒 null → 送达路径按 adapter-unavailable 跳过，
 * 频控判定与审计照常走通。
 */
import type { ChannelId } from '../channel-registry.js';
import { CHANNEL_IDS } from '../channel-registry.js';
import { logger } from '../logger.js';
import {
  createProactiveMessageAssembly,
  type ProactiveChannelAdapterResolver,
  type ProactiveDeliveryRequest,
  type ProactiveNotifyResult,
} from './delivery-assembly.js';
import {
  ProactiveDeliveryLogStore,
  DELIVERY_RETENTION_MS,
} from './delivery-log.js';

// ─── 触发源接口（触发源无关；批三事件总线可插） ──────────────

/**
 * 触发源种类：'scheduled-task' = 上游定时调度器（MVP，本票）；批三事件总线
 * 以新值扩展（如 'event-bus'），频控层与渠道层对该字段不敏感（只透传进审计）。
 */
export type ProactiveTriggerKind = 'scheduled-task';

/**
 * 触发源无关的投递请求：任意触发源把「要说的话 + 声明的目标渠道 + 身份」
 * 归一成此形状交给分发器。triggerKey 是频控语义键（= assembly 的 messageKey：
 * 静默窗口表 quietWindows[triggerKey] 与冷却去重第二维），调度器触发源取
 * 任务 id；content 为已成形纯文本（内容塑形是触发源侧职责，分发器不改写）。
 */
export interface ProactiveTriggerRequest {
  readonly triggerKind: ProactiveTriggerKind;
  readonly triggerKey: string;
  readonly content: string;
  /** 声明投递的目标渠道（已归一化：normalizeDeclaredChannels 产物） */
  readonly channels: readonly ChannelId[];
  /** 来源身份（审计用；事件总线触发源可缺省或给事件标识） */
  readonly sourceTask?: {
    readonly taskId: string;
    readonly runId: string | null;
  };
  /**
   * 本次运行的触发方式（调度器源：'manual'=手动触发 / 'scheduled'=按计划
   * 触发），透传进审计使手动/定时可分辨；缺省折 'scheduled'。
   */
  readonly triggerType?: 'manual' | 'scheduled';
}

/** 单渠道投递的可观察结果（审计口径，与频控库的「实际发送」口径不同） */
export type ProactiveDeliveryOutcomeKind =
  | 'sent'
  | 'hold'
  | 'discard'
  | 'skipped'
  | 'send-failed'
  | 'send-timeout';

export interface ProactiveDeliveryAttempt {
  readonly channelId: ChannelId;
  readonly outcome: ProactiveDeliveryOutcomeKind;
  /** 目标（sent/send-failed 时由 notify 结果携带；其余阶段可能未解析到） */
  readonly target: string | null;
  /** 一行中文理由（决策理由/失败原因透传） */
  readonly reason: string | null;
}

export interface ProactiveTriggerDeliverySummary {
  readonly attempts: readonly ProactiveDeliveryAttempt[];
  /** 送达失败数（send-failed + send-timeout）——调度器据此在任务运行日志留痕 */
  readonly failedCount: number;
}

/** 任务运行日志「送达失败」判定：只有真发送失败算，压制类不算（文案见调度器侧） */
export function isFailedDeliveryOutcome(
  outcome: ProactiveDeliveryOutcomeKind,
): boolean {
  return outcome === 'send-failed' || outcome === 'send-timeout';
}

// ─── 分发器 ──────────────────────────────────────────────────

export interface DeliverTriggerOptions {
  /**
   * per-send 超时（毫秒）：单渠道 notify 的完成上界。缺省 10s——上游适配器
   * 发送路径多为秒级 HTTP/WS 往返，10s 覆盖慢链路同时把悬挂损失钉在可接受
   * 量级；测试注入小值。
   */
  readonly sendTimeoutMs?: number;
  /** 注入时钟（毫秒）；审计记录 createdAtMs 与装配决策 nowMs 由测试同源注入 */
  readonly nowMs?: () => number;
  /** 投递记录库；缺省 null = 不落审计（生产工厂必传；构造失败降级也落在这里） */
  readonly deliveryLog?: ProactiveDeliveryLogStore | null;
}

/** 默认 per-send 超时：10 秒（选型论证见文件头） */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/**
 * 逐渠道投递一次触发源请求。**公开面承诺：永不 reject**——单渠道的一切故障
 * 都折成该渠道的可区分 outcome（含 notify 调用本身 reject → send-failed）。
 */
export async function deliverProactiveTrigger(
  notify: (request: ProactiveDeliveryRequest) => Promise<ProactiveNotifyResult>,
  request: ProactiveTriggerRequest,
  options: DeliverTriggerOptions = {},
): Promise<ProactiveTriggerDeliverySummary> {
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const nowMs = options.nowMs ?? Date.now;
  const deliveryLog = options.deliveryLog ?? null;

  const attempts = await Promise.all(
    request.channels.map(
      async (channelId): Promise<ProactiveDeliveryAttempt> => {
        // per-send 超时竞速（B3 承接①；机械与两账本口径见文件头）
        let timer: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;
        const notifyPromise = (async () =>
          notify({
            channelId,
            messageKey: request.triggerKey,
            content: request.content,
          }))();
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new SendTimeoutError(`主动消息发送超时（${sendTimeoutMs}ms）`),
            );
          }, sendTimeoutMs);
          // 超时哨兵不保活进程（unref）；竞速结束后显式清除
          timer?.unref?.();
        });
        let outcome: ProactiveDeliveryOutcomeKind;
        let target: string | null = null;
        let reason: string | null = null;
        try {
          const result = await Promise.race([notifyPromise, timeoutPromise]);
          // notify 可区分结果 → 审计口径映射（reject 分支在下方 catch）
          outcome = result.kind === 'sent' ? 'sent' : result.kind;
          if (result.kind === 'sent' || result.kind === 'send-failed') {
            target = result.target;
          }
          reason = result.reason;
        } catch (err) {
          if (timedOut && err instanceof SendTimeoutError) {
            // 超时抛弃的 notify promise 挂 catch 吸收迟到 rejection——不产生
            // unhandled rejection；迟到解析的返回值丢弃（不重复记审计）。
            notifyPromise.catch(() => {});
            outcome = 'send-timeout';
            reason = err.message;
            logger.warn(
              {
                channelId,
                triggerKind: request.triggerKind,
                triggerKey: request.triggerKey,
                taskId: request.sourceTask?.taskId ?? null,
                sendTimeoutMs,
              },
              '主动消息发送超时：渠道适配器未在上界内完成（per-send timeout）',
            );
          } else {
            // notify 公开面 reject 仅在装配自身意外（B3 承接②口径）：折
            // send-failed 内化，不让异常逃出本函数
            const message = err instanceof Error ? err.message : String(err);
            outcome = 'send-failed';
            reason = `投递异常：${message}`;
            logger.warn(
              {
                channelId,
                triggerKind: request.triggerKind,
                triggerKey: request.triggerKey,
                taskId: request.sourceTask?.taskId ?? null,
                err: message,
              },
              '主动消息投递调用异常；折 send-failed 内化（不让 rejection 逃出分发器）',
            );
          }
        } finally {
          if (timer !== null) clearTimeout(timer);
        }

        deliveryLog?.recordDelivery({
          channelId,
          target,
          messageKey: request.triggerKey,
          outcome,
          reason,
          triggerKind: request.triggerKind,
          triggerType: request.triggerType ?? 'scheduled',
          taskId: request.sourceTask?.taskId ?? null,
          runId: request.sourceTask?.runId ?? null,
          createdAtMs: nowMs(),
        });
        return { channelId, outcome, target, reason };
      },
    ),
  );

  // 审计 prune 顺带调度（沿 B3 装配的 record+prune 形态）；失败由库内吸收
  deliveryLog?.prune(nowMs(), DELIVERY_RETENTION_MS);

  return {
    attempts,
    failedCount: attempts.filter((attempt) =>
      isFailedDeliveryOutcome(attempt.outcome),
    ).length,
  };
}

/** per-send 超时哨兵（内部用；isinstance 判定超时分支，普通异常走 send-failed） */
class SendTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendTimeoutError';
  }
}

// ─── 声明渠道归一化 ──────────────────────────────────────────

/**
 * 任务声明的通知渠道清单（上游 scheduled_tasks.notify_channels：渠道类型
 * 字符串数组，复用为主动消息投递声明——勿造第二事实源）→ 注册表渠道 id。
 * 登记外/拼错的 id 跳过并告警（数据陈旧不炸投递）；去重保序。
 */
export function normalizeDeclaredChannels(
  raw: readonly string[] | null | undefined,
): ChannelId[] {
  if (!raw || raw.length === 0) return [];
  const known = new Set<string>(CHANNEL_IDS);
  const channels: ChannelId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !known.has(item)) {
      logger.warn(
        { channel: item },
        '任务声明了注册表外的通知渠道 id；主动消息投递跳过该渠道',
      );
      continue;
    }
    if (!channels.includes(item as ChannelId)) {
      channels.push(item as ChannelId);
    }
  }
  return channels;
}

/**
 * 双投收敛方案②（票 #26）让位收窄：任务声明的 notify_channels 中，注册表内
 * 渠道已归主动消息路径独占投递（本文件 deliverProactiveTrigger 一侧），旧投递
 * 面的 fan-out（storeResultAndNotify → broadcastToOwnerIMChannels →
 * sendImWithRetry）在这些渠道上让位。调度器两完成点把传给 storeResultAndNotify
 * 的 notifyChannels 经本函数收窄——声明渠道从旧 fan-out 的允许清单中剔除即
 * 零发送（fan-out 只投清单内渠道类型，契约由 task-routing 既有测试钉死），
 * storeResultAndNotify 与 broadcastToOwnerIMChannels 的既有语义零改动；绑定
 * 渠道（deliveryRouteJid）投递不经此清单，不受让位影响。
 *
 * 边界（红线）：
 *   - 注册表外声明 id **不让位**（保留在返回清单中）——本入口的
 *     normalizeDeclaredChannels 不投它们，旧路径是唯一投递者，让位会丢错误
 *     感知；
 *   - null / 空清单原样透传（null 折 null）——未声明渠道的任务完成点传参
 *     与上游逐字节一致（零变化由测试钉死）。
 */
export function legacyFanOutChannelsAfterYield(
  notifyChannels: readonly string[] | null | undefined,
): string[] | null {
  if (!notifyChannels || notifyChannels.length === 0) {
    return notifyChannels ? [...notifyChannels] : null;
  }
  const proactiveOwned = new Set<string>(
    normalizeDeclaredChannels(notifyChannels),
  );
  return notifyChannels.filter((channel) => !proactiveOwned.has(channel));
}

// ─── 调度器注入闭包（SchedulerDependencies.notifyTaskResult 形状） ──

/** SchedulerDependencies.notifyTaskResult 的输入（调度器完成点已备齐的事实） */
export interface SchedulerProactiveTriggerInput {
  readonly taskId: string;
  /** V2 运行 id（isolated durable 运行）；脚本任务等无运行 id 时为 null */
  readonly runId: string | null;
  /** 本次运行的触发方式：manual=手动触发（triggerTaskNow 等）、scheduled=按计划触发 */
  readonly triggerType: 'manual' | 'scheduled';
  /** 任务声明的通知渠道清单（task.notify_channels 原样透传，归一化在此做） */
  readonly notifyChannels: readonly string[];
  /** 已成形纯文本内容（触发源侧已带任务头，分发器不改写） */
  readonly content: string;
}

export type SchedulerProactiveTrigger = (
  input: SchedulerProactiveTriggerInput,
) => Promise<ProactiveTriggerDeliverySummary>;

export interface SchedulerProactiveNotifierOptions {
  /** data/config/proactive-message.json（频控配置，热生效） */
  readonly configPath: string;
  /** data/db/proactive-message.db（频控状态库） */
  readonly rateControlDbPath: string;
  /** data/db/proactive-message-deliveries.db（投递审计库） */
  readonly deliveriesDbPath: string;
  /** 渠道适配器解析缝（生产绑定归 B5；B4 阶段恒 () => null） */
  readonly resolveAdapter: ProactiveChannelAdapterResolver;
  readonly sendTimeoutMs?: number;
  readonly nowMs?: () => number;
}

/**
 * 生产装配工厂：构造**永不抛错**（调度启动不得依赖主动消息域健康——
 * fail-open 纪律的构造侧落点）：
 *   - 装配构造（含频控状态库）失败 → createProactiveMessageAssembly 内已
 *     降级 stateStore=null（fail-open 直发，宁多勿丢）；
 *   - 审计库构造失败 → deliveryLog=null（免审计继续投递，WARN 明示）。
 * 返回闭包即 SchedulerDependencies.notifyTaskResult 的实现：归一化渠道 →
 * 组装触发源请求 → deliverProactiveTrigger。分发器本身不 reject；闭包再包
 * 一层兜底 catch 折成空失败摘要（结构化日志），调度器侧 catch 是最终防线
 * （B3 承接②两层防御）。
 */
export function createSchedulerProactiveNotifier(
  options: SchedulerProactiveNotifierOptions,
): SchedulerProactiveTrigger {
  const assembly = createProactiveMessageAssembly({
    configPath: options.configPath,
    dbPath: options.rateControlDbPath,
    resolveAdapter: options.resolveAdapter,
    nowMs: options.nowMs,
  });
  let deliveryLog: ProactiveDeliveryLogStore | null = null;
  try {
    deliveryLog = new ProactiveDeliveryLogStore(options.deliveriesDbPath);
  } catch (err) {
    logger.warn(
      {
        dbPath: options.deliveriesDbPath,
        err: err instanceof Error ? err.message : String(err),
      },
      '主动消息投递审计库构造失败；投递照常进行但不落审计记录',
    );
  }
  return async (input) => {
    const channels = normalizeDeclaredChannels(input.notifyChannels);
    if (channels.length === 0) {
      return { attempts: [], failedCount: 0 };
    }
    try {
      return await deliverProactiveTrigger(
        (request) => assembly.notify(request),
        {
          triggerKind: 'scheduled-task',
          triggerKey: input.taskId,
          content: input.content,
          channels,
          sourceTask: { taskId: input.taskId, runId: input.runId },
          triggerType: input.triggerType,
        },
        {
          sendTimeoutMs: options.sendTimeoutMs,
          nowMs: options.nowMs,
          deliveryLog,
        },
      );
    } catch (err) {
      // 理论不可达（分发器承诺不 reject）；兜底折成空失败摘要 + 结构化日志，
      // 调度器侧 catch 仍是最终防线
      logger.error(
        {
          taskId: input.taskId,
          err: err instanceof Error ? err.message : String(err),
        },
        '主动消息分发器意外抛错（兜底承接）；不影响任务收尾',
      );
      return { attempts: [], failedCount: 0 };
    }
  };
}
