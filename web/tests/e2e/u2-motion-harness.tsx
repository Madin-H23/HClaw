// UI-U2 消息/卡片入场动效 harness：直挂 MessageList（绕开 ChatView 的重依赖），
// 铺 30 条历史消息验证「历史不动画 + 初始锚底」，经 window.__u2Append 追加
// 新消息验证「入场类 + 自动滚动锚定」与「上滑阅读时不被拽走」。
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageList } from '../../src/components/chat/MessageList';
import type { Message } from '../../src/stores/chat';
import '../../src/styles/globals.css';

const groupJid = 'web:e2e-u2';
const SEED_COUNT = 30;

function seedMessage(index: number): Message {
  return {
    id: `seed-${String(index).padStart(3, '0')}`,
    chat_jid: groupJid,
    sender: index % 2 === 0 ? 'user' : 'agent',
    sender_name: index % 2 === 0 ? '管理员' : '炉心',
    content: `历史消息 ${index + 1}：用于铺底滚动与锚定验证。`,
    timestamp: new Date(
      Date.now() - (SEED_COUNT - index) * 60_000,
    ).toISOString(),
    is_from_me: index % 2 === 0,
  };
}

function Harness() {
  const [messages, setMessages] = useState<Message[]>(() =>
    Array.from({ length: SEED_COUNT }, (_, index) => seedMessage(index)),
  );
  (window as unknown as { __u2Append: () => void }).__u2Append = () => {
    setMessages((prev) => [
      ...prev,
      {
        id: `live-${prev.length}`,
        chat_jid: groupJid,
        sender: 'agent',
        sender_name: '炉心',
        content: `新消息 ${prev.length + 1}：应播放入场动画并保持滚动锚定。`,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
    ]);
  };
  return createElement(
    'div',
    // 内联样式：harness 独立页的确定性布局，不依赖 Tailwind 类扫描时机
    {
      style: {
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--background)',
      },
    },
    createElement(
      'div',
      // MessageList 外层是 flex-1 子项——此层必须也是 flex 容器
      {
        style: {
          flex: '1 1 0%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        },
      },
      createElement(MessageList, {
        messages,
        loading: false,
        hasMore: false,
        onLoadMore: () => undefined,
        contextLabel: 'U2 动效钉',
        agentName: '炉心',
      }),
    ),
  );
}

createRoot(document.getElementById('root')!).render(createElement(Harness));
