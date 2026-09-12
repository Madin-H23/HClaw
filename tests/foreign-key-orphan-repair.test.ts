import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { rmTempDirWithRetry } from './helpers/win-fs-retry.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-repair-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const { initDatabase, closeDatabase, ensureChatExists, storeMessageDirect } =
  await import('../src/db.js');

const dbPath = path.join(tmpStoreDir, 'messages.db');

afterAll(async () => {
  closeDatabase();
  await rmTempDirWithRetry(tmpDir);
});

describe('startup foreign-key orphan repair', () => {
  test('completes an interrupted chat-deletion cascade and keeps enforcement on', () => {
    initDatabase();
    ensureChatExists('feishu:doomed-chat');
    storeMessageDirect(
      'orphan-1',
      'feishu:doomed-chat',
      'ou_x',
      'Someone',
      'hello',
      new Date().toISOString(),
      false,
    );

    // Simulate the historical partial cascade: the chat row disappeared but
    // its messages survived (observed as 6 permanent violations in prod).
    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = OFF');
    raw.prepare('DELETE FROM chats WHERE jid = ?').run('feishu:doomed-chat');
    expect(raw.pragma('foreign_key_check') as unknown[]).not.toHaveLength(0);
    raw.close();

    // Restart: repair should delete the orphans and keep enforcement enabled.
    // initDatabase 无幂等守卫会重绑模块级连接，重启前先关旧连接，
    // 否则首根连接泄漏、afterAll 清理时 messages.db 仍被持有（EPERM）。
    closeDatabase();
    initDatabase();
    const probe = new Database(dbPath, { readonly: true });
    expect(
      probe
        .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE id = ?')
        .get('orphan-1'),
    ).toEqual({ cnt: 0 });
    expect(probe.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
    probe.close();
  });
});
