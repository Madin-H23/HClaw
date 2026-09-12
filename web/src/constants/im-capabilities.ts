import { CHANNEL_IDS, CHANNEL_LABELS } from '../channel-registry';
import type { ChannelId } from '../channel-registry';

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

// ADR-0009：渠道顺序从注册表派生（原为手写 as const 清单，顺序=注册表序）
export const IM_CHANNEL_ORDER = CHANNEL_IDS;

export type ImChannelType = (typeof IM_CHANNEL_ORDER)[number];

export const IM_CHANNEL_CAPABILITIES: Record<
  ImChannelType,
  ImChannelCapabilities
> = {
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
};

export function getImChannelCapabilities(
  channelType: string | null | undefined,
): ImChannelCapabilities | undefined {
  return channelType
    ? IM_CHANNEL_CAPABILITIES[channelType as ImChannelType]
    : undefined;
}

export function isThreadMapCapableChat(info?: {
  channel_type?: string | null;
  chat_mode?: string | null;
  group_message_type?: string | null;
  native_context_type?: string | null;
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
