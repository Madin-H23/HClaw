import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { rmTempDirWithRetry } from './helpers/win-fs-retry.js';

// 调度器 → 主动消息接线端到端测试（票 #24）：triggerTaskNow 驱动真调度器
// （真 DB + 真收尾链路），deps.notifyTaskResult 注入**真生产工厂**
// createSchedulerProactiveNotifier + 假渠道适配器——钉死五类外部行为：
// 完成后按声明渠道投递、送达失败在任务运行日志留痕、notify reject 不炸调度
// 循环（兜底 catch）、未装配/未声明渠道时与上游行为一致（no-op）、补发语义
// （静默窗口持有 → 下轮触发自然补发）。

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-proactive-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

// 生产工厂的库连接是进程生命周期单例（不暴露 close，B3 已钉该语义），其
// 落盘目录与主库 tmp 分离且**不做删除清理**——在打开的 SQLite 文件下删目录
// 在 Windows 必失败；泄漏量 = 每次测试运行几 KB，由 OS 临时目录回收。
const factoryDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'scheduler-proactive-factory-'),
);
let factoryClockMs = Date.parse('2026-09-11T15:30:00Z'); // UTC+8 23:30（窗内）

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { runScriptMock } = vi.hoisted(() => ({
  runScriptMock: vi.fn(async () => ({
    stdout: 'script result',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    durationMs: 10,
  })),
}));

vi.mock('../src/script-runner.js', () => ({ runScript: runScriptMock }));

const db = await import('../src/db.js');
const { triggerTaskNow } = await import('../src/task-scheduler.js');
const { createSchedulerProactiveNotifier } =
  await import('../src/proactive-message/trigger-dispatch.js');
const { ProactiveDeliveryLogStore } =
  await import('../src/proactive-message/delivery-log.js');

const GROUP_JID = 'web:proactive-e2e';
const GROUP_FOLDER = 'proactive-e2e';
const FEISHU_TARGET = 'ou_admin_e2e';

/** 假渠道适配器：记录收到的发送；可注入失败 */
class FakeAdapter {
  readonly sent: { target: string; text: string }[] = [];
  constructor(private readonly failure?: Error) {}
  async sendMessage(target: string, text: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.sent.push({ target, text });
  }
}

function writeFactoryConfig(config: Record<string, unknown>): string {
  const configPath = path.join(
    factoryDir,
    `config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return configPath;
}

/**
 * 真生产工厂 + 假适配器：configPath 每用例独立（热生效装载），库路径共享
 * factoryDir（不清理，见文件头）。feishu 配默认私聊目标。
 */
function makeNotifyTaskResult(options?: {
  feishuFailure?: Error;
  config?: Record<string, unknown>;
}) {
  const configPath = writeFactoryConfig(
    options?.config ?? {
      version: 1,
      channels: { feishu: { defaultTarget: FEISHU_TARGET } },
    },
  );
  const feishuAdapter = new FakeAdapter(options?.feishuFailure);
  const notify = createSchedulerProactiveNotifier({
    configPath,
    rateControlDbPath: path.join(factoryDir, 'rate.db'),
    deliveriesDbPath: path.join(factoryDir, 'deliveries.db'),
    resolveAdapter: (channelId) =>
      channelId === 'feishu' ? feishuAdapter : null,
    nowMs: () => factoryClockMs,
  });
  return { notify, feishuAdapter };
}

function makeDeps(
  groups: Record<string, unknown>,
  notifyTaskResult?: (...args: unknown[]) => unknown,
) {
  let runPromise: Promise<void> | null = null;
  const queue = {
    enqueueTask: vi.fn(
      (_jid: string, _taskId: string, fn: () => Promise<void>) => {
        runPromise = fn();
        return true;
      },
    ),
    closeStdin: vi.fn(),
    enqueueMessageCheck: vi.fn(),
    isShuttingDown: () => false,
    isGroupMutationPaused: vi.fn(() => false),
  };
  const deps = {
    registeredGroups: () => groups,
    getSessions: () => ({}),
    queue,
    onProcess: vi.fn(),
    sendMessage: vi.fn(async () => 'message-id'),
    broadcastStreamEvent: vi.fn(),
    storePromptMessage: vi.fn(),
    storeResultAndNotify: vi.fn(async () => undefined),
    notifyTaskResult,
    assistantName: 'Miniclaw',
  } as never;
  return {
    deps,
    queue,
    /**
     * script 任务经 trackDetachedSchedulerWork 分流（不经 queue），故以
     * durable 运行收口为等待条件：durable 完成发生在运行日志终写与送达
     * 失败痕迹补写**之后**（runScriptTaskInner 的 finish 挂在其 finally），
     * 状态离开 running 即全部落定。
     */
    waitForRun: async (runId?: string) => {
      if (runId) {
        await vi.waitFor(() => {
          expect(db.getTaskRunById(runId)?.status).not.toBe('running');
        });
      } else if (runPromise) {
        await runPromise;
      }
      for (let index = 0; index < 8; index++) {
        const claim = db.claimNextTaskRunNotification(
          `proactive-e2e-auto-notifier-${index}`,
          60_000,
        );
        if (!claim) break;
        await import('../src/task-scheduler.js').then(
          ({ processClaimedTaskRunNotification }) =>
            processClaimedTaskRunNotification(claim, deps, 60_000),
        );
      }
    },
  };
}

function createScriptTask(
  overrides: Partial<Parameters<typeof db.createTask>[0]> = {},
) {
  const id = overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`;
  db.createTask({
    id,
    group_folder: GROUP_FOLDER,
    chat_jid: GROUP_JID,
    prompt: 'write a short status',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'script',
    execution_mode: 'host',
    script_command: 'printf ok',
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    created_by: 'proactive-e2e-owner',
    notify_channels: null,
    ...overrides,
  });
  return id;
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  runScriptMock.mockClear();
  if (!db.getUserById('proactive-e2e-owner')) {
    const now = new Date().toISOString();
    db.createUser({
      id: 'proactive-e2e-owner',
      username: 'proactive-e2e-owner',
      password_hash: 'hash',
      display_name: 'proactive-e2e-owner',
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
  }
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Proactive E2E Workspace',
    folder: GROUP_FOLDER,
    jid: GROUP_JID,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    is_home: false,
    created_by: 'proactive-e2e-owner',
  } as never);
});

afterAll(async () => {
  db.closeDatabase();
  await rmTempDirWithRetry(tmpDir);
  // factoryDir 有进程生命周期 SQLite 句柄（设计如此），不删除
});

describe('调度器 → 主动消息接线（票 #24）', () => {
  test('脚本任务完成后按声明渠道投递到频控入口（真工厂 + 假适配器），审计可查', async () => {
    const { notify, feishuAdapter } = makeNotifyTaskResult();
    const taskId = createScriptTask({ notify_channels: ['feishu', 'wechat'] });
    const groups = { [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)! };
    const { deps, waitForRun } = makeDeps(groups, notify);

    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger.success).toBe(true);
    await waitForRun(trigger.runId);

    // 投递真实发生：假适配器收到带任务头的结果文本
    expect(feishuAdapter.sent).toHaveLength(1);
    expect(feishuAdapter.sent[0]).toEqual({
      target: FEISHU_TARGET,
      text: expect.stringContaining('Miniclaw: [脚本] script result'),
    });
    expect(feishuAdapter.sent[0]?.text).toContain(
      '【定时任务 write a short status】',
    );

    // 投递记录可查（独立只读连接读工厂库）：sent + wechat 未配置目标 skipped
    const audit = new ProactiveDeliveryLogStore(
      path.join(factoryDir, 'deliveries.db'),
    );
    try {
      const records = audit.queryDeliveries({ taskId });
      expect(records.map((row) => row.outcome)).toEqual(['skipped', 'sent']);
      expect(records[1]).toMatchObject({
        channelId: 'feishu',
        target: FEISHU_TARGET,
        messageKey: taskId,
        triggerKind: 'scheduled-task',
        // 脚本完成点未穿透 V2 运行 id（runScriptTaskInner 无 durable 入参），
        // runId 设计为 null；来源任务以 taskId 承载
        runId: null,
      });
    } finally {
      audit.close();
    }

    // 运行收尾不受投递影响：无失败 → 运行日志无投递痕迹
    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'success',
      result: 'script result',
      error: null,
    });
  });

  test('送达失败在任务运行日志留痕：error 字段追加失败渠道，status 不翻转', async () => {
    const { notify, feishuAdapter } = makeNotifyTaskResult({
      feishuFailure: new Error('渠道断连'),
    });
    const taskId = createScriptTask({ notify_channels: ['feishu'] });
    const groups = { [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)! };
    const { deps, waitForRun } = makeDeps(groups, notify);

    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger.success).toBe(true);
    await waitForRun(trigger.runId);

    expect(feishuAdapter.sent).toHaveLength(0);
    const runLog = db.getTaskRunLogs(taskId, 1)[0];
    expect(runLog).toMatchObject({
      status: 'success', // 脚本本身成功：运行成败语义不因投递翻转
      result: 'script result',
    });
    expect(String(runLog?.error)).toContain('主动消息投递失败：feishu');
    expect(String(runLog?.error)).toContain('渠道断连');
  });

  test('notifyTaskResult reject 不炸调度循环：兜底承接，运行收尾与后续触发照常', async () => {
    const notify = vi.fn(async () => {
      throw new Error('注入闭包意外崩溃');
    });
    const taskId = createScriptTask({ notify_channels: ['feishu'] });
    const groups = { [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)! };
    const { deps, waitForRun } = makeDeps(groups, notify);

    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger.success).toBe(true);
    await waitForRun(trigger.runId);

    // 兜底 catch 承接：运行日志不被污染（trace 未写、error 保持 null）
    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'success',
      error: null,
    });

    // 调度循环活着：同一 deps 再触发一个任务照常完整收尾
    const secondTaskId = createScriptTask({
      id: 'task-after-crash',
      notify_channels: ['feishu'],
    });
    const secondTrigger = triggerTaskNow(secondTaskId, deps);
    expect(secondTrigger.success).toBe(true);
    await waitForRun(secondTrigger.runId);
    expect(db.getTaskRunLogs(secondTaskId, 1)[0]).toMatchObject({
      status: 'success',
      error: null,
    });
  });

  test('未装配 notifyTaskResult：行为与上游一致（旧通知面照常，无主动消息）', async () => {
    const taskId = createScriptTask({ notify_channels: ['feishu'] });
    const groups = { [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)! };
    const { deps, waitForRun } = makeDeps(groups); // 不注入

    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger.success).toBe(true);
    await waitForRun(trigger.runId);

    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'success',
      error: null,
    });
    // 上游旧通知面不受影响：storeResultAndNotify 照常被调（ownerId 语义不变）
    expect(deps.storeResultAndNotify).toHaveBeenCalledTimes(1);
  });

  test('任务未声明渠道（notify_channels=null）：不触发投递', async () => {
    const { notify, feishuAdapter } = makeNotifyTaskResult();
    const notifySpy = vi.fn(notify);
    const taskId = createScriptTask({ notify_channels: null });
    const groups = { [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)! };
    const { deps, waitForRun } = makeDeps(groups, notifySpy);

    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger.success).toBe(true);
    await waitForRun(trigger.runId);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(feishuAdapter.sent).toHaveLength(0);
  });

  test('补发语义端到端：静默窗口内持有 → 窗口外下轮触发自然补发', async () => {
    const taskId = 'task-quiet-window-requeue';
    createScriptTask({ id: taskId, notify_channels: ['feishu'] });
    const { notify, feishuAdapter } = makeNotifyTaskResult({
      config: {
        version: 1,
        timeZoneOffsetMinutes: 480,
        channels: { feishu: { defaultTarget: FEISHU_TARGET } },
        quietWindows: {
          [taskId]: [{ start: '23:00', end: '07:00' }],
        },
      },
    });
    const groups = { [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)! };

    // 第一轮：23:30（UTC+8）在静默窗内 → hold（不发送、审计留痕）
    factoryClockMs = Date.parse('2026-09-11T15:30:00Z');
    const { deps, waitForRun } = makeDeps(groups, notify);
    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger.success).toBe(true);
    await waitForRun(trigger.runId);
    expect(feishuAdapter.sent).toHaveLength(0);

    // 第二轮：时钟到次日 08:30（窗外）→ 触发源按原节奏再触发即自然补发，
    // 调度器/分发器侧无重试循环、无跳过
    factoryClockMs += 9 * 3600_000;
    const secondTrigger = triggerTaskNow(taskId, deps);
    expect(secondTrigger.success).toBe(true);
    await waitForRun(secondTrigger.runId);

    expect(feishuAdapter.sent).toHaveLength(1);
    const audit = new ProactiveDeliveryLogStore(
      path.join(factoryDir, 'deliveries.db'),
    );
    try {
      const outcomes = audit
        .queryDeliveries({ taskId })
        .map((row) => row.outcome);
      expect(outcomes).toEqual(['sent', 'hold']);
    } finally {
      audit.close();
    }
  });
});
