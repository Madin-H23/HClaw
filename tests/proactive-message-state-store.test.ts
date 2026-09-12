import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  RateControlStateStore,
  type RecordedSend,
} from '../src/proactive-message/state-store.js';

// 频控状态独立存储（票 #22，ADR-0006 先例）：主动消息模块独占
// data/db/proactive-message.db，自己的建表迁移（PRAGMA user_version），与上游
// messages.db 零关联。公开面不抛错（读折空/写吸收）——存储故障朝「多发」方向
// 退化（宁多勿丢，ADR-0008）。better-sqlite3 为仓库既有依赖，零新增。

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-state-'));
  tmpDirs.push(dir);
  return path.join(dir, 'db', 'proactive-message.db');
}

function send(overrides?: Partial<RecordedSend>): RecordedSend {
  return {
    channelId: 'feishu',
    target: 'ou_admin',
    messageKey: 'morning-check',
    contentDigest: 'digest-v1',
    sentAtMs: 1_000_000,
    ...overrides,
  };
}

describe('独立 SQLite 文件（ADR-0006：模块独占、自己的迁移）', () => {
  test('按需建库（含嵌套 data/db 目录），迁移打 user_version 标', async () => {
    const dbPath = makeDbPath();
    const store = new RateControlStateStore(dbPath);
    store.close();
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(path.basename(dbPath)).toBe('proactive-message.db');
  });

  test('重启不重置冷却：close/reopen 后发送记录原样可查', () => {
    const dbPath = makeDbPath();
    const first = new RateControlStateStore(dbPath);
    first.recordSend(send({ sentAtMs: 5_000 }));
    first.close();

    const reopened = new RateControlStateStore(dbPath);
    try {
      expect(reopened.recentSendTimesMs('feishu', 0)).toEqual([5_000]);
      expect(
        reopened.recentSendsOfKey('feishu', 'ou_admin', 'morning-check', 0),
      ).toEqual([{ sentAtMs: 5_000, contentDigest: 'digest-v1' }]);
    } finally {
      reopened.close();
    }
  });
});

describe('读写接口（渠道滑窗 + 冷却去重两类消费）', () => {
  test('recentSendTimesMs：渠道级全目标合并，按 sinceMs 过滤升序', () => {
    const store = new RateControlStateStore(makeDbPath());
    try {
      store.recordSend(send({ target: 'ou_a', sentAtMs: 3_000 }));
      store.recordSend(send({ target: 'ou_b', sentAtMs: 1_000 }));
      store.recordSend(send({ channelId: 'qq', sentAtMs: 2_000 }));
      // 其他渠道不串
      expect(store.recentSendTimesMs('feishu', 0)).toEqual([1_000, 3_000]);
      expect(store.recentSendTimesMs('qq', 0)).toEqual([2_000]);
      // sinceMs 边界：>= 语义（恰好等于仍计入）
      expect(store.recentSendTimesMs('feishu', 3_000)).toEqual([3_000]);
    } finally {
      store.close();
    }
  });

  test('recentSendsOfKey：渠道+目标+类型三维隔离，摘要原样返回', () => {
    const store = new RateControlStateStore(makeDbPath());
    try {
      store.recordSend(send({ sentAtMs: 1_000 }));
      store.recordSend(
        send({
          target: 'ou_other',
          sentAtMs: 2_000,
          contentDigest: 'digest-v2',
        }),
      );
      store.recordSend(
        send({
          messageKey: 'liveness',
          sentAtMs: 3_000,
          contentDigest: 'digest-v3',
        }),
      );
      expect(
        store.recentSendsOfKey('feishu', 'ou_admin', 'morning-check', 0),
      ).toEqual([{ sentAtMs: 1_000, contentDigest: 'digest-v1' }]);
      expect(
        store.recentSendsOfKey('feishu', 'ou_admin', 'liveness', 0),
      ).toEqual([{ sentAtMs: 3_000, contentDigest: 'digest-v3' }]);
    } finally {
      store.close();
    }
  });

  test('无记录 → 空数组（调用侧据此放行，不构造哨兵对象）', () => {
    const store = new RateControlStateStore(makeDbPath());
    try {
      expect(store.recentSendTimesMs('feishu', 0)).toEqual([]);
      expect(
        store.recentSendsOfKey('feishu', 'ou_admin', 'morning-check', 0),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('prune：keepWindowMs 之前的旧行清理，窗口内记录保留', () => {
    const store = new RateControlStateStore(makeDbPath());
    try {
      store.recordSend(send({ sentAtMs: 1_000 }));
      store.recordSend(send({ sentAtMs: 9_000 }));
      store.prune(10_000, 5_000);
      expect(store.recentSendTimesMs('feishu', 0)).toEqual([9_000]);
    } finally {
      store.close();
    }
  });
});

describe('fail-open 存储面（公开面不抛错，故障折空 = 放行）', () => {
  test('连接关闭（存储故障）后：读折空数组、写静默吸收，绝不抛出', () => {
    const store = new RateControlStateStore(makeDbPath());
    store.close();
    expect(() => store.recordSend(send())).not.toThrow();
    expect(store.recentSendTimesMs('feishu', 0)).toEqual([]);
    expect(
      store.recentSendsOfKey('feishu', 'ou_admin', 'morning-check', 0),
    ).toEqual([]);
    expect(() => store.prune(10_000, 5_000)).not.toThrow();
  });

  test('折空状态喂给决策纯函数 → 全层放行（宁多勿丢的存储侧落点）', async () => {
    const { decideDelivery } =
      await import('../src/proactive-message/delivery-decision.js');
    const store = new RateControlStateStore(makeDbPath());
    store.recordSend(send({ sentAtMs: 1_000 }));
    store.close(); // 存储故障

    const decision = decideDelivery({
      channelId: 'feishu',
      target: 'ou_admin',
      messageKey: 'morning-check',
      contentDigest: 'digest-v1',
      channelLimitPerMinute: 1,
      cooldownMs: 600_000,
      quietWindows: [],
      // 存储读折空 → 决策状态为空（非 null 的空态也放行）
      state: {
        recentSendTimesMs: store.recentSendTimesMs('feishu', 0),
        recentSendsOfKey: store.recentSendsOfKey(
          'feishu',
          'ou_admin',
          'morning-check',
          0,
        ),
      },
      nowMs: 2_000,
    });
    expect(decision).toMatchObject({ kind: 'deliver', failOpen: false });
  });
});
