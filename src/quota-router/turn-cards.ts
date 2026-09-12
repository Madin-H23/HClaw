/**
 * 会话内额度提示卡片 — 经上游系统消息落库路径触达（T7，HClaw 原创模块）
 *
 * 事件触达链路选型（票 #8 二选一）→ 选②「上游既有系统消息落库路径」：
 * - 额度决策发生在 runner 启动之前（绑定否决/降档在 trySelectPoolProvider 的
 *   bindingGate，否决时本轮 run 根本不存在），stream-event 管道没有可挂靠的
 *   run；走①需要动 run-stream-fence/streamingSnapshots/前端 applyStreamEvent
 *   等上游流式机器，wiring 大且破上游语义。系统消息路径与上游 billing 拒绝、
 *   插件回复、会话重置失败同款先例：落库即持久（刷新/重连不丢），WS 实时可达。
 * - 卡片渲染零前端改动：上游 MessageBubble 把 is_from_me 的系统消息渲染为
 *   会话流内气泡；事件类型徽标用文本标记（【额度降档】/【额度否决】/
 *   【额度放行】）承载，一行 reason 直接透传 T5 决策理由。
 *
 * 触达范围取舍：卡片是工作台（web）UI 面——groupFolder 下无 web jid（纯 IM
 * 群）时不发卡（IM 侧提示不在 T7 范围，选路行为不受影响）；有 agentId 时落
 * 到该 agent 的虚拟会话 jid（web:xxx#agent:yyy，与 web.ts 同款构造）。
 *
 * 失败语义（ADR-0004 fail-open）：本模块公开面绝不抛错——落库/广播任何异常
 * 只记 WARN，绝不影响选路决策本身的执行与返回。
 */
import { randomUUID } from 'node:crypto';

import { ASSISTANT_NAME } from '../config.js';
import {
  ensureChatExists,
  getJidsByFolder,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import type { QuotaSessionScope } from './assembly.js';

/** 卡片事件类型：与徽标一一对应（票 #8：额度降档/额度否决/额度放行） */
export type QuotaCardKind = 'downgrade' | 'veto' | 'override-allow';

const BADGES: Record<QuotaCardKind, string> = {
  downgrade: '额度降档',
  veto: '额度否决',
  'override-allow': '额度放行',
};

const HEADLINES: Record<QuotaCardKind, string> = {
  downgrade: '绑定供应商额度耗尽，本轮起改用降档目标',
  veto: '本轮未执行：绑定供应商额度耗尽且降无可降',
  'override-allow': 'admin 显式放行额度耗尽的绑定供应商（已记告警）',
};

/** 卡片文案（纯函数，供测试与发射共用）：徽标行 + T5 reason 原样 + 可选数据时间 */
export function formatQuotaCardText(input: {
  readonly kind: QuotaCardKind;
  readonly reason: string;
  /** 被否决/被降档供应商快照的数据时间（ISO）；缺省不展示该行 */
  readonly dataTime?: string | null;
}): string {
  const lines = [
    `【${BADGES[input.kind]}】${HEADLINES[input.kind]}`,
    input.reason,
  ];
  if (input.dataTime) {
    lines.push(`额度数据时间：${formatDataTime(input.dataTime)}`);
  }
  return lines.join('\n');
}

/**
 * 发射一张会话内提示卡片（fire-and-forget，绝不抛错）。
 * 落库走上游 storeMessageDirect（db.ts 既有导出），实时可达走上游
 * broadcastNewMessage（web.ts 既有导出，渠道模块同款先例）。
 */
export async function emitQuotaTurnCard(input: {
  readonly scope: QuotaSessionScope;
  readonly kind: QuotaCardKind;
  readonly reason: string;
  readonly dataTime?: string | null;
}): Promise<void> {
  try {
    const chatJid = resolveWebChatJid(input.scope);
    if (!chatJid) {
      logger.debug(
        { groupFolder: input.scope.groupFolder, kind: input.kind },
        'quota-router 提示卡片跳过：该工作区无 web 会话（纯 IM 群不发卡）',
      );
      return;
    }
    const content = formatQuotaCardText(input);
    const timestamp = new Date().toISOString();
    ensureChatExists(chatJid);
    const messageId = storeMessageDirect(
      randomUUID(),
      chatJid,
      '__system__',
      ASSISTANT_NAME,
      content,
      timestamp,
      true,
    );
    // 动态 import：web.ts 模块级副作用（TerminalManager/Hono app）不进
    // quota-router 的静态 import 图（测试装配不必拉起 web 层）。
    const { broadcastNewMessage } = await import('../web.js');
    broadcastNewMessage(
      chatJid,
      {
        id: messageId,
        chat_jid: chatJid,
        sender: '__system__',
        sender_name: ASSISTANT_NAME,
        content,
        timestamp,
        is_from_me: true,
      },
      input.scope.agentId ?? undefined,
    );
    logger.info(
      { chatJid, kind: input.kind, agentId: input.scope.agentId ?? null },
      'quota-router 会话提示卡片已发送',
    );
  } catch (err) {
    logger.warn(
      {
        groupFolder: input.scope.groupFolder,
        kind: input.kind,
        err: err instanceof Error ? err.message : String(err),
      },
      'quota-router 提示卡片发送失败（fail-open，不影响选路）',
    );
  }
}

/** groupFolder → web 会话 jid（含 agent 虚拟后缀）；无 web jid 返回 null */
function resolveWebChatJid(scope: QuotaSessionScope): string | null {
  const webJid = getJidsByFolder(scope.groupFolder).find(
    (jid) => jid.startsWith('web:') && !jid.includes('#agent:'),
  );
  if (!webJid) return null;
  return scope.agentId ? `${webJid}#agent:${scope.agentId}` : webJid;
}

/** 数据时间展示：绝对时间（本地时区，秒级）+ 相对年龄 */
function formatDataTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const absolute = at.toLocaleString('zh-CN', { hour12: false });
  const ageMs = Date.now() - at.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return absolute;
  return `${absolute}（${formatRelativeAge(ageMs)}）`;
}

function formatRelativeAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return '刚刚刷新';
  if (minutes < 60) return `${minutes} 分钟前刷新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前刷新`;
  return `${Math.floor(hours / 24)} 天前刷新`;
}
