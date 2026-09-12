import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// Windows 适配（#11）：core.autocrlf=true 检出使 Makefile 为 CRLF，而断言以
// LF 文本为基准（跨行正则）。读取后归一为 LF；POSIX 检出无 \r，为 no-op。
const makefile = fs
  .readFileSync(path.join(process.cwd(), 'Makefile'), 'utf8')
  .replace(/\r\n/g, '\n');

describe('Makefile runtime contract', () => {
  test('uses make start as the single production startup path', () => {
    expect(makefile).toMatch(/^start: ## 一键启动生产环境/m);
    expect(makefile).toContain('node dist/index.js');
    expect(makefile).not.toMatch(/pm2/i);
    expect(makefile).not.toContain('_start-direct');
  });

  test('uses the same native process model for development and lifecycle commands', () => {
    expect(makefile).toContain('export WEB_PORT := $(PORT)');
    expect(makefile).toMatch(/^dev-backend:.*\n\t\$\(RUNNER\)$/m);
    expect(makefile).toMatch(/^stop: ## 停止监听指定端口的服务进程/m);
    expect(makefile).not.toContain('PM2_GUARD');
    expect(makefile).toContain('$$(wc -l < /tmp/miniclaw.log)');
  });

  test('uses SQLite-aware backup and guarded restore commands', () => {
    expect(makefile).toContain('node scripts/sqlite-snapshot.mjs');
    expect(makefile).toContain(
      'node scripts/restore-backup.mjs assert-port-free',
    );
    expect(makefile).toContain('node scripts/restore-backup.mjs restore');
    expect(makefile).not.toContain("--exclude='data/db/messages.db-wal'");
  });
});
