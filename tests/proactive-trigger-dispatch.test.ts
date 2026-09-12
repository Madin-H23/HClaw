import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { rmTempDirWithRetry } from './helpers/win-fs-retry.js';
import type { ChannelId } from '../src/channel-registry.js';
import { logger } from '../src/logger.js';
import { ProactiveMessageAssembly } from '../src/proactive-message/delivery-assembly.js';
import { ProactiveMessageConfigLoader } from '../src/proactive-message/config.js';
import {
  ProactiveDeliveryLogStore,
  type ProactiveDeliveryRecord,
} from '../src/proactive-message/delivery-log.js';
import {
  DEFAULT_SEND_TIMEOUT_MS,
  deliverProactiveTrigger,
  createSchedulerProactiveNotifier,
  normalizeDeclaredChannels,
  type ProactiveTriggerRequest,
} from '../src/proactive-message/trigger-dispatch.js';
import { RateControlStateStore } from '../src/proactive-message/state-store.js';

// 触发源无关投递分发集成测试（票 #24，SPEC #20「调度器只是第一个公民」）：
// 真装配（真配置装载 + 真 SQLite 状态库 + 真决策纯函数）+ 真审计库，以假渠道
// 适配器驱动，钉死五类外部行为——按声明渠道投递、投递记录可查询、per-send
// 超时（悬挂适配器 → send-timeout 而非卡死，孤儿 promise 不炸）、兜底承接
// （notify reject 内化不逃）、补发语义（静默窗口持有 → 窗口外下轮触发自然补
// 发，分发器自身无重试）。时钟全量注入。

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NOW_MS = Date.parse('2026-09-12T04:00:00Z'); // UTC+8 = 12:00（窗口外）

/** 假渠道适配器：记录收到的发送；可注入失败 */
class FakeAdapter {
  readonly sent: { target: string; text: string }[] = [];
  constructor(private readonly failure?: Error) {}
  async sendMessage(target: string, text: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.sent.push({ target, text });
  }
}

/** 悬挂适配器：sendMessage 挂起，测试手工放行（resolve/reject） */
class HangingAdapter {
  readonly sent: { target: string; text: string }[] = [];
  private release:
    | ((
        verdict?: { action: 'resolve' } | { action: 'reject'; error: Error },
      ) => void)
    | null = null;
  async sendMessage(target: string, text: string): Promise<void> {
    const verdict = await new Promise<
      { action: 'resolve' } | { action: 'reject'; error: Error } | undefined
    >((resolve) => {
      this.release = resolve;
    });
    if (verdict?.action === 'reject') throw verdict.error;
    this.sent.push({ target, text });
  }
  settle(verdict?: { action: 'resolve' } | { action: 'reject'; error: Error }) {
    this.release?.(verdict);
  }
}

const tmpDirs: string[] = [];
const openStores: RateControlStateStore[] = [];
const openLogs: ProactiveDeliveryLogStore[] = [];

afterEach(async () => {
  for (const log of openLogs.splice(0)) log.close();
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) {
    // Windows：SQLite/WAL 句柄释放有延迟，重试清理（#17 抖动簇治理先例）
    await rmTempDirWithRetry(dir);
  }
  vi.clearAllMocks();
});

function makeFixtureDir(prefix = 'proactive-trigger-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, config: Record<string, unknown>): string {
  const configPath = path.join(dir, 'proactive-message.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return configPath;
}

interface Fixture {
  configPath: string;
  rateStore: RateControlStateStore;
  deliveryLog: ProactiveDeliveryLogStore;
  adapters: Partial<Record<ChannelId, FakeAdapter>>;
}

/** 标准夹具：真配置文件 + 真状态库 + 真审计库 + 假适配器（装配按需构造） */
function makeFixture(options?: {
  config?: Record<string, unknown>;
  adapters?: Partial<Record<ChannelId, FakeAdapter>>;
}): Fixture {
  const dir = makeFixtureDir();
  const configPath = writeConfig(
    dir,
    options?.config ?? {
      version: 1,
      rateLimitPerMinute: 10,
      cooldownMs: 0,
      channels: {
        feishu: { defaultTarget: 'ou_admin' },
        dingtalk: { defaultTarget: 'c2c:cid_admin' },
      },
    },
  );
  const rateStore = new RateControlStateStore(
    path.join(dir, 'db', 'proactive-message.db'),
  );
  openStores.push(rateStore);
  const deliveryLog = new ProactiveDeliveryLogStore(
    path.join(dir, 'db', 'proactive-message-deliveries.db'),
  );
  openLogs.push(deliveryLog);
  return {
    configPath,
    rateStore,
    deliveryLog,
    adapters: options?.adapters ?? {
      feishu: new FakeAdapter(),
      dingtalk: new FakeAdapter(),
    },
  };
}

function makeAssembly(
  fixture: Fixture,
  nowMs: () => number,
): ProactiveMessageAssembly {
  return new ProactiveMessageAssembly({
    configLoader: new ProactiveMessageConfigLoader(fixture.configPath),
    stateStore: fixture.rateStore,
    resolveAdapter: (channelId) => fixture.adapters[channelId] ?? null,
    nowMs,
  });
}

function makeRequest(
  overrides?: Partial<ProactiveTriggerRequest>,
): ProactiveTriggerRequest {
  return {
    triggerKind: 'scheduled-task',
    triggerKey: 'task-morning-check',
    content: '【定时任务 晨检】\n全部探活正常',
    channels: ['feishu'],
    sourceTask: { taskId: 'task-morning-check', runId: 'run-1' },
    ...overrides,
  };
}

function dispatch(
  assembly: ProactiveMessageAssembly,
  fixture: Fixture,
  request: ProactiveTriggerRequest,
  options?: { sendTimeoutMs?: number; nowMs?: () => number },
) {
  return deliverProactiveTrigger((req) => assembly.notify(req), request, {
    deliveryLog: fixture.deliveryLog,
    nowMs: options?.nowMs ?? (() => NOW_MS),
    sendTimeoutMs: options?.sendTimeoutMs,
  });
}

// ─── 该发的发：按声明渠道投递 + 投递记录可查询 ───────────────

describe('按声明渠道投递（频控入口）', () => {
  test('多渠道声明：配置目标照发，未配置目标按 no-target 跳过，汇总与审计一致', async () => {
    const fixture = makeFixture();
    const summary = await dispatch(
      makeAssembly(fixture, () => NOW_MS),
      fixture,
      makeRequest({ channels: ['feishu', 'wechat', 'dingtalk'] }),
    );

    expect(summary.failedCount).toBe(0);
    expect(summary.attempts).toHaveLength(3);
    // wechat 在注册表内但未配置渠道条目 → 回落全局默认 defaultTarget=null
    // → skipped(no-target)
    expect(summary.attempts[1]).toMatchObject({
      channelId: 'wechat',
      outcome: 'skipped',
      target: null,
    });
    expect(summary.attempts[0]).toMatchObject({
      channelId: 'feishu',
      outcome: 'sent',
      target: 'ou_admin',
    });
    expect(summary.attempts[2]).toMatchObject({
      channelId: 'dingtalk',
      outcome: 'sent',
      target: 'c2c:cid_admin',
    });
    expect(fixture.adapters.feishu?.sent).toEqual([
      { target: 'ou_admin', text: '【定时任务 晨检】\n全部探活正常' },
    ]);

    const records = fixture.deliveryLog.queryDeliveries({
      taskId: 'task-morning-check',
    });
    expect(records.map((row) => row.outcome)).toEqual([
      'sent',
      'skipped',
      'sent',
    ]);
  });

  test('冷却去重经触发链路生效：同渠道同目标同内容第二次触发 discard', async () => {
    const fixture = makeFixture({
      config: {
        version: 1,
        rateLimitPerMinute: 10,
        cooldownMs: 3_600_000,
        channels: { feishu: { defaultTarget: 'ou_admin' } },
      },
    });
    const assembly = makeAssembly(fixture, () => NOW_MS);
    await dispatch(assembly, fixture, makeRequest());
    const second = await dispatch(assembly, fixture, makeRequest());

    expect(second.attempts[0]).toMatchObject({
      channelId: 'feishu',
      outcome: 'discard',
    });
    expect(second.failedCount).toBe(0);
    // 审计记录全量（discard 也留痕），频控事实只记真实发送（一行）
    expect(
      fixture.deliveryLog.queryDeliveries({ outcome: 'discard' }),
    ).toHaveLength(1);
    expect(fixture.rateStore.recentSendTimesMs('feishu', 0)).toHaveLength(1);
  });
});

describe('投递记录可查询（SPEC user story 10）', () => {
  test('渠道/目标/时间/送达结果/来源任务全字段可查，倒序、过滤、limit', async () => {
    const fixture = makeFixture();
    await dispatch(
      makeAssembly(fixture, () => NOW_MS),
      fixture,
      makeRequest({
        triggerKey: 'task-a',
        sourceTask: { taskId: 'task-a', runId: 'run-a1' },
      }),
      { nowMs: () => NOW_MS },
    );
    const laterMs = NOW_MS + 1000;
    await dispatch(
      makeAssembly(fixture, () => laterMs),
      fixture,
      makeRequest({
        triggerKey: 'task-b',
        channels: ['dingtalk'],
        sourceTask: { taskId: 'task-b', runId: null },
      }),
      { nowMs: () => laterMs },
    );

    const all = fixture.deliveryLog.queryDeliveries();
    expect(all).toHaveLength(2);
    // 倒序：最新的 task-b 在前
    expect(all[0]).toEqual(
      expect.objectContaining({
        channelId: 'dingtalk',
        target: 'c2c:cid_admin',
        messageKey: 'task-b',
        outcome: 'sent',
        triggerKind: 'scheduled-task',
        taskId: 'task-b',
        runId: null,
        createdAtMs: laterMs,
      } satisfies Partial<ProactiveDeliveryRecord>),
    );
    expect(all[1]).toEqual(
      expect.objectContaining({
        channelId: 'feishu',
        target: 'ou_admin',
        messageKey: 'task-a',
        outcome: 'sent',
        runId: 'run-a1',
        createdAtMs: NOW_MS,
        reason: expect.any(String),
      }),
    );

    expect(
      fixture.deliveryLog
        .queryDeliveries({ channelId: 'feishu' })
        .map((row) => row.taskId),
    ).toEqual(['task-a']);
    expect(
      fixture.deliveryLog
        .queryDeliveries({ messageKey: 'task-b' })
        .map((row) => row.outcome),
    ).toEqual(['sent']);
    expect(fixture.deliveryLog.queryDeliveries({ limit: 1 })).toHaveLength(1);
  });
});

// ─── per-send 超时（B3 承接①）：悬挂适配器 → send-timeout 而非卡死 ──

describe('per-send 超时', () => {
  test('悬挂适配器：dispatch 在上界内返回 send-timeout，WARN 明示，审计留痕', async () => {
    const hanging = new HangingAdapter();
    const fixture = makeFixture({ adapters: { feishu: hanging as never } });
    const startedAt = Date.now();
    const summary = await dispatch(
      makeAssembly(fixture, () => NOW_MS),
      fixture,
      makeRequest(),
      { sendTimeoutMs: 60 },
    );
    const elapsed = Date.now() - startedAt;

    // 有界返回：不悬挂（默认上界 10s；本用例注入 60ms）
    expect(elapsed).toBeLessThan(DEFAULT_SEND_TIMEOUT_MS);
    expect(summary.attempts[0]).toMatchObject({
      channelId: 'feishu',
      outcome: 'send-timeout',
      reason: expect.stringContaining('超时'),
    });
    expect(summary.failedCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'feishu', sendTimeoutMs: 60 }),
      expect.stringContaining('发送超时'),
    );
    const [record] = fixture.deliveryLog.queryDeliveries({
      outcome: 'send-timeout',
    });
    expect(record).toMatchObject({
      channelId: 'feishu',
      taskId: 'task-morning-check',
      runId: 'run-1',
    });
  });

  test('超时后迟到的真实发送：不重复记审计（观察口径=超时），频控账本如实记实际发生', async () => {
    const hanging = new HangingAdapter();
    const fixture = makeFixture({ adapters: { feishu: hanging as never } });
    const summary = await dispatch(
      makeAssembly(fixture, () => NOW_MS),
      fixture,
      makeRequest(),
      { sendTimeoutMs: 60 },
    );
    expect(summary.attempts[0]?.outcome).toBe('send-timeout');

    // 适配器此刻才完成真实发送（上游 WS/HTTP 迟到 ACK 的镜像）
    hanging.settle({ action: 'resolve' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 审计库仍只有一行（send-timeout），不因迟到完成追加 sent
    const records = fixture.deliveryLog.queryDeliveries();
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe('send-timeout');
    // 频控账本记实际发生：迟到发送进入滑动窗口事实（限速照算，宁严勿漏）
    expect(fixture.rateStore.recentSendTimesMs('feishu', 0)).toHaveLength(1);
  });

  test('悬挂后迟到的 rejection 被吸收：不产生 unhandled rejection', async () => {
    const hanging = new HangingAdapter();
    const fixture = makeFixture({ adapters: { feishu: hanging as never } });
    const summary = await dispatch(
      makeAssembly(fixture, () => NOW_MS),
      fixture,
      makeRequest(),
      { sendTimeoutMs: 60 },
    );
    expect(summary.attempts[0]?.outcome).toBe('send-timeout');

    hanging.settle({ action: 'reject', error: new Error('迟到的连接重置') });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 到此未炸即通过（vitest 会把 unhandled rejection 记为用例失败）
  });
});

// ─── 兜底承接（B3 承接②）：notify reject 内化，不逃出分发器 ──

describe('兜底承接', () => {
  test('notify 公开面 reject：折 send-failed 内化，dispatch 正常 resolve', async () => {
    const fixture = makeFixture();
    const summary = await deliverProactiveTrigger(
      async () => {
        throw new Error('装配自身意外');
      },
      makeRequest(),
      { deliveryLog: fixture.deliveryLog },
    );

    expect(summary.attempts[0]).toMatchObject({
      channelId: 'feishu',
      outcome: 'send-failed',
      reason: expect.stringContaining('投递异常：装配自身意外'),
    });
    expect(summary.failedCount).toBe(1);
    expect(
      fixture.deliveryLog.queryDeliveries({ outcome: 'send-failed' }),
    ).toHaveLength(1);
  });

  test('适配器发送抛错：send-failed，审计留痕，失败计数供运行日志留痕', async () => {
    const fixture = makeFixture({
      adapters: { feishu: new FakeAdapter(new Error('渠道断连')) },
    });
    const summary = await dispatch(
      makeAssembly(fixture, () => NOW_MS),
      fixture,
      makeRequest(),
    );
    expect(summary.attempts[0]).toMatchObject({
      outcome: 'send-failed',
      target: 'ou_admin',
      reason: expect.stringContaining('渠道断连'),
    });
  });
});

// ─── 补发语义（B3 承接③）：hold 无定时器，下轮触发自然补发 ──

describe('补发语义', () => {
  test('静默窗口内 hold → 窗口外再次触发 sent；分发器无重试、无状态残留', async () => {
    // 静默窗 23:00-07:00（UTC+8）：首触发 23:30 在窗内，次触发次日 08:30 在窗外
    const fixture = makeFixture({
      config: {
        version: 1,
        timeZoneOffsetMinutes: 480,
        channels: { feishu: { defaultTarget: 'ou_admin' } },
        quietWindows: {
          'task-morning-check': [{ start: '23:00', end: '07:00' }],
        },
      },
    });
    const inWindowClock = Date.parse('2026-09-11T15:30:00Z'); // UTC+8 23:30
    const outClock = inWindowClock + 9 * 3600_000; // 次日 08:30（UTC+8）

    const first = await dispatch(
      makeAssembly(fixture, () => inWindowClock),
      fixture,
      makeRequest(),
      { nowMs: () => inWindowClock },
    );
    expect(first.attempts[0]).toMatchObject({ outcome: 'hold' });
    expect(fixture.adapters.feishu?.sent).toHaveLength(0);

    // 「下一次触发」= 触发源按原节奏再调一次（时钟已到窗外）；分发器不做
    // 任何重试/排队，窗口外首次触发即送达
    const second = await dispatch(
      makeAssembly(fixture, () => outClock),
      fixture,
      makeRequest(),
      { nowMs: () => outClock },
    );

    expect(second.attempts[0]).toMatchObject({ outcome: 'sent' });
    expect(fixture.adapters.feishu?.sent).toHaveLength(1);
    const outcomes = fixture.deliveryLog
      .queryDeliveries({ taskId: 'task-morning-check' })
      .map((row) => row.outcome);
    expect(outcomes).toEqual(['sent', 'hold']);
  });
});

// ─── 声明渠道归一化 + 生产工厂 ───────────────────────────────

describe('normalizeDeclaredChannels', () => {
  test('登记外 id 过滤并告警、去重保序、空值折空', () => {
    expect(normalizeDeclaredChannels(['feishu', 'feishu', 'dingtalk'])).toEqual(
      ['feishu', 'dingtalk'],
    );
    expect(normalizeDeclaredChannels(['feishu', 'sms', 42 as never])).toEqual([
      'feishu',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'sms' }),
      expect.any(String),
    );
    expect(normalizeDeclaredChannels(null)).toEqual([]);
    expect(normalizeDeclaredChannels([])).toEqual([]);
    expect(normalizeDeclaredChannels(undefined)).toEqual([]);
  });
});

describe('createSchedulerProactiveNotifier（生产工厂）', () => {
  // 工厂内部的库连接不暴露 close（进程生命周期单例语义），测试里把两个库
  // 路径都指向被文件占据的父目录（构造必炸、零真实句柄），沿 B3 工厂降级
  // 用例的同一手法——这同时正是本用例要钉的行为：库全坏，投递照常 fail-open。
  test('库构造全炸仍投递（fail-open + 免审计降级），归一化过滤登记外渠道', async () => {
    const dir = makeFixtureDir('proactive-factory-');
    const configPath = writeConfig(dir, {
      version: 1,
      channels: { feishu: { defaultTarget: 'ou_admin' } },
    });
    // dbPath/审计路径落在普通文件之下 → mkdir 抛错 → 构造失败（真实抛错路径）
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'occupied', 'utf-8');
    const adapter = new FakeAdapter();
    const notify = createSchedulerProactiveNotifier({
      configPath,
      rateControlDbPath: path.join(blocker, 'db', 'rate.db'),
      deliveriesDbPath: path.join(blocker, 'db', 'audit.db'),
      resolveAdapter: (channelId) => (channelId === 'feishu' ? adapter : null),
      nowMs: () => NOW_MS,
    });

    const summary = await notify({
      taskId: 'task-x',
      runId: 'run-x1',
      notifyChannels: ['feishu', 'sms'],
      content: '晨检正常',
    });
    // 频控库缺失 → fail-open 直发；审计库缺失 → 免审计继续投（WARN 明示）
    expect(summary.attempts.map((attempt) => attempt.channelId)).toEqual([
      'feishu',
    ]);
    expect(summary.attempts[0]).toMatchObject({ outcome: 'sent' });
    expect(adapter.sent).toEqual([{ target: 'ou_admin', text: '晨检正常' }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPath: path.join(blocker, 'db', 'audit.db'),
      }),
      expect.stringContaining('审计库构造失败'),
    );

    // 空声明：不触发任何投递
    const empty = await notify({
      taskId: 'task-y',
      runId: null,
      notifyChannels: [],
      content: '无声明',
    });
    expect(empty).toEqual({ attempts: [], failedCount: 0 });
  });

  test('适配器解析缝违约抛错：装配承接折 skipped，工厂闭包不抛', async () => {
    const dir = makeFixtureDir('proactive-factory-bad-');
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'occupied', 'utf-8');
    const notify = createSchedulerProactiveNotifier({
      configPath: path.join(dir, 'missing.json'),
      rateControlDbPath: path.join(blocker, 'db', 'rate.db'),
      deliveriesDbPath: path.join(blocker, 'db', 'audit.db'),
      resolveAdapter: () => {
        throw new Error('resolver 违约');
      },
      nowMs: () => NOW_MS,
    });
    const summary = await notify({
      taskId: 'task-z',
      runId: null,
      notifyChannels: ['feishu'],
      content: 'x',
    });
    expect(summary.attempts[0]).toMatchObject({
      outcome: 'skipped',
      target: null,
    });
  });
});
