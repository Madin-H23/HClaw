import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-runner-abort-'));
const groups = path.join(root, 'groups');
fs.mkdirSync(path.join(groups, 'workspace'), { recursive: true });

vi.mock('../src/config.js', () => ({ GROUPS_DIR: groups }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    containerTimeout: 30_000,
  }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('script run cancellation', () => {
  test('aborts only the selected process and never maps SIGKILL to exit 0', async () => {
    const { runScript } = await import('../src/script-runner.js');
    const controller = new AbortController();
    const startedAt = Date.now();
    // Windows 适配（#15）：POSIX 的 sleep 在 Windows 不存在，用系统自带的
    // ping -n 10（≈9s）等价构造"会被 abort 打断的长任务"；断言不变
    // （aborted:true / exitCode:null——abort 强杀不得映射为成功退出码）。
    const longRunningCommand =
      process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    const pending = runScript(longRunningCommand, 'workspace', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort('cancelled'), 30);

    const result = await pending;
    expect(result).toMatchObject({
      aborted: true,
      timedOut: false,
      exitCode: null,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
