/**
 * IM 渠道类型注册表 —— 七渠道单一事实源（ADR-0009 expand-contract）。
 *
 * 「新增渠道 = 注册表加一个条目 + 实现适配器」：
 *   1. 在 CHANNEL_REGISTRY 追加条目（id/label/jidPrefix/factoryKey）；
 *   2. 实现 IMChannel 适配器工厂（src/im-channel.ts 的 create*Channel 模式）；
 *   3. 在 im-manager.ts 增加对应 connectUser* 装配与旧配置投影（适配器接线）；
 *   4. 其余枚举点全部从本表派生：ChannelProvider、zod 校验枚举、JID 前缀表、
 *      通知渠道清单、能力表与显示名等 —— 漏登记/拼错 id 会在这些派生点编译失败。
 *
 * 条目顺序即派生序（CHANNEL_IDS / CHANNEL_PREFIXES / 通知渠道选项等均按此序），
 * 现有顺序与历史硬编码清单一致；调整顺序属于行为变更，须单独评审。
 *
 * 本文件会被 scripts/sync-stream-event.sh 镜像到 src/、container/agent-runner/src/
 * 与 web/src/（保持零依赖、可独立编译），改动后执行 `make sync-types` 同步。
 */

export interface ChannelRegistryEntry {
  /** 渠道 id：JID 前缀来源、账号 provider、通知渠道 key 的统一标识 */
  readonly id: string;
  /** 显示名：后端 PROVIDER_NAMES / 能力表与前端渠道标签共用的单一来源 */
  readonly label: string;
  /** IM JID 前缀（含尾随冒号），如 'feishu:' */
  readonly jidPrefix: string;
  /** 连接器工厂 key：对应 src/im-channel.ts 的 create*Channel 适配器 */
  readonly factoryKey: string;
}

export const CHANNEL_REGISTRY = [
  { id: 'feishu', label: '飞书', jidPrefix: 'feishu:', factoryKey: 'feishu' },
  {
    id: 'telegram',
    label: 'Telegram',
    jidPrefix: 'telegram:',
    factoryKey: 'telegram',
  },
  { id: 'qq', label: 'QQ', jidPrefix: 'qq:', factoryKey: 'qq' },
  { id: 'wechat', label: '微信', jidPrefix: 'wechat:', factoryKey: 'wechat' },
  {
    id: 'dingtalk',
    label: '钉钉',
    jidPrefix: 'dingtalk:',
    factoryKey: 'dingtalk',
  },
  {
    id: 'discord',
    label: 'Discord',
    jidPrefix: 'discord:',
    factoryKey: 'discord',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    jidPrefix: 'whatsapp:',
    factoryKey: 'whatsapp',
  },
] as const satisfies readonly ChannelRegistryEntry[];

/**
 * 注册表顺序的渠道 id 元组（与 CHANNEL_REGISTRY 同长度同顺序）。
 * 通过泛型同形映射保持元组形状，使 zod 枚举与 `(typeof CHANNEL_IDS)[number]`
 * 派生拿到精确的字面量联合；注册表增删条目时形状自动跟随。
 */
function idsOf<T extends readonly { readonly id: string }[]>(
  entries: T,
): { -readonly [K in keyof T]: T[K]['id'] } {
  return entries.map((entry) => entry.id) as {
    -readonly [K in keyof T]: T[K]['id'];
  };
}

export const CHANNEL_IDS = idsOf(CHANNEL_REGISTRY);

/** 渠道 id 联合类型：所有旧手写七值联合的单一来源 */
export type ChannelId = (typeof CHANNEL_IDS)[number];

/** 渠道显示名记录：key 顺序与 CHANNEL_REGISTRY 一致 */
export const CHANNEL_LABELS = Object.fromEntries(
  CHANNEL_REGISTRY.map((entry) => [entry.id, entry.label]),
) as Record<ChannelId, string>;
