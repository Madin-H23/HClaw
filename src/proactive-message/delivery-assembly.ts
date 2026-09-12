/**
 * 投递入口装配 — 主动消息全链「通电」层（批二 B3，票 #23，SPEC #20 seam 2）
 *
 * 决策逻辑全在 delivery-decision.ts（B2 纯函数）、频控状态在 state-store.ts、
 * 配置在 config.ts；本文件只做依赖组装与决策副作用消费（发送/落库/修剪/日志），
 * 沿 quota-router/assembly.ts（T6）形态：依赖全部构造注入——测试用假适配器
 * 驱动真装配，未来 desktop 装配直接复用本类（不接调度器，归 B4）。
 *
 * notify({ channelId, messageKey, content }) 主流程（冷却键控需要 target 参与，
 * 故目标解析在决策之前，票面流程图的「决策→解析目标」在此展开为）：
 *   配置（热生效）→ resolveChannelRateControl（承接⑤：统一取用，装配不自行
 *   拼默认值）→ 默认私聊目标（null → 跳过+结构化日志，承接⑥）→ 内容摘要
 *   （承接⑧）→ 读频控状态 → decideDelivery（承接⑥：静默窗口经
 *   config.quietWindows[messageKey] 注入——messageKey 即任务 key，调度配置只持
 *   taskKey 关联，窗口唯一声明在 proactive-message.json，双事实源禁令）
 *   → 送达时：解析渠道适配器（null 或 resolver 违约抛错 → 跳过）→ 发送 →
 *   recordSend（承接②：
 *   仅真实发送成功后落库，持有/丢弃/发送失败不落；sentAtMs 与决策 nowMs 同源
 *   注入，装配不自取时钟）→ prune 顺带调度（承接③）。
 *
 * 持有/补发语义（承接⑦，SPEC #20 Implementation Decisions 钉死）：hold **没有
 * 独立定时器，本装配不做任何重试、排队或状态残留**——被持有的消息由触发源
 * 下次调用 notify 时重新走完整决策自然补发（静默窗口结束后的首次触发即送达；
 * 限速腾位后随下次触发重试）。本入口绝不因「上次 hold 过」跳过后续触发；
 * 只有冷却丢弃（discard）是永久放弃。
 *
 * fail-open 两入口（承接④，方向钉死——通知宁多勿丢 ADR-0008，与额度路由
 * ADR-0004 相反勿混淆）：
 *   - 构造失败降级：stateStore=null（createProactiveMessageAssembly 内
 *     try/catch 承接 RateControlStateStore 构造抛错）→ 决策 state=null →
 *     直发 failOpen=true；
 *   - 读失败折空：store 公开面不抛错（B2 承诺），读失败折空数组 = 无记录 =
 *     三层全放行 → 决策 failOpen=false；
 *   任一环拿不到状态都是多发而非少发。
 *
 * 三渠道私聊目标形态（探查记录，写入 config channels.<id>.defaultTarget；目标
 * 值原样透传给适配器 sendMessage 的 chatId 参数，真机冒烟归 B5）：
 *   - feishu：P2P 目标 = open_id（'ou_' 前缀）。feishu.ts sendToFeishu 按
 *     'oc_' 前缀区分 chat_id/open_id，'ou_' 走 receive_id_type=open_id。
 *   - wechat：裸微信用户 id（wxid_*）。wechat.ts sendMessage 依赖连接内
 *     context_token 缓存（仅来自此前入站消息）——目标账号须先私聊交互过才可
 *     主动发送（B5 真机步骤：先手动私聊一次再冒烟）。
 *   - dingtalk：c2c:<conversationId>（兼容 dingtalk:c2c: 前缀）。dingtalk.ts
 *     sendMessage 对 C2C 无 senderStaffId 时走 AI Card 兜底（conversationId
 *     直用），主动发送不依赖先入站消息。
 *
 * 渠道适配器实例获取缝（生产绑定设计，B5 落地；本票上游零 diff）：
 *   IMManager 把已连接适配器收在私有 connections Map<userId, UserIMConnection>
 *   （channels: Map<channelKey, IMChannel>，键形由私有 channelKey() 定：
 *   channelType 或 `channelType\u0000accountId`）；现有公开面只回布尔/类型清单
 *   （isChannelAccountConnected / getConnectedChannelTypes），拿不到实例。
 *   最小暴露设计：B5 时在 im-manager 增加一个公开只读方法
 *   getConnectedChannel(userId, channelType, accountId?): IMChannel | undefined
 *   ——内部复用 isOutboundConnectionAllowed 门控（与 findChannelForJid 同权限
 *   语义），属「只加 export」级零语义改动（T3 先例）；不复制 \u0000 键形直查
 *   （那是复制私有事实源，上游改键形会静默失效）。本票不实现：admin 的账户
 *   选择（多账户默认/指定）属 B5 凭证步骤。IMChannel → 端口的折算见
 *   bindImChannelAdapter——三渠道工厂产物（createFeishuChannel /
 *   createWeChatChannel / createDingTalkChannel）都结构满足 IMChannel，编译期
 *   接入由该函数的类型约束钉死。
 *
 * contentDigest 算法（承接⑧）：SHA-256 全长十六进制（node:crypto 内建，零新
 * 依赖）。摘要只用于冷却去重的相等比对，但选全长强哈希而非「长度+前缀」类弱
 * 摘要：同型通知内容高度相似（探活文案常只差一个字段），弱摘要会把不同内容
 * 误判为同内容造成漏发（宁多勿丢的反面）；SHA-256 对 KB 级通知成本可忽略，
 * 且跨进程跨重启稳定——落库摘要跨重启参与比对（state-store），算法一旦漂移
 * 等于冷却全部失忆，故以测试字面量钉死。
 */
import { createHash } from 'node:crypto';

import type { ChannelId } from '../channel-registry.js';
import type { IMChannel } from '../im-channel.js';
import { logger } from '../logger.js';
import {
  ProactiveMessageConfigLoader,
  resolveChannelRateControl,
  type ProactiveMessageConfig,
} from './config.js';
import {
  RATE_WINDOW_MS,
  decideDelivery,
  type RateControlState,
} from './delivery-decision.js';
import { RateControlStateStore } from './state-store.js';

// ─── 渠道发送端口（装配与渠道适配器之间的缝） ─────────────────

/**
 * 渠道发送端口：装配只依赖「能向私聊目标发纯文本」这一件事。
 * 契约：sendMessage resolve = 发送成功（装配据此 recordSend）；reject = 发送
 * 失败（装配记 send-failed 且不落库）。连接缺失必须挡在解析层（resolver 返回
 * null）——上游适配器对未连接/故障的表现不一（部分路径只告警返回 void 不抛
 * 错，部分会 throw），不能依赖 sendMessage 自身报错兜底，门控防退化。
 */
export interface ProactiveChannelAdapter {
  sendMessage(target: string, text: string): Promise<void>;
}

/**
 * 适配器解析缝：仅当该渠道已连接且可出站时返回发送端口，否则返回 null
 * （装配按「渠道不可用」跳过并记结构化日志）。契约要求「不抛错、以 null 表
 * 不可用」；实现侧违约抛错时装配就地承接、同样折成 adapter-unavailable
 * （仍是「不可发」语义，不违 fail-open），不让异常以 rejection 逃出 notify
 * 可区分联合。
 */
export type ProactiveChannelAdapterResolver = (
  channelId: ChannelId,
) => ProactiveChannelAdapter | null;

/**
 * IMChannel → 端口折算（生产绑定用，B5 接线；编译期接入点）：把上游已连接
 * 适配器实例包成 ProactiveChannelAdapter。三渠道工厂产物都满足 IMChannel，
 * 故任意渠道的连接实例经此函数即完成编译期对接。isConnected 门控对齐
 * im-manager findChannelForJid 的出站语义（socket 在 ≠ 有权发）。
 */
export function bindImChannelAdapter(
  getChannel: (channelId: ChannelId) => IMChannel | null | undefined,
): ProactiveChannelAdapterResolver {
  return (channelId) => {
    const channel = getChannel(channelId);
    if (!channel || !channel.isConnected()) return null;
    return {
      sendMessage: (target, text) => channel.sendMessage(target, text),
    };
  };
}

// ─── 输入/输出形状 ──────────────────────────────────────────

/** 一次主动消息投递请求（触发源侧只需给齐这三件事） */
export interface ProactiveDeliveryRequest {
  /** 渠道 id：channel-registry 派生联合 */
  readonly channelId: ChannelId;
  /** 消息类型 key：冷却去重第二维，同时是静默窗口表（quietWindows）的键 */
  readonly messageKey: string;
  /** 纯文本内容（SPEC：以纯文本送达 admin 私聊） */
  readonly content: string;
}

/** notify 可观察结果（外部行为口径：结果+目标+理由，供调用方审计/测试断言） */
export type ProactiveNotifyResult =
  | {
      readonly kind: 'sent';
      readonly target: string;
      /** 决策层一行中文理由（透传） */
      readonly reason: string;
      /** true = 频控状态不可用走 fail-open 直发（宁多勿丢） */
      readonly failOpen: boolean;
    }
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'discard'; readonly reason: string }
  | {
      readonly kind: 'skipped';
      readonly skipKind: 'no-target' | 'adapter-unavailable';
      readonly reason: string;
    }
  | {
      readonly kind: 'send-failed';
      readonly target: string;
      readonly reason: string;
    };

// ─── 装配类 ──────────────────────────────────────────────────

export interface ProactiveMessageAssemblyOptions {
  readonly configLoader: ProactiveMessageConfigLoader;
  /**
   * 频控状态存储；**null = 构造失败降级（承接①）**——决策按 state=null
   * fail-open 直发。由 createProactiveMessageAssembly 统一承接构造抛错；
   * 直构本类时同样允许显式传 null（测试/降级部署）。
   */
  readonly stateStore: RateControlStateStore | null;
  readonly resolveAdapter: ProactiveChannelAdapterResolver;
  /** 可注入时钟（毫秒）；决策与 recordSend 同源取这一个读点（承接②） */
  readonly nowMs?: () => number;
}

export class ProactiveMessageAssembly {
  private readonly options: ProactiveMessageAssemblyOptions;
  private readonly nowMs: () => number;

  constructor(options: ProactiveMessageAssemblyOptions) {
    this.options = options;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** 主动消息投递主入口（流程与失败语义见文件头） */
  async notify(
    request: ProactiveDeliveryRequest,
  ): Promise<ProactiveNotifyResult> {
    // 同源时钟（承接②）：整个投递周期只读一次时钟，决策与 recordSend 共用
    const nowMs = this.nowMs();
    const config = this.options.configLoader.get();

    // 承接⑤：三级回落一次算清（渠道覆盖 → 全局默认 → 模块缺省），装配不拼默认值
    const rateControl = resolveChannelRateControl(config, request.channelId);

    // 承接⑥：未配置默认私聊目标 → 明示跳过 + 结构化日志（不发、不落库）
    const target = rateControl.defaultTarget;
    if (target === null) {
      logger.warn(
        {
          channelId: request.channelId,
          messageKey: request.messageKey,
          skipKind: 'no-target',
        },
        '主动消息跳过：渠道未配置默认私聊目标（proactive-message.json channels.<id>.defaultTarget）',
      );
      return {
        kind: 'skipped',
        skipKind: 'no-target',
        reason: `跳过：渠道 ${request.channelId} 未配置默认私聊目标（defaultTarget 缺失）`,
      };
    }

    // 承接⑧：调用侧稳定摘要，与 recordSend 落库同口径
    const contentDigest = contentDigestOf(request.content);

    const decision = decideDelivery({
      channelId: request.channelId,
      target,
      messageKey: request.messageKey,
      contentDigest,
      channelLimitPerMinute: rateControl.rateLimitPerMinute,
      // 承接⑥：静默窗口按 taskKey（= messageKey）注入，无声明 = 无静默
      quietWindows: config.quietWindows[request.messageKey] ?? [],
      cooldownMs: rateControl.cooldownMs,
      state: this.readRateControlState(
        request.channelId,
        target,
        request.messageKey,
        rateControl.cooldownMs,
        nowMs,
      ),
      nowMs,
    });

    // 承接⑦：持有 = 本次不发也不弃，无定时器无排队，触发源下次 notify 重评估
    if (decision.kind === 'hold') {
      logger.info(
        {
          channelId: request.channelId,
          messageKey: request.messageKey,
          outcome: 'hold',
          reason: decision.reason,
        },
        '主动消息持有',
      );
      return { kind: 'hold', reason: decision.reason };
    }
    if (decision.kind === 'discard') {
      logger.info(
        {
          channelId: request.channelId,
          messageKey: request.messageKey,
          outcome: 'discard',
          reason: decision.reason,
        },
        '主动消息丢弃',
      );
      return { kind: 'discard', reason: decision.reason };
    }

    // 送达路径：解析渠道适配器（连接缺失挡在解析层，见端口契约）
    let adapter: ProactiveChannelAdapter | null;
    try {
      adapter = this.options.resolveAdapter(request.channelId);
    } catch (err) {
      // resolver 违约抛错（契约要求以 null 表不可用）：就地承接折成
      // adapter-unavailable——不可发语义不变，不让注入异常以 rejection 逃出
      // notify 可区分联合（B4 调度器若不接住即 unhandled rejection）
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          channelId: request.channelId,
          messageKey: request.messageKey,
          skipKind: 'adapter-unavailable',
          err: message,
        },
        '主动消息跳过：适配器解析缝抛错（resolver 契约违约），按渠道不可用处理',
      );
      return {
        kind: 'skipped',
        skipKind: 'adapter-unavailable',
        reason: `跳过：渠道 ${request.channelId} 适配器解析失败（${message}）`,
      };
    }
    if (!adapter) {
      logger.warn(
        {
          channelId: request.channelId,
          messageKey: request.messageKey,
          skipKind: 'adapter-unavailable',
        },
        '主动消息跳过：渠道适配器不可用（未连接或未装配）',
      );
      return {
        kind: 'skipped',
        skipKind: 'adapter-unavailable',
        reason: `跳过：渠道 ${request.channelId} 适配器不可用（未连接或未装配）`,
      };
    }

    try {
      // B4 承接项已落地（票 #24）：per-send 超时不加在本装配——notify 是
      // 「结果内化」的语义面，超时上界属触发源侧的节奏保障，由
      // trigger-dispatch.ts deliverProactiveTrigger 以竞速包裹本方法实现
      // （超时=可观察的 send-timeout 结果+WARN；悬挂渠道不再阻塞调度循环；
      // 调度器侧另有兜底 catch）。直接调用本方法的其他调用方仍需自行保障
      // 完成上界。
      await adapter.sendMessage(target, request.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          channelId: request.channelId,
          messageKey: request.messageKey,
          target,
          err: message,
        },
        '主动消息发送失败；不落发送记录（仅真实发送成功后 recordSend，承接②）',
      );
      return { kind: 'send-failed', target, reason: `发送失败：${message}` };
    }

    // 承接②：仅真实发送成功后落库；sentAtMs = 决策 nowMs（同源）；写失败由
    // store 公开面静默吸收（B2 承诺，不抛回装配）
    this.options.stateStore?.recordSend({
      channelId: request.channelId,
      target,
      messageKey: request.messageKey,
      contentDigest,
      sentAtMs: nowMs,
    });
    // 承接③：发送后顺带 prune；keepWindowMs 按当前配置取全渠道最大冷却窗与
    // 60 秒滑窗的较大者——少留会提前清掉冷却/滑窗内记录造成重复发送
    this.options.stateStore?.prune(nowMs, keepWindowMsFor(config));

    logger.info(
      {
        channelId: request.channelId,
        messageKey: request.messageKey,
        target,
        outcome: 'sent',
        failOpen: decision.failOpen,
        reason: decision.reason,
      },
      '主动消息已发送',
    );
    return {
      kind: 'sent',
      target,
      reason: decision.reason,
      failOpen: decision.failOpen,
    };
  }

  // ─── 内部 ─────────────────────────────────────────────────

  /**
   * 读频控状态快照：store=null（构造失败降级）→ 返回 null → 决策 fail-open
   * 直发（承接①④）；读失败由 store 公开面折空数组（承接④：全层放行，
   * failOpen=false）——本方法零 try/catch，故障语义全部落在 B2 两层承诺里。
   * 承接⑨：按 nowMs - window 起查即可（决策内部再过滤，超集查询不影响结论）：
   * 限速层窗口 = RATE_WINDOW_MS（60 秒滑窗）；冷却层查询窗 = max(cooldownMs,
   * RATE_WINDOW_MS)（冷却关闭时也保底 60 秒，恒为决策比较窗的超集）。
   */
  private readRateControlState(
    channelId: ChannelId,
    target: string,
    messageKey: string,
    cooldownMs: number,
    nowMs: number,
  ): RateControlState | null {
    const store = this.options.stateStore;
    if (!store) return null;
    return {
      recentSendTimesMs: store.recentSendTimesMs(
        channelId,
        nowMs - RATE_WINDOW_MS,
      ),
      recentSendsOfKey: store.recentSendsOfKey(
        channelId,
        target,
        messageKey,
        nowMs - Math.max(cooldownMs, RATE_WINDOW_MS),
      ),
    };
  }
}

/**
 * prune 保留窗（承接③）：≥ 全渠道最大 cooldownMs（含全局默认；渠道覆盖值
 * 已在配置解析时回落全局默认，不存空位）且 ≥ RATE_WINDOW_MS（60 秒滑窗）。
 * 按当前配置推导：配置缩窗时旧记录随之可清——决策比对永远用当前配置的窗，
 * 不会清掉仍有语义的记录。
 */
function keepWindowMsFor(config: ProactiveMessageConfig): number {
  let keep = RATE_WINDOW_MS;
  if (config.cooldownMs > keep) keep = config.cooldownMs;
  for (const entry of Object.values(config.channels)) {
    if (entry.cooldownMs > keep) keep = entry.cooldownMs;
  }
  return keep;
}

/** 承接⑧：SHA-256 全长十六进制（算法选择见文件头；字面量钉死见测试） */
export function contentDigestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ─── 生产装配工厂（B4/B5 接线取用点；本票不接调度器/真机） ─────

/**
 * 生产装配构造：频控状态库构造抛错在此承接（承接①，B2 审查最关键项）——
 * RateControlStateStore 的 open/mkdir/migrate 都可能抛（库文件损坏/目录不可
 * 建/磁盘故障），不接住则管线启动即崩、fail-open 承诺落空。失败降级
 * stateStore=null 并 WARN 明示，投递管线照常以 fail-open 直发运行。
 *
 * 路径约定（由调用方传入，沿 ADR-0006 独立库先例）：
 *   configPath = <DATA_DIR>/config/proactive-message.json
 *   dbPath     = <DATA_DIR>/db/proactive-message.db
 * 进程生命周期单例语义（与 quota-router facade 同）：本工厂不暴露 close，
 * SQLite 句柄随进程退出释放（WAL 模式无损坏风险）。
 */
export function createProactiveMessageAssembly(options: {
  readonly configPath: string;
  readonly dbPath: string;
  readonly resolveAdapter: ProactiveChannelAdapterResolver;
  readonly nowMs?: () => number;
}): ProactiveMessageAssembly {
  let stateStore: RateControlStateStore | null = null;
  try {
    stateStore = new RateControlStateStore(options.dbPath);
  } catch (err) {
    logger.warn(
      {
        dbPath: options.dbPath,
        err: err instanceof Error ? err.message : String(err),
      },
      '主动消息频控状态库构造失败；频控降级为 fail-open 直发（宁多勿丢，ADR-0008）',
    );
  }
  return new ProactiveMessageAssembly({
    configLoader: new ProactiveMessageConfigLoader(options.configPath),
    stateStore,
    resolveAdapter: options.resolveAdapter,
    nowMs: options.nowMs,
  });
}
