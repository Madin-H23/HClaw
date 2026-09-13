// UI-U2 路由过渡 harness：真实 AppLayout（含 keyed hc-enter-page 容器）+
// 两个 stub 路由。验证 keyed 重挂载携带入场动画、h-full 包裹层不破坏
// min-h-full 百分比解析与 main 滚动语义。window.__u2Navigate 供测试驱动导航。
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AppLayout } from '../../src/components/layout/AppLayout';
import '../../src/styles/globals.css';

function StubPage({ label, tall = false }: { label: string; tall?: boolean }) {
  return createElement(
    'div',
    { className: 'min-h-full bg-background p-6', 'data-u2-stub': label },
    createElement('h1', { className: 'text-lg font-semibold' }, label),
    ...(tall
      ? Array.from({ length: 80 }, (_, index) =>
          createElement('p', { key: index }, `滚动填充段 ${index + 1}`),
        )
      : []),
  );
}

function NavControls() {
  const navigate = useNavigate();
  (window as unknown as { __u2Navigate: (to: string) => void }).__u2Navigate = (
    to: string,
  ) => navigate(to);
  return null;
}

const params = new URLSearchParams(window.location.search);
const start = params.get('start') ?? '/tasks';

createRoot(document.getElementById('root')!).render(
  createElement(
    MemoryRouter,
    { initialEntries: [start] },
    createElement(
      Routes,
      null,
      createElement(
        Route,
        { element: createElement(AppLayout) },
        createElement(Route, {
          path: '/tasks',
          element: createElement(StubPage, { label: '任务', tall: true }),
        }),
        createElement(Route, {
          path: '/memory',
          element: createElement(StubPage, { label: '记忆' }),
        }),
      ),
    ),
    createElement(NavControls),
  ),
);
