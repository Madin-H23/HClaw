import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_PROACTIVE_MESSAGE_CONFIG,
  ProactiveMessageConfigLoader,
  resolveChannelRateControl,
} from '../src/proactive-message/config.js';

// 频控配置装载（票 #22）：沿 quota-router 配置装载模式——mtime 热生效、
// 坏文件保 last-good、缺省方向 = 最少节制（宁多勿丢，ADR-0008）。
// 渠道 key 以 channel-registry 派生联合为准入（ADR-0009 单一事实源）。

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-cfg-'));
  tmpDirs.push(dir);
  return { dir, file: path.join(dir, 'proactive-message.json') };
}

function loaderWith(raw: unknown): ProactiveMessageConfigLoader {
  const { file } = tmpFile();
  fs.writeFileSync(file, JSON.stringify(raw));
  return new ProactiveMessageConfigLoader(file);
}

function bumpMtime(file: string): void {
  // mtime 精度：显式 bumped mtime 保证重读（Windows mtime 粒度粗）
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);
}

describe('缺省方向（配置缺失 = 最少节制，宁多勿丢）', () => {
  test('文件不存在 → 全缺省：限速 10 条/分钟、冷却关闭、无静默窗口', () => {
    const { dir } = tmpFile();
    const loader = new ProactiveMessageConfigLoader(
      path.join(dir, 'absent.json'),
    );
    expect(loader.get()).toEqual(DEFAULT_PROACTIVE_MESSAGE_CONFIG);
    expect(loader.get().rateLimitPerMinute).toBe(10);
    expect(loader.get().cooldownMs).toBe(0);
    expect(loader.get().quietWindows).toEqual({});
    expect(loader.get().channels).toEqual({});
  });

  test('缺省常量本身：限速默认 10 条/分钟（票面钉死）、时区默认 UTC+8', () => {
    expect(DEFAULT_PROACTIVE_MESSAGE_CONFIG.rateLimitPerMinute).toBe(10);
    expect(DEFAULT_PROACTIVE_MESSAGE_CONFIG.cooldownMs).toBe(0);
    expect(DEFAULT_PROACTIVE_MESSAGE_CONFIG.timeZoneOffsetMinutes).toBe(480);
    expect(DEFAULT_PROACTIVE_MESSAGE_CONFIG.channels).toEqual({});
  });

  test('空对象 / 非法字段逐项回缺省（宽松解析不炸投递）', () => {
    const config = loaderWith({
      rateLimitPerMinute: 'ten',
      cooldownMs: -5,
      timeZoneOffsetMinutes: 2000,
      channels: 'nope',
      quietWindows: 42,
    }).get();
    expect(config.rateLimitPerMinute).toBe(10);
    expect(config.cooldownMs).toBe(0);
    expect(config.timeZoneOffsetMinutes).toBe(480);
    expect(config.channels).toEqual({});
    expect(config.quietWindows).toEqual({});
  });
});

describe('热生效与 last-good', () => {
  test('热生效：改文件并推进 mtime 后 get() 读到新值', () => {
    const { file } = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ rateLimitPerMinute: 3 }));
    const loader = new ProactiveMessageConfigLoader(file);
    expect(loader.get().rateLimitPerMinute).toBe(3);

    fs.writeFileSync(file, JSON.stringify({ rateLimitPerMinute: 7 }));
    bumpMtime(file);
    expect(loader.get().rateLimitPerMinute).toBe(7);
  });

  test('坏文件（非法 JSON）→ 保留 last-good 并告警', () => {
    const { file } = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ rateLimitPerMinute: 5 }));
    const loader = new ProactiveMessageConfigLoader(file);
    expect(loader.get().rateLimitPerMinute).toBe(5);

    fs.writeFileSync(file, '{not json');
    bumpMtime(file);
    expect(loader.get().rateLimitPerMinute).toBe(5);
  });

  test('类型错乱但合法 JSON → 非法字段回缺省（宽松解析，沿 quota-router 模式），不炸不缓存毒化', () => {
    const { file } = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ cooldownMs: 600_000, channels: { feishu: {} } }),
    );
    const loader = new ProactiveMessageConfigLoader(file);
    expect(loader.get().cooldownMs).toBe(600_000);

    // 合法 JSON 内的单字段类型错乱 ≠ 坏文件：按字段回缺省（last-good 只保
    // JSON 解析/读取失败的场景），其余字段照常解析
    fs.writeFileSync(
      file,
      JSON.stringify({ cooldownMs: 'later', rateLimitPerMinute: 4 }),
    );
    bumpMtime(file);
    expect(loader.get().cooldownMs).toBe(0);
    expect(loader.get().rateLimitPerMinute).toBe(4);
  });

  test('首次读取即坏文件 → 缺省（绝不因坏配置吞通知）', () => {
    const { file } = tmpFile();
    fs.writeFileSync(file, '{oops');
    const loader = new ProactiveMessageConfigLoader(file);
    expect(loader.get()).toEqual(DEFAULT_PROACTIVE_MESSAGE_CONFIG);
  });
});

describe('schema 解析', () => {
  test('每渠道条目解析：限速/冷却/默认私聊目标', () => {
    const config = loaderWith({
      channels: {
        feishu: {
          rateLimitPerMinute: 5,
          cooldownMs: 1_800_000,
          defaultTarget: 'ou_admin_1',
        },
      },
    }).get();
    expect(config.channels.feishu).toEqual({
      rateLimitPerMinute: 5,
      cooldownMs: 1_800_000,
      defaultTarget: 'ou_admin_1',
    });
  });

  test('渠道字段缺省/非法回落全局默认；目标空白折 null', () => {
    const config = loaderWith({
      rateLimitPerMinute: 8,
      cooldownMs: 600_000,
      channels: { wechat: { rateLimitPerMinute: 0, defaultTarget: '  ' } },
    }).get();
    expect(config.channels.wechat).toEqual({
      rateLimitPerMinute: 8,
      cooldownMs: 600_000,
      defaultTarget: null,
    });
  });

  test('注册外渠道 id 跳过（ADR-0009：渠道清单以 channel-registry 为准）', () => {
    const config = loaderWith({
      channels: {
        feishu: { defaultTarget: 'ou_ok' },
        skype: { defaultTarget: 'x' },
      },
    }).get();
    expect(Object.keys(config.channels)).toEqual(['feishu']);
  });

  test('静默窗口：HH:mm 折分钟、跨零点、days 过滤去重排序', () => {
    const config = loaderWith({
      quietWindows: {
        'morning-check': [
          { start: '23:00', end: '07:00' },
          { start: '12:30', end: '13:30', days: [6, 0, 6, 99, 'x'] },
        ],
      },
    }).get();
    expect(config.quietWindows['morning-check']).toEqual([
      {
        startMinuteOfDay: 1380,
        endMinuteOfDay: 420,
        days: [],
        timeZoneOffsetMinutes: 480,
      },
      {
        startMinuteOfDay: 750,
        endMinuteOfDay: 810,
        days: [0, 6],
        timeZoneOffsetMinutes: 480,
      },
    ]);
  });

  test('非法窗口条目跳过；全非法的任务键不残留', () => {
    const config = loaderWith({
      quietWindows: {
        'morning-check': [{ start: '25:00', end: '07:00' }, 'nope'],
        liveness: [{ start: '12:00', end: '12:60' }],
      },
    }).get();
    expect(config.quietWindows).toEqual({});
  });

  test('timeZoneOffsetMinutes 全局声明落到每个窗口', () => {
    const config = loaderWith({
      timeZoneOffsetMinutes: 0,
      quietWindows: { t: [{ start: '10:00', end: '11:00' }] },
    }).get();
    expect(config.quietWindows.t[0].timeZoneOffsetMinutes).toBe(0);
  });
});

describe('resolveChannelRateControl（装配侧取用点）', () => {
  test('已登记渠道 → 渠道条目原样；未登记渠道 → 全局默认拼装（无目标）', () => {
    const loader = loaderWith({
      rateLimitPerMinute: 8,
      cooldownMs: 600_000,
      channels: { feishu: { rateLimitPerMinute: 3, defaultTarget: 'ou_a' } },
    });
    const config = loader.get();
    expect(resolveChannelRateControl(config, 'feishu')).toEqual({
      rateLimitPerMinute: 3,
      cooldownMs: 600_000,
      defaultTarget: 'ou_a',
    });
    expect(resolveChannelRateControl(config, 'telegram')).toEqual({
      rateLimitPerMinute: 8,
      cooldownMs: 600_000,
      defaultTarget: null,
    });
  });
});
