/**
 * 额度面板 / 会话内提示卡片 —— mock 驱动多状态截图 harness（T7）
 *
 * 仅供截图脚本与视觉验收使用（不进 CI 单测）：query 参数选择视图与状态，
 * 数据全部来自本文件内置 mock（面板走 fetch 拦截，卡片直接 seed 消息列表），
 * 不依赖真实后端。运行方式见 web/tests/e2e/quota-shots.spec.ts。
 *
 * 视图：
 *   ?view=panel&state=all-tiers|missing|stale|unconfigured|loading
 *   ?view=cards&cards=downgrade|veto|allow|all
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QuotaPage } from '../../src/pages/QuotaPage';
import type { QuotaPanelResponse } from '../../src/api/quota';
import { MessageList } from '../../src/components/chat/MessageList';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import '../../src/styles/globals.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view') ?? 'panel';
const state = params.get('state') ?? 'all-tiers';

const now = Date.now();
const minutes = (n: number) => n * 60_000;
const isoAgo = (ms: number) => new Date(now - ms).toISOString();

const user: UserPublic = {
  id: 'admin-user',
  username: 'admin',
  display_name: '管理员',
  role: 'admin',
  status: 'active',
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: null,
  last_active_at: null,
  deleted_at: null,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  ai_name: null,
  ai_avatar_emoji: null,
  ai_avatar_color: null,
  ai_avatar_url: null,
  default_require_mention: false,
};

// ─── 面板 mock 数据 ──────────────────────────────────────────

interface MockProvider {
  providerId: string;
  displayName: string;
  enabled?: boolean;
  mapped: boolean;
  tier?: QuotaPanelResponse['providers'][number]['tier'];
  signalKind?: QuotaPanelResponse['providers'][number]['signalKind'];
  score?: number | null;
  fetchedAgoMs?: number;
  ttlMs?: number;
  windows?: QuotaPanelResponse['providers'][number]['windows'];
  summary?: QuotaPanelResponse['providers'][number]['summary'];
}

function toRow(p: MockProvider): QuotaPanelResponse['providers'][number] {
  const fetchedAt =
    p.fetchedAgoMs === undefined ? null : isoAgo(p.fetchedAgoMs);
  const ttl = p.ttlMs ?? 5 * 60_000;
  return {
    providerId: p.providerId,
    displayName: p.displayName,
    enabled: p.enabled ?? true,
    mapped: p.mapped,
    tier: p.tier ?? null,
    tierLabel:
      p.tier === 'plenty'
        ? '充足'
        : p.tier === 'tight'
          ? '紧张'
          : p.tier === 'critical'
            ? '临界'
            : p.tier === 'exhausted'
              ? '耗尽'
              : null,
    signalKind: p.signalKind ?? null,
    score: p.score ?? null,
    fetchedAt,
    storedAt: fetchedAt,
    stale: p.fetchedAgoMs !== undefined ? p.fetchedAgoMs > ttl : false,
    ageMs: p.fetchedAgoMs ?? null,
    windows: p.windows ?? [],
    summary: p.summary ?? [],
  };
}

const FOUR_TIERS: MockProvider[] = [
  {
    providerId: 'zhipu-glm',
    displayName: '智谱 GLM',
    mapped: true,
    tier: 'plenty',
    signalKind: 'percentage',
    score: 68,
    fetchedAgoMs: minutes(3),
    windows: [
      {
        label: '5h 窗口',
        total: 100,
        used: 32,
        remaining: 68,
        percentage: 32,
        resetAt: isoAgo(-minutes(90)),
        unit: '%',
      },
    ],
  },
  {
    providerId: 'opencode-go',
    displayName: 'OpenCode Go',
    mapped: true,
    tier: 'tight',
    signalKind: 'percentage',
    score: 18,
    fetchedAgoMs: minutes(4),
    windows: [
      {
        label: '周窗口',
        total: 100,
        used: 82,
        remaining: 18,
        percentage: 82,
        resetAt: isoAgo(-minutes(60 * 30)),
        unit: '%',
      },
    ],
  },
  {
    providerId: 'bailian-qwen',
    displayName: '百炼千问',
    mapped: true,
    tier: 'critical',
    signalKind: 'absolute',
    score: 8,
    fetchedAgoMs: minutes(2),
    windows: [
      {
        label: '月度包',
        total: 1_000_000,
        used: 920_000,
        remaining: 80_000,
        percentage: 92,
        resetAt: isoAgo(-minutes(60 * 24 * 12)),
        unit: ' tokens',
      },
    ],
  },
  {
    providerId: 'volcano-afp',
    displayName: '火山方舟',
    mapped: true,
    tier: 'exhausted',
    signalKind: 'absolute',
    score: 0,
    fetchedAgoMs: minutes(6),
    windows: [
      {
        label: '5h 窗口',
        total: 200_000,
        used: 200_000,
        remaining: 0,
        percentage: 100,
        resetAt: isoAgo(-minutes(48)),
        unit: ' tokens',
      },
    ],
  },
  {
    providerId: 'deepseek-chat',
    displayName: 'DeepSeek',
    mapped: true,
    tier: 'plenty',
    signalKind: 'currency',
    score: 12.5,
    fetchedAgoMs: minutes(1),
    windows: [],
    summary: [{ label: '总余额', value: 12.5 }],
  },
  {
    providerId: 'command-code',
    displayName: 'Command Code',
    mapped: true,
    tier: null,
    fetchedAgoMs: undefined,
  },
];

const PANEL_STATES: Record<string, QuotaPanelResponse> = {
  'all-tiers': {
    configured: true,
    snapshotTtlMs: 5 * 60_000,
    providers: FOUR_TIERS.map(toRow),
  },
  missing: {
    configured: true,
    snapshotTtlMs: 5 * 60_000,
    providers: [
      toRow(FOUR_TIERS[0]),
      {
        providerId: 'moonshot-kimi',
        displayName: '月之暗面',
        mapped: false,
      },
      {
        providerId: 'grok-beta',
        displayName: 'grok-beta',
        enabled: false,
        mapped: true,
        tier: null,
      },
    ].map(toRow),
  },
  stale: {
    configured: true,
    snapshotTtlMs: 5 * 60_000,
    providers: [
      toRow(FOUR_TIERS[0]),
      toRow({ ...FOUR_TIERS[1], fetchedAgoMs: minutes(47) }),
    ],
  },
  unconfigured: {
    configured: false,
    snapshotTtlMs: 5 * 60_000,
    providers: FOUR_TIERS.map((p) => ({
      ...p,
      mapped: false,
      tier: undefined,
    })).map(toRow),
  },
};

function patchPanelFetch(payload: QuotaPanelResponse): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (url.includes('/api/quota/panel')) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input as RequestInfo, init);
  };
}

// ─── 卡片 mock 数据（文案与生产 formatQuotaCardText 同构） ───

const CARD_MESSAGES = {
  downgrade: {
    id: 'card-downgrade',
    content: [
      '【额度降档】绑定供应商额度耗尽，本轮起改用降档目标',
      '额度降档：绑定供应商 volcano-afp 额度档位「耗尽」，按档位序与成本序降档到 deepseek-chat（新粘滞点已重设）',
      `额度数据时间：${new Date(now - minutes(6)).toLocaleString('zh-CN', { hour12: false })}（6 分钟前刷新）`,
    ].join('\n'),
  },
  veto: {
    id: 'card-veto',
    content: [
      '【额度否决】本轮未执行：绑定供应商额度耗尽且降无可降',
      '额度否决：绑定供应商 volcano-afp 额度档位「耗尽」，候选集内无可用降档目标，降无可降',
      `额度数据时间：${new Date(now - minutes(6)).toLocaleString('zh-CN', { hour12: false })}（6 分钟前刷新）`,
    ].join('\n'),
  },
  allow: {
    id: 'card-allow',
    content: [
      '【额度放行】admin 显式放行额度耗尽的绑定供应商（已记告警）',
      'admin 放行：绑定供应商 volcano-afp 额度档位「耗尽」，显式放行并记告警（记账由装配层处理）',
      `额度数据时间：${new Date(now - minutes(6)).toLocaleString('zh-CN', { hour12: false })}（6 分钟前刷新）`,
    ].join('\n'),
  },
};

function cardMessage(kind: keyof typeof CARD_MESSAGES) {
  return {
    chat_jid: 'web:harness',
    sender: '__system__',
    sender_name: 'Miniclaw',
    timestamp: isoAgo(minutes(1)),
    is_from_me: true,
    ...CARD_MESSAGES[kind],
  };
}

// ─── 渲染 ───────────────────────────────────────────────────

const root = createRoot(document.getElementById('root')!);

if (view === 'panel') {
  const payload =
    state === 'loading'
      ? null
      : (PANEL_STATES[state] ?? PANEL_STATES['all-tiers']);
  if (payload) patchPanelFetch(payload);
  else {
    // loading 态：请求挂起不打回，让骨架屏常驻
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (url.includes('/api/quota/panel')) {
        return new Promise(() => undefined);
      }
      return realFetch(input as RequestInfo, init);
    };
  }
  // 面板取数经 api client（window.fetch），fetch 拦截即完成 mock
  root.render(
    <main className="h-[100dvh] overflow-auto bg-background">
      <QuotaPage />
    </main>,
  );
} else {
  useAuthStore.setState({
    authenticated: true,
    user,
    initialized: true,
    checking: false,
  });
  const cardsParam = params.get('cards') ?? 'all';
  const kinds =
    cardsParam === 'all'
      ? (['downgrade', 'veto', 'allow'] as const)
      : ([cardsParam] as const);
  const messages = [
    {
      id: 'user-question',
      chat_jid: 'web:harness',
      sender: 'admin-user',
      sender_name: '管理员',
      content: '帮我用绑定的模型跑一遍今天的数据清洗任务',
      timestamp: isoAgo(minutes(2)),
      is_from_me: false,
    },
    ...kinds.map((kind) => cardMessage(kind)),
  ];
  root.render(
    <MemoryRouter initialEntries={['/']}>
      <main className="h-[100dvh] overflow-hidden bg-background p-6">
        <div className="mx-auto h-full max-w-3xl">
          <MessageList
            messages={messages}
            loading={false}
            hasMore={false}
            onLoadMore={() => undefined}
            groupJid="web:harness"
          />
        </div>
      </main>
    </MemoryRouter>,
  );
}
