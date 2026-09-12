import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ChannelId } from '../src/channel-registry.js';
import type { IMChannel } from '../src/im-channel.js';
import { logger } from '../src/logger.js';
import { RATE_WINDOW_MS } from '../src/proactive-message/delivery-decision.js';
import {
  ProactiveMessageAssembly,
  bindImChannelAdapter,
  contentDigestOf,
  createProactiveMessageAssembly,
  type ProactiveChannelAdapter,
} from '../src/proactive-message/delivery-assembly.js';
import { ProactiveMessageConfigLoader } from '../src/proactive-message/config.js';
import {
  RateControlStateStore,
  type RecordedSend,
} from '../src/proactive-message/state-store.js';

// 投递入口装配集成测试（票 #23，SPEC #20 seam 2「投递装配注入」）：假渠道
// 适配器驱动真装配（真配置装载 + 真 SQLite 状态库 + 真决策纯函数），断言
// 「该发的发了、该压的压了、目标解析正确、频控故障照发」。外部行为优先：
// 断言适配器收到的发送与状态库落库事实（渠道/目标/时间/结果），不断言装配
// 内部调用次数。时钟全量注入（NOW_MS 远离真实时间——若装配自取时钟，落库
// sentAtMs 与断言值立刻错位，同源注入由该设计钉死）。

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NOW_MS = Date.parse('2026-09-11T12:00:00Z');

/** 假渠道适配器：记录收到的发送；可注入失败 */
class FakeAdapter implements ProactiveChannelAdapter {
  readonly sent: { target: string; text: string }[] = [];
  constructor(private readonly failure?: Error) {}
  async sendMessage(target: string, text: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.sent.push({ target, text });
  }
}

const tmpDirs: string[] = [];
const openStores: RateControlStateStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function makeFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-assembly-'));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, config: Record<string, unknown>): string {
  const configPath = path.join(dir, 'proactive-message.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return configPath;
}

function record(overrides?: Partial<RecordedSend>): RecordedSend {
  return {
    channelId: 'feishu',
    target: 'ou_admin',
    messageKey: 'probe',
    contentDigest: 'digest-x',
    sentAtMs: NOW_MS - 1_000,
    ...overrides,
  };
}

interface Fixture {
  assembly: ProactiveMessageAssembly;
  store: RateControlStateStore;
  adapters: Partial<Record<ChannelId, FakeAdapter>>;
  dir: string;
}

/** 标准装配：真配置文件 + 真状态库 + 假适配器（feishu/wechat/dingtalk 在线） */
function makeFixture(options?: {
  config?: Record<string, unknown>;
  nowMs?: () => number;
  adapters?: Partial<Record<ChannelId, FakeAdapter>>;
  resolveAdapter?: ProactiveChannelAdapterResolver;
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
        wechat: {
          defaultTarget: 'wxid_admin',
          rateLimitPerMinute: 3,
          cooldownMs: 3_600_000,
        },
        dingtalk: { defaultTarget: 'c2c:cid_admin' },
      },
    },
  );
  const dbPath = path.join(dir, 'db', 'proactive-message.db');
  const store = new RateControlStateStore(dbPath);
  openStores.push(store);
  const adapters = options?.adapters ?? {
    feishu: new FakeAdapter(),
    wechat: new FakeAdapter(),
    dingtalk: new FakeAdapter(),
  };
  const resolver =
    options?.resolveAdapter ??
    ((channelId: ChannelId) => adapters[channelId] ?? null);
  const assembly = new ProactiveMessageAssembly({
    configLoader: new ProactiveMessageConfigLoader(configPath),
    stateStore: store,
    resolveAdapter: resolver,
    nowMs: options?.nowMs ?? (() => NOW_MS),
  });
  return { assembly, store, adapters, dir };
}

// ─── 该发的发：正常路径送达 + recordSend 落库 ─────────────────

describe('该发的发', () => {
  test('正常路径：送达配置目标 + 落库（digest/sentAtMs 与决策同源）', async () => {
    const { assembly, store, adapters } = makeFixture();
    const content = '晨检：全部探活正常';
    const result = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'morning-check',
      content,
    });

    expect(result).toEqual({
      kind: 'sent',
      target: 'ou_admin',
      reason: expect.stringContaining('送达'),
      failOpen: false,
    });
    expect(adapters.feishu?.sent).toEqual([
      { target: 'ou_admin', text: content },
    ]);

    // recordSend 仅成功后落库：一行事实同时供限速层与冷却层查询
    expect(store.recentSendTimesMs('feishu', 0)).toEqual([NOW_MS]);
    const [row] = store.recentSendsOfKey(
      'feishu',
      'ou_admin',
      'morning-check',
      0,
    );
    expect(row).toEqual({
      sentAtMs: NOW_MS, // 同源注入：NOW_MS 远离真实时钟，自取时钟即错位
      contentDigest: contentDigestOf(content),
    });
  });

  test('三渠道目标解析：配置的默认私聊目标原样透传给各自适配器', async () => {
    const { assembly, adapters } = makeFixture();
    await assembly.notify({
      channelId: 'wechat',
      messageKey: 'k-wechat',
      content: 'wx 通知',
    });
    await assembly.notify({
      channelId: 'dingtalk',
      messageKey: 'k-dt',
      content: 'dt 通知',
    });

    expect(adapters.wechat?.sent).toEqual([
      { target: 'wxid_admin', text: 'wx 通知' },
    ]);
    expect(adapters.dingtalk?.sent).toEqual([
      { target: 'c2c:cid_admin', text: 'dt 通知' },
    ]);
  });
});

// ─── 该压的压：限速持有 / 冷却丢弃，均不调适配器、不落库 ───────

describe('该压的压', () => {
  test('限速持有：滑动窗口内已达上限 → 不发送、不落库', async () => {
    const { assembly, store, adapters } = makeFixture();
    // 预置 3 条同窗口发送事实（不同 digest，避开冷却层；wechat 上限=3）
    for (let i = 0; i < 3; i++) {
      store.recordSend(
        record({
          channelId: 'wechat',
          target: 'wxid_admin',
          messageKey: 'probe',
          contentDigest: `other-${i}`,
        }),
      );
    }
    const result = await assembly.notify({
      channelId: 'wechat',
      messageKey: 'probe',
      content: '新内容',
    });

    expect(result.kind).toBe('hold');
    expect(result.reason).toContain('上限');
    expect(adapters.wechat?.sent).toEqual([]);
    // 持有不落库（承接②）：key 记录仍为预置 3 条
    expect(
      store.recentSendsOfKey('wechat', 'wxid_admin', 'probe', 0),
    ).toHaveLength(3);
  });

  test('冷却丢弃：同渠道同类型同内容在冷却窗内 → 端到端丢弃、不发送', async () => {
    const { assembly, store, adapters } = makeFixture();
    const first = await assembly.notify({
      channelId: 'wechat',
      messageKey: 'probe',
      content: '探活正常',
    });
    expect(first.kind).toBe('sent');

    // 第二次同内容：冷却窗（1 小时）内 digest 相同 → 丢弃
    const second = await assembly.notify({
      channelId: 'wechat',
      messageKey: 'probe',
      content: '探活正常',
    });
    expect(second.kind).toBe('discard');
    expect(second.reason).toContain('冷却');
    expect(adapters.wechat?.sent).toHaveLength(1);
    expect(
      store.recentSendsOfKey('wechat', 'wxid_admin', 'probe', 0),
    ).toHaveLength(1);
  });

  test('同 key 不同内容不误判为重复（contentDigest 区分度）', async () => {
    const { assembly, store } = makeFixture();
    await assembly.notify({
      channelId: 'wechat',
      messageKey: 'probe',
      content: '探活正常',
    });
    const second = await assembly.notify({
      channelId: 'wechat',
      messageKey: 'probe',
      content: '探活正常（1 项异常）',
    });

    expect(second.kind).toBe('sent');
    const digests = store
      .recentSendsOfKey('wechat', 'wxid_admin', 'probe', 0)
      .map((row) => row.contentDigest);
    expect(digests).toHaveLength(2);
    expect(new Set(digests).size).toBe(2);
  });
});

// ─── 发送失败：不记假账（recordSend 只认真实成功，P1-1 不变量） ──

describe('发送失败', () => {
  test('适配器 reject → send-failed、不落库、WARN 含 target 与 err', async () => {
    const { assembly, store } = makeFixture({
      adapters: {
        feishu: new FakeAdapter(new Error('provider 5xx')),
        wechat: new FakeAdapter(),
        dingtalk: new FakeAdapter(),
      },
    });
    const result = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'probe',
      content: '会失败的发送',
    });

    expect(result).toMatchObject({ kind: 'send-failed', target: 'ou_admin' });
    expect(result.reason).toContain('provider 5xx');
    // 发送失败不落库（不记假账）：限速层与冷却层都查无记录
    expect(store.recentSendTimesMs('feishu', 0)).toEqual([]);
    expect(store.recentSendsOfKey('feishu', 'ou_admin', 'probe', 0)).toEqual(
      [],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'feishu',
        target: 'ou_admin',
        err: 'provider 5xx',
      }),
      expect.stringContaining('发送失败'),
    );
  });
});

// ─── 目标解析：未配置跳过 + 结构化日志；适配器不可用跳过 ────────

describe('目标解析与跳过', () => {
  test('未配置默认私聊目标 → 跳过 + 结构化日志，不触达适配器、不落库', async () => {
    // telegram 在注册表内但无配置条目 → resolveChannelRateControl 回落 defaultTarget=null
    const telegramAdapter = new FakeAdapter();
    const { assembly, store } = makeFixture({
      adapters: {
        feishu: new FakeAdapter(),
        wechat: new FakeAdapter(),
        dingtalk: new FakeAdapter(),
        telegram: telegramAdapter,
      },
    });
    const result = await assembly.notify({
      channelId: 'telegram',
      messageKey: 'probe',
      content: '不该发',
    });

    expect(result).toMatchObject({ kind: 'skipped', skipKind: 'no-target' });
    expect(telegramAdapter.sent).toEqual([]);
    expect(store.recentSendTimesMs('telegram', 0)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'telegram', skipKind: 'no-target' }),
      expect.stringContaining('未配置默认私聊目标'),
    );
  });

  test('渠道适配器不可用（未连接）→ 跳过且不落库（发送记录只认真实成功）', async () => {
    const { assembly, store } = makeFixture({
      adapters: { wechat: new FakeAdapter(), dingtalk: new FakeAdapter() }, // feishu 缺席
    });
    const result = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'probe',
      content: '渠道不在线',
    });

    expect(result).toMatchObject({
      kind: 'skipped',
      skipKind: 'adapter-unavailable',
    });
    expect(store.recentSendTimesMs('feishu', 0)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'feishu',
        skipKind: 'adapter-unavailable',
      }),
      expect.stringContaining('适配器不可用'),
    );
  });

  test('resolver 抛错（契约违约）→ 折成 adapter-unavailable，异常不逃出 notify', async () => {
    const { assembly, store } = makeFixture({
      resolveAdapter: () => {
        throw new Error('resolver boom');
      },
    });
    // await 本身成功（resolve 而非 reject）即证明异常未逃出可区分联合
    const result = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'probe',
      content: '解析缝违约',
    });

    expect(result).toMatchObject({
      kind: 'skipped',
      skipKind: 'adapter-unavailable',
    });
    expect(result.reason).toContain('resolver boom');
    expect(store.recentSendTimesMs('feishu', 0)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        skipKind: 'adapter-unavailable',
        err: 'resolver boom',
      }),
      expect.stringContaining('解析缝抛错'),
    );
  });
});

// ─── fail-open 两入口（承接④，方向=宁多勿丢） ────────────────

describe('fail-open：频控故障照发', () => {
  test('构造失败降级（承接①）：状态库构造抛错 → state=null 直发 failOpen=true', async () => {
    const dir = makeFixtureDir();
    const configPath = writeConfig(dir, {
      version: 1,
      channels: { feishu: { defaultTarget: 'ou_admin' } },
    });
    // dbPath 落在普通文件之下 → mkdir 抛错 → 构造失败（真实抛错路径，非桩）
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const dbPath = path.join(blocker, 'db', 'proactive-message.db');
    const adapter = new FakeAdapter();

    const assembly = createProactiveMessageAssembly({
      configPath,
      dbPath,
      resolveAdapter: (channelId) => (channelId === 'feishu' ? adapter : null),
      nowMs: () => NOW_MS,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath }),
      expect.stringContaining('构造失败'),
    );

    // 频控状态库缺失不吞通知：直发 failOpen=true，连续两次同内容都发（无去重可用）
    const first = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'probe',
      content: '照发',
    });
    const second = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'probe',
      content: '照发',
    });
    expect(first).toMatchObject({
      kind: 'sent',
      failOpen: true,
      target: 'ou_admin',
    });
    expect(second).toMatchObject({ kind: 'sent', failOpen: true });
    expect(adapter.sent).toHaveLength(2);
  });

  test('读失败折空（承接④）：已关闭的库读抛折空 → 全层放行 failOpen=false', async () => {
    const dir = makeFixtureDir();
    const configPath = writeConfig(dir, {
      version: 1,
      channels: { feishu: { defaultTarget: 'ou_admin' } },
    });
    const dbPath = path.join(dir, 'db', 'proactive-message.db');
    const store = new RateControlStateStore(dbPath);
    store.close(); // 此后所有读/写抛错：读被 store 折空，写被静默吸收
    const adapter = new FakeAdapter();
    const assembly = new ProactiveMessageAssembly({
      configLoader: new ProactiveMessageConfigLoader(configPath),
      stateStore: store,
      resolveAdapter: () => adapter,
      nowMs: () => NOW_MS,
    });

    const result = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'probe',
      content: '照发',
    });

    // 与构造降级的区分：state 非 null（只是空快照）→ 正常三层放行，failOpen=false
    expect(result).toMatchObject({
      kind: 'sent',
      failOpen: false,
      target: 'ou_admin',
    });
    expect(adapter.sent).toEqual([{ target: 'ou_admin', text: '照发' }]);
  });
});

// ─── prune 顺带调度（承接③） ────────────────────────────────

describe('prune 顺带调度', () => {
  test('keepWindowMs = 全渠道最大 cooldownMs（wechat 1 小时冷却压过 60 秒滑窗）', async () => {
    const { assembly, store } = makeFixture();
    const prune = vi.spyOn(store, 'prune');
    await assembly.notify({
      channelId: 'feishu',
      messageKey: 'probe',
      content: 'x',
    });

    expect(prune).toHaveBeenCalledWith(NOW_MS, 3_600_000);
  });

  test('keepWindowMs 下限 = 60 秒滑窗（无任何冷却配置时不低于 RATE_WINDOW_MS）', async () => {
    const { assembly, store } = makeFixture({
      config: {
        version: 1,
        channels: { feishu: { defaultTarget: 'ou_admin' } },
      },
    });
    const prune = vi.spyOn(store, 'prune');
    await assembly.notify({
      channelId: 'feishu',
      messageKey: 'probe',
      content: 'x',
    });

    expect(prune).toHaveBeenCalledWith(NOW_MS, RATE_WINDOW_MS);
  });

  test('行为级：窗外旧记录被清、窗内记录保留（剪太狠=冷却失效，不许发生）', async () => {
    const { assembly, store } = makeFixture();
    // wechat 冷却窗 1 小时：预置窗外（刚好超窗）与窗内各一条同 key 事实
    store.recordSend(
      record({
        channelId: 'wechat',
        target: 'wxid_admin',
        messageKey: 'probe',
        contentDigest: 'old',
        sentAtMs: NOW_MS - 3_600_000 - 1_000,
      }),
    );
    store.recordSend(
      record({
        channelId: 'wechat',
        target: 'wxid_admin',
        messageKey: 'probe',
        contentDigest: 'recent',
        sentAtMs: NOW_MS - 3_500_000,
      }),
    );

    const result = await assembly.notify({
      channelId: 'wechat',
      messageKey: 'probe',
      content: '当前播报',
    });

    expect(result.kind).toBe('sent');
    const digests = store
      .recentSendsOfKey('wechat', 'wxid_admin', 'probe', 0)
      .map((row) => row.contentDigest);
    expect(digests).toEqual(['recent', contentDigestOf('当前播报')]);
  });
});

// ─── 静默持有与补发语义（承接⑦：无独立定时器，下次触发重评估） ──

describe('静默持有与补发', () => {
  test('窗口内持有不发送；窗口结束首次触发同内容自然补发（无残留状态）', async () => {
    let now = Date.parse('2026-09-11T18:30:00Z'); // UTC+8 = 02:30，落在 23:00–07:00 窗内
    const { assembly, adapters } = makeFixture({
      config: {
        version: 1,
        timeZoneOffsetMinutes: 480,
        channels: { feishu: { defaultTarget: 'ou_admin' } },
        quietWindows: { 'morning-check': [{ start: '23:00', end: '07:00' }] },
      },
      nowMs: () => now,
    });

    const held = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'morning-check',
      content: '晨检播报',
    });
    expect(held).toMatchObject({ kind: 'hold' });
    expect(adapters.feishu?.sent).toEqual([]);

    // 时钟推进到窗口终点（终点不含=窗外）：同一内容、同一入口，重评估即补发
    now = Date.parse('2026-09-11T23:00:00Z'); // UTC+8 = 07:00
    const delivered = await assembly.notify({
      channelId: 'feishu',
      messageKey: 'morning-check',
      content: '晨检播报',
    });
    expect(delivered).toMatchObject({ kind: 'sent', target: 'ou_admin' });
    expect(adapters.feishu?.sent).toEqual([
      { target: 'ou_admin', text: '晨检播报' },
    ]);
  });
});

// ─── contentDigest 稳定摘要（承接⑧） ─────────────────────────

describe('contentDigest', () => {
  test('SHA-256 全长十六进制（算法以字面量钉死：落库摘要跨重启比对，漂移=冷却失忆）', () => {
    expect(contentDigestOf('probe')).toBe(
      'ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095',
    );
    expect(contentDigestOf('probe')).toBe(contentDigestOf('probe'));
    expect(contentDigestOf('probe ')).not.toBe(contentDigestOf('probe'));
  });
});

// ─── 三渠道编译期接入缝（bindImChannelAdapter） ───────────────

describe('bindImChannelAdapter', () => {
  function stubChannel(
    connected: boolean,
    sendMessage: IMChannel['sendMessage'],
  ): IMChannel {
    return {
      channelType: 'feishu',
      async connect() {
        return connected;
      },
      async disconnect() {},
      sendMessage,
      async setTyping() {},
      isConnected: () => connected,
    };
  }

  test('已连接实例折算成端口：目标与内容原样透传给 IMChannel.sendMessage', async () => {
    const sendMessage = vi.fn(async () => {});
    const resolver = bindImChannelAdapter((id) =>
      id === 'feishu' ? stubChannel(true, sendMessage) : null,
    );
    const adapter = resolver('feishu');
    expect(adapter).not.toBeNull();
    await adapter?.sendMessage('ou_admin', 'hello');
    expect(sendMessage).toHaveBeenCalledWith('ou_admin', 'hello');
  });

  test('未连接/未装配渠道返回 null（连接缺失挡在解析层，不让 sendMessage 静默吞掉）', () => {
    const disconnected = stubChannel(false, async () => {});
    expect(bindImChannelAdapter(() => disconnected)('feishu')).toBeNull();
    expect(bindImChannelAdapter(() => undefined)('feishu')).toBeNull();
  });
});
