import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-binding-'));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
  DATA_DIR: tmp,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const { bindImChannelAdapter } =
  await import('../src/proactive-message/delivery-assembly.js');
const { createSchedulerProactiveNotifier } =
  await import('../src/proactive-message/trigger-dispatch.js');
type IMChannel = import('../src/im-channel.js').IMChannel;

// 批二 B5（票 #25）生产绑定测试：im-manager.getConnectedChannel 只读缝 +
// 「admin → getConnectedChannel → bindImChannelAdapter」接线（与 src/index.ts
// schedulerDeps 的 resolveAdapter 同形）。核心安全断言：渠道未连接 / 账号停用
// / admin 缺省时，解析折 null → 主动消息 skipped（可观察），绝不意外发送。

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeChannel(
  overrides: Partial<IMChannel> = {},
): IMChannel & { sent: { target: string; text: string }[] } {
  const sent: { target: string; text: string }[] = [];
  return {
    sent,
    channelType: 'wechat',
    connect: async () => true,
    disconnect: async () => undefined,
    sendMessage: async (target: string, text: string) => {
      sent.push({ target, text });
    },
    setTyping: async () => undefined,
    isConnected: () => true,
    ...overrides,
  };
}

async function connect(
  manager: InstanceType<typeof IMConnectionManager>,
  userId: string,
  channelType: string,
  channel: IMChannel,
  accountId?: string,
): Promise<void> {
  await manager.connectChannel(
    userId,
    channelType,
    channel,
    { onReady: vi.fn(), onNewChat: vi.fn() },
    accountId,
  );
}

function createActiveUser(id: string, role: 'admin' | 'member'): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'test',
    display_name: id,
    role,
    status: 'active',
    permissions: [],
    created_at: now,
    updated_at: now,
  });
}

describe('im-manager.getConnectedChannel (read-only binding seam, #25)', () => {
  test('returns the connected instance when user + account are allowed', async () => {
    createActiveUser('admin-1', 'admin');
    db.createChannelAccount({
      id: 'acct-1',
      owner_user_id: 'admin-1',
      provider: 'wechat',
      name: 'WeChat account',
      secret_ref: 'secret-acct-1',
      enabled: true,
      auth_status: 'authorized',
    });
    const channel = fakeChannel();
    const manager = new IMConnectionManager();
    await connect(manager, 'admin-1', 'wechat', channel, 'acct-1');

    expect(manager.getConnectedChannel('admin-1', 'wechat', 'acct-1')).toBe(
      channel,
    );
    expect(manager.getConnectedChannel('admin-1', 'wechat')).toBe(channel);

    await manager.disconnectAll();
  });

  test('returns undefined when the channel is not connected or foreign/disabled', async () => {
    createActiveUser('admin-2', 'admin');
    createActiveUser('member-2', 'member');
    db.createChannelAccount({
      id: 'acct-2',
      owner_user_id: 'admin-2',
      provider: 'feishu',
      name: 'Feishu account',
      secret_ref: 'secret-acct-2',
      enabled: true,
      auth_status: 'authorized',
    });
    const channel = fakeChannel({ channelType: 'feishu' });
    const manager = new IMConnectionManager();
    await connect(manager, 'admin-2', 'feishu', channel, 'acct-2');

    // 未注册的渠道类型 / 完全未连接的用户
    expect(manager.getConnectedChannel('admin-2', 'wechat')).toBeUndefined();
    expect(manager.getConnectedChannel('nobody', 'feishu')).toBeUndefined();
    // 账号归属他人（foreign）→ 出站门控拒绝
    expect(
      manager.getConnectedChannel('member-2', 'feishu', 'acct-2'),
    ).toBeUndefined();

    // 账号停用 → 门控拒绝（socket 仍在 ≠ 有权发）
    db.updateChannelAccount('acct-2', 'admin-2', { enabled: false });
    expect(
      manager.getConnectedChannel('admin-2', 'feishu', 'acct-2'),
    ).toBeUndefined();

    // 用户停用 → 门控拒绝
    db.updateChannelAccount('acct-2', 'admin-2', { enabled: true });
    db.updateUserFields('admin-2', { status: 'disabled' });
    expect(
      manager.getConnectedChannel('admin-2', 'feishu', 'acct-2'),
    ).toBeUndefined();
    expect(manager.getConnectedChannel('admin-2', 'feishu')).toBeUndefined();

    await manager.disconnectAll();
  });

  test('accountId omitted also matches legacy bare-key connections (no account)', async () => {
    createActiveUser('admin-3b', 'admin');
    // 不传 accountId 的 connectChannel = legacy 裸键连接（键=channelType 本身）
    const bare = fakeChannel({ channelType: 'feishu' });
    const manager = new IMConnectionManager();
    await connect(manager, 'admin-3b', 'feishu', bare);

    // 裸键条目在缺省枚举中可命中（getConnectedChannelAccountIds 不收集裸键，
    // 本方法口径更宽——见方法注释）
    expect(manager.getConnectedChannel('admin-3b', 'feishu')).toBe(bare);
    expect(manager.getConnectedChannel('admin-3b', 'wechat')).toBeUndefined();

    await manager.disconnectAll();
  });

  test('accountId omitted resolves to the first connected+allowed entry of the type', async () => {
    createActiveUser('admin-3', 'admin');
    for (const id of ['acct-3a', 'acct-3b']) {
      db.createChannelAccount({
        id,
        owner_user_id: 'admin-3',
        provider: 'dingtalk',
        name: id,
        secret_ref: `secret-${id}`,
        enabled: true,
        auth_status: 'authorized',
      });
    }
    const first = fakeChannel({ channelType: 'dingtalk' });
    const second = fakeChannel({ channelType: 'dingtalk' });
    const manager = new IMConnectionManager();
    await connect(manager, 'admin-3', 'dingtalk', first, 'acct-3a');
    await connect(manager, 'admin-3', 'dingtalk', second, 'acct-3b');

    // Map 插入序取首个（与 getConnectedChannelAccountIds 枚举语义一致）
    expect(manager.getConnectedChannel('admin-3', 'dingtalk')).toBe(first);
    // 指定 accountId 精确命中
    expect(manager.getConnectedChannel('admin-3', 'dingtalk', 'acct-3b')).toBe(
      second,
    );

    await manager.disconnectAll();
  });
});

describe('B5 production wiring: admin → getConnectedChannel → bindImChannelAdapter', () => {
  // 库路径指向被文件占据的父目录（构造必炸、零真实句柄）——沿 B4 工厂测试
  // 同一手法（proactive-trigger-dispatch.test.ts「库构造全炸仍投递」用例）：
  // 工厂内部库连接不暴露 close，Windows 下未释放句柄会让 rmSync EPERM。
  // 频控降级 fail-open、审计免落——B5 要钉的是适配器解析面，与库行为正交。
  function makeNotifier(
    resolveAdapter: ReturnType<typeof bindImChannelAdapter>,
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-wiring-'));
    const configPath = path.join(dir, 'proactive-message.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        channels: {
          wechat: { defaultTarget: 'wxid_admin' },
        },
      }),
      'utf-8',
    );
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'occupied', 'utf-8');
    const notifier = createSchedulerProactiveNotifier({
      configPath,
      rateControlDbPath: path.join(blocker, 'db', 'rate.db'),
      deliveriesDbPath: path.join(blocker, 'db', 'audit.db'),
      resolveAdapter,
    });
    return {
      notifier,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  test('default behavior stays safe: unconnected channel resolves to skipped, nothing sent', async () => {
    createActiveUser('admin-4', 'admin');
    const manager = new IMConnectionManager();
    // 与 src/index.ts resolveAdapter 同形的接线（admin → 只读缝 → 端口折算）
    const { notifier, cleanup } = makeNotifier(
      bindImChannelAdapter((channelId) => {
        const adminId = db.listUsers({
          status: 'active',
          role: 'admin',
          page: 1,
          pageSize: 1,
        }).users[0]?.id;
        return adminId
          ? manager.getConnectedChannel(adminId, channelId)
          : undefined;
      }),
    );

    const summary = await notifier({
      taskId: 'task-unconnected',
      runId: null,
      triggerType: 'scheduled',
      notifyChannels: ['wechat'],
      content: '不应送达：渠道未连接',
    });

    expect(summary.attempts).toHaveLength(1);
    expect(summary.attempts[0]?.outcome).toBe('skipped');
    expect(summary.attempts[0]?.target).toBeNull();
    expect(summary.failedCount).toBe(0);

    await manager.disconnectAll();
    cleanup();
  });

  test('connected channel delivers through the bound IMChannel; missing admin stays skipped', async () => {
    createActiveUser('admin-5', 'admin');
    db.createChannelAccount({
      id: 'acct-5',
      owner_user_id: 'admin-5',
      provider: 'wechat',
      name: 'WeChat account',
      secret_ref: 'secret-acct-5',
      enabled: true,
      auth_status: 'authorized',
    });
    const channel = fakeChannel();
    const manager = new IMConnectionManager();
    await connect(manager, 'admin-5', 'wechat', channel, 'acct-5');

    const resolve = bindImChannelAdapter((channelId) => {
      const adminId = db.listUsers({
        status: 'active',
        role: 'admin',
        page: 1,
        pageSize: 1,
      }).users[0]?.id;
      return adminId
        ? manager.getConnectedChannel(adminId, channelId)
        : undefined;
    });
    const { notifier, cleanup } = makeNotifier(resolve);

    const summary = await notifier({
      taskId: 'task-connected',
      runId: null,
      triggerType: 'manual',
      notifyChannels: ['wechat'],
      content: 'Ydisks 探活 200 正常',
    });

    expect(summary.attempts[0]?.outcome).toBe('sent');
    expect(summary.attempts[0]?.target).toBe('wxid_admin');
    expect(summary.failedCount).toBe(0);
    // 发送经真实 IMChannel 实例（目标原样透传、内容不改写）
    expect(channel.sent).toEqual([
      { target: 'wxid_admin', text: 'Ydisks 探活 200 正常' },
    ]);

    // admin 不存在（如全部停用）→ 同一接线短路为 undefined → skipped 不发送
    db.updateUserFields('admin-5', { status: 'disabled' });
    channel.sent.length = 0;
    const summaryNoAdmin = await notifier({
      taskId: 'task-no-admin',
      runId: null,
      triggerType: 'scheduled',
      notifyChannels: ['wechat'],
      content: '不应送达：admin 缺省',
    });
    expect(summaryNoAdmin.attempts[0]?.outcome).toBe('skipped');
    expect(channel.sent).toEqual([]);

    await manager.disconnectAll();
    cleanup();
  });
});
