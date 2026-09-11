import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// 凭证自持加密存储：复用上游 runtime-config 的加密落盘模式（writeSecretFile
// 0o600 原子写 + AES-256-GCM）。上游密钥文件路径由 src/config.js 的 DATA_DIR
// 推导（module 级常量），沿用既有测试模式先 mock DATA_DIR 再 import。
// 明文不落盘是硬验收：磁盘文件里找不到凭证原值， ciphertext 为 AES-256-GCM。

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cred-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: tmp };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { QuotaCredentialStore } =
  await import('../src/quota-router/credentials.js');

const CRED_FILE = path.join(tmp, 'config', 'quota-router-credentials.json');

const store = () => new QuotaCredentialStore(CRED_FILE);

afterEach(() => {
  fs.rmSync(CRED_FILE, { force: true });
});

describe('quota credential store round-trips without plaintext on disk', () => {
  test('save then get returns the identical credential record', () => {
    const s = store();
    s.save('volcano-profile', {
      quotaToolProvider: 'volcano',
      credentials: {
        accessKeyId: 'AKLT-test-id',
        accessKeySecret: 'very-secret-sk-value',
        region: 'cn-beijing',
      },
    });
    expect(s.get('volcano-profile')).toEqual({
      quotaToolProvider: 'volcano',
      credentials: {
        accessKeyId: 'AKLT-test-id',
        accessKeySecret: 'very-secret-sk-value',
        region: 'cn-beijing',
      },
    });
  });

  test('ciphertext at rest: the file never contains credential values', () => {
    const secret = 'super-secret-opencode-cookie-auth-value';
    store().save('opencode-profile', {
      quotaToolProvider: 'opencode',
      credentials: { authCookie: secret },
    });

    const raw = fs.readFileSync(CRED_FILE, 'utf-8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('authCookie');
    // AES-256-GCM 三件套信封（base64 iv/tag/data），与上游 EncryptedSecrets 同构
    const parsed = JSON.parse(raw) as {
      version: number;
      entries: Record<string, { iv: string; tag: string; data: string }>;
    };
    expect(parsed.version).toBe(1);
    const envelope = parsed.entries['opencode-profile'];
    expect(Object.keys(envelope).sort()).toEqual(['data', 'iv', 'tag']);
    expect(envelope.iv).not.toContain(secret);
  });

  test('stores live in the data/config/ system of directories', () => {
    store().save('deepseek-profile', {
      quotaToolProvider: 'deepseek',
      credentials: { apiKey: 'sk-x' },
    });
    expect(path.dirname(CRED_FILE)).toBe(path.join(tmp, 'config'));
  });

  test('file mode follows the upstream 0o600 secret-file pattern', () => {
    store().save('p', {
      quotaToolProvider: 'zhipu',
      credentials: { token: 't' },
    });
    // Windows/POSIX 权限语义差异大（见 limitations 基线簇四）：仅断言文件存在
    // 且为原子写产物（无 .tmp 残留），mode 断言归 POSIX 环境。
    expect(fs.existsSync(`${CRED_FILE}.tmp`)).toBe(false);
  });
});

describe('multi-provider isolation and lifecycle', () => {
  test('each provider entry is independently encrypted; list() names them', () => {
    const s = store();
    s.save('a', {
      quotaToolProvider: 'volcano',
      credentials: { accessKeyId: 'a1' },
    });
    s.save('b', {
      quotaToolProvider: 'deepseek',
      credentials: { apiKey: 'k2' },
    });
    expect(s.list().sort()).toEqual(['a', 'b']);
  });

  test('save overwrites the previous record for the same provider', () => {
    const s = store();
    s.save('a', {
      quotaToolProvider: 'volcano',
      credentials: { accessKeyId: 'old' },
    });
    s.save('a', {
      quotaToolProvider: 'volcano',
      credentials: { accessKeyId: 'new' },
    });
    expect(s.get('a')?.credentials).toEqual({ accessKeyId: 'new' });
  });

  test('delete removes the entry; unknown provider returns null everywhere', () => {
    const s = store();
    s.save('a', { quotaToolProvider: 'volcano', credentials: {} });
    s.delete('a');
    expect(s.get('a')).toBeNull();
    expect(s.list()).toEqual([]);
    s.delete('never-existed'); // 无操作不抛错
  });

  test('entries persist across store instances (same file)', () => {
    store().save('durable', {
      quotaToolProvider: 'deepseek',
      credentials: { apiKey: 'sk-persist' },
    });
    expect(store().get('durable')).toEqual({
      quotaToolProvider: 'deepseek',
      credentials: { apiKey: 'sk-persist' },
    });
  });
});

describe('corruption is contained (fail-open, ADR-0004)', () => {
  test('a corrupted single entry reads as null; other entries stay intact', () => {
    const s = store();
    s.save('good', {
      quotaToolProvider: 'volcano',
      credentials: { accessKeyId: 'ok' },
    });
    s.save('bad', {
      quotaToolProvider: 'volcano',
      credentials: { accessKeyId: 'x' },
    });
    // 直接损坏 bad 条目的密文
    const raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8')) as {
      entries: Record<string, { data: string }>;
    };
    raw.entries['bad'].data = Buffer.from('tampered').toString('base64');
    fs.writeFileSync(CRED_FILE, JSON.stringify(raw));

    const reopened = store();
    expect(reopened.get('bad')).toBeNull();
    expect(reopened.get('good')).not.toBeNull();
  });

  test('an unreadable file is treated as an empty store instead of throwing', () => {
    fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
    fs.writeFileSync(CRED_FILE, '{ this is not json');
    const s = store();
    expect(s.get('anything')).toBeNull();
    expect(s.list()).toEqual([]);
    // 且仍可正常写入重建
    s.save('reborn', {
      quotaToolProvider: 'zhipu',
      credentials: { token: 't' },
    });
    expect(s.get('reborn')).not.toBeNull();
  });

  test('missing file reads as an empty store', () => {
    const s = store();
    expect(s.get('absent')).toBeNull();
    expect(s.list()).toEqual([]);
  });
});
