import type { ChannelId } from './channel-registry.js';
import { CHANNEL_LABELS } from './channel-registry.js';

export interface ImChannelCapabilities {
  /** 渠道 id；与注册表一致（ADR-0009 派生自同一联合） */
  channel_type: ChannelId;
  label: string;
  can_bind_workspace: boolean;
  can_bind_session: boolean;
  supports_thread_map: boolean;
  supports_activation_modes: boolean;
  supports_owner_mention: boolean;
  supports_streaming_updates: boolean;
  supports_file_send: boolean;
}

/**
 * 渠道能力表（ADR-0009）：显示名取自注册表；`satisfies Record<ChannelId, …>`
 * 强制七渠道逐一登记——注册表新增渠道而漏改此表时编译失败。
 * 各项能力开关是逐渠道事实，不属于可派生内容。
 */
export const IM_CHANNEL_CAPABILITIES: Record<string, ImChannelCapabilities> = {
  feishu: {
    channel_type: 'feishu',
    label: CHANNEL_LABELS.feishu,
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: true,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  dingtalk: {
    channel_type: 'dingtalk',
    label: CHANNEL_LABELS.dingtalk,
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  telegram: {
    channel_type: 'telegram',
    label: CHANNEL_LABELS.telegram,
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: true,
    supports_activation_modes: false,
    supports_owner_mention: true,
    supports_streaming_updates: false,
    supports_file_send: true,
  },
  qq: {
    channel_type: 'qq',
    label: CHANNEL_LABELS.qq,
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: false,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  wechat: {
    channel_type: 'wechat',
    label: CHANNEL_LABELS.wechat,
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: false,
    supports_owner_mention: false,
    supports_streaming_updates: false,
    supports_file_send: false,
  },
  discord: {
    channel_type: 'discord',
    label: CHANNEL_LABELS.discord,
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  whatsapp: {
    channel_type: 'whatsapp',
    label: CHANNEL_LABELS.whatsapp,
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: false,
    supports_file_send: true,
  },
} satisfies Record<ChannelId, ImChannelCapabilities>;

export function getImChannelCapabilities(
  channelType: string | null | undefined,
): ImChannelCapabilities | undefined {
  return channelType ? IM_CHANNEL_CAPABILITIES[channelType] : undefined;
}

export function isThreadMapCapableChat(info?: {
  channel_type?: string | null;
  chat_mode?: string | null;
  group_message_type?: string | null;
  /** Generic native-context metadata. Persisted on the container chat. */
  native_context_type?: string | null;
  /** Compatibility input for transports that only expose a boolean. */
  thread_capable?: boolean | null;
}): boolean {
  if (!info?.channel_type) return false;
  const caps = getImChannelCapabilities(info.channel_type);
  if (!caps?.supports_thread_map) return false;
  return (
    info.thread_capable === true ||
    info.native_context_type === 'thread' ||
    info.chat_mode === 'topic' ||
    info.group_message_type === 'thread'
  );
}
