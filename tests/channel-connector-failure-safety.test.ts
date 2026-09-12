import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// Windows 适配（#11）：core.autocrlf=true 检出使工作区源码为 CRLF，而断言以
// LF 文本为基准（跨行 needle）。读取后归一为 LF；POSIX 检出无 \r，为 no-op。
const source = (file: string) =>
  fs
    .readFileSync(path.resolve(process.cwd(), file), 'utf8')
    .replace(/\r\n/g, '\n');

describe('provider connector initial failure safety contract', () => {
  test('manager cleans rejected connectors before releasing credential claims', () => {
    const manager = source('src/im-manager.ts');
    expect(manager).toContain('const cleanupRejectedChannel = async');
    expect(manager).toContain('conn.channels.set(channelKey, channel)');
    expect(manager).toContain('if (await cleanupRejectedChannel())');
  });

  test('QQ does not start background reconnect before manager acceptance', () => {
    const qq = source('src/qq.ts');
    const start = qq.indexOf(
      "logger.error({ err }, 'QQ initial connection failed')",
    );
    const end = qq.indexOf('\n      }\n    },', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(qq.slice(start, end)).not.toContain('scheduleReconnect(');
  });

  test('Discord and DingTalk destroy partially initialized clients', () => {
    const discord = source('src/discord.ts');
    const discordStart = discord.indexOf(
      "logger.error({ err }, 'Discord initial connection failed')",
    );
    expect(discord.slice(discordStart, discordStart + 700)).toContain(
      'failedClient.destroy()',
    );

    const dingtalk = source('src/dingtalk.ts');
    const dingtalkStart = dingtalk.indexOf(
      "logger.error({ err }, 'DingTalk initial connection failed')",
    );
    expect(dingtalk.slice(dingtalkStart, dingtalkStart + 700)).toContain(
      'client.disconnect()',
    );
  });
});
