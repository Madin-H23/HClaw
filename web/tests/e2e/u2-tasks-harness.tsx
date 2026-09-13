// UI-U2 任务页统计行分组化截图 harness：mock tasks store 挂真实 TasksPage，
// 覆盖各状态任务（启用/暂停/执行中/等待重试/回收站），验证语义色点分段
// 徽标的成品形态。window.__u2Append() 追加一条回收站任务可二次截图。
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { TasksPage } from '../../src/pages/TasksPage';
import { useTasksStore, type ScheduledTask } from '../../src/stores/tasks';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import '../../src/styles/globals.css';

function task(partial: Partial<ScheduledTask> & { id: string }): ScheduledTask {
  return {
    group_folder: 'demo',
    chat_jid: 'web:demo',
    prompt: `演示任务 ${partial.id}`,
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'group',
    status: 'active',
    created_at: '2026-09-01T00:00:00.000Z',
    ...partial,
  };
}

const seededTasks: ScheduledTask[] = [
  task({ id: 't1', status: 'active' }),
  task({
    id: 't2',
    status: 'active',
    schedule_type: 'interval',
    schedule_value: '30m',
  }),
  task({ id: 't3', status: 'paused' }),
  task({
    id: 't4',
    status: 'active',
    current_run: {
      id: 'r1',
      task_id: 't4',
      status: 'running',
      trigger: 'scheduled',
      started_at: '2026-09-13T01:00:00.000Z',
    } as ScheduledTask['current_run'],
  }),
  task({
    id: 't5',
    status: 'active',
    current_run: {
      id: 'r2',
      task_id: 't5',
      status: 'retry_wait',
      trigger: 'retry',
      started_at: '2026-09-13T01:10:00.000Z',
    } as ScheduledTask['current_run'],
  }),
  task({ id: 't6', status: 'paused', deleted_at: '2026-09-12T00:00:00.000Z' }),
];

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

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});

// 产品默认主题为橙（炉心暖色），与真实使用形态一致的截图口径
document.documentElement.classList.add('theme-orange');

useTasksStore.setState({
  tasks: seededTasks,
  loading: false,
  error: null,
  runningTaskIds: new Set(['t4']),
  groupNames: { 'web:demo': '演示工作区' },
  loadTasks: async () => undefined,
});

(window as unknown as { __u2AddTrash: () => void }).__u2AddTrash = () => {
  useTasksStore.setState((current) => ({
    tasks: [
      ...current.tasks,
      task({
        id: `t-trash-${current.tasks.length}`,
        status: 'active',
        deleted_at: new Date().toISOString(),
      }),
    ],
  }));
};

createRoot(document.getElementById('root')!).render(
  createElement(
    MemoryRouter,
    { initialEntries: ['/tasks'] },
    createElement(
      'main',
      {
        'data-app-scroll-root': 'true',
        style: { height: '100dvh', overflowY: 'auto' },
      },
      createElement(TasksPage),
    ),
  ),
);
