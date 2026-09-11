import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { StoredQuotaSnapshot } from '../src/quota-router/snapshot-store.js';

// 独立快照库（ADR-0006）：quota-router 独占 data/db/quota-router.db，自己的
// 建表/迁移（PRAGMA user_version），与上游 messages.db 零关联。读写接口干净，
// 供后续票的决策层消费。better-sqlite3 为仓库既有依赖，零新增。

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const tmpDirs: string[] = [];

function makeDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-snap-'));
  tmpDirs.push(dir);
  return path.join(dir, 'db', 'quota-router.db');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function snapshot(
  overrides?: Partial<StoredQuotaSnapshot>,
): StoredQuotaSnapshot {
  return {
    providerId: 'volcano-profile',
    tier: 'tight',
    signalKind: 'absolute',
    score: 25,
    fetchedAt: '2026-09-11T08:00:00Z',
    storedAt: '2026-09-11T08:00:01Z',
    windows: [
      {
        label: '5h Rolling',
        total: 500_000,
        used: 375_000,
        remaining: 125_000,
        percentage: 75,
        resetAt: '2026-09-11T13:00:00Z',
        unit: 'AFP',
      },
    ],
    summary: [{ label: '套餐', value: 'Agent Plan' }],
    ...overrides,
  };
}

describe('quota snapshot store owns its independent SQLite file', () => {
  test('creates data/db/quota-router.db on demand (nested dir included)', async () => {
    const { QuotaSnapshotStore } =
      await import('../src/quota-router/snapshot-store.js');
    const dbPath = makeDbPath();
    const store = new QuotaSnapshotStore(dbPath);
    store.close();
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(path.basename(dbPath)).toBe('quota-router.db');
  });

  test('upsert then get round-trips every snapshot field', async () => {
    const { QuotaSnapshotStore } =
      await import('../src/quota-router/snapshot-store.js');
    const store = new QuotaSnapshotStore(makeDbPath());
    try {
      store.upsert(snapshot());
      expect(store.get('volcano-profile')).toEqual(snapshot());
    } finally {
      store.close();
    }
  });

  test('same provider upsert overwrites (latest snapshot wins)', async () => {
    const { QuotaSnapshotStore } =
      await import('../src/quota-router/snapshot-store.js');
    const store = new QuotaSnapshotStore(makeDbPath());
    try {
      store.upsert(snapshot({ tier: 'plenty', score: 90 }));
      store.upsert(
        snapshot({
          tier: 'critical',
          score: 4,
          fetchedAt: '2026-09-11T09:00:00Z',
        }),
      );
      const row = store.get('volcano-profile');
      expect(row?.tier).toBe('critical');
      expect(row?.fetchedAt).toBe('2026-09-11T09:00:00Z');
    } finally {
      store.close();
    }
  });

  test('snapshots survive close/reopen (the whole point of a snapshot library)', async () => {
    const { QuotaSnapshotStore } =
      await import('../src/quota-router/snapshot-store.js');
    const dbPath = makeDbPath();
    const first = new QuotaSnapshotStore(dbPath);
    first.upsert(
      snapshot({
        providerId: 'deepseek-profile',
        signalKind: 'currency',
        tier: 'critical',
        score: 3,
        windows: [],
      }),
    );
    first.close();

    const second = new QuotaSnapshotStore(dbPath);
    try {
      const row = second.get('deepseek-profile');
      expect(row).toEqual(
        snapshot({
          providerId: 'deepseek-profile',
          signalKind: 'currency',
          tier: 'critical',
          score: 3,
          windows: [],
        }),
      );
    } finally {
      second.close();
    }
  });

  test('all() returns every provider ordered by id for panel/decision consumption', async () => {
    const { QuotaSnapshotStore } =
      await import('../src/quota-router/snapshot-store.js');
    const store = new QuotaSnapshotStore(makeDbPath());
    try {
      store.upsert(snapshot({ providerId: 'b' }));
      store.upsert(snapshot({ providerId: 'a' }));
      store.upsert(snapshot({ providerId: 'c' }));
      expect(store.all().map((s) => s.providerId)).toEqual(['a', 'b', 'c']);
    } finally {
      store.close();
    }
  });

  test('get on unknown provider returns null (missing is constructed by callers)', async () => {
    const { QuotaSnapshotStore } =
      await import('../src/quota-router/snapshot-store.js');
    const store = new QuotaSnapshotStore(makeDbPath());
    try {
      expect(store.get('nobody')).toBeNull();
    } finally {
      store.close();
    }
  });

  test('migration is idempotent: reopening runs user_version guard, data intact', async () => {
    const { QuotaSnapshotStore } =
      await import('../src/quota-router/snapshot-store.js');
    const dbPath = makeDbPath();
    const first = new QuotaSnapshotStore(dbPath);
    first.upsert(snapshot());
    first.close();
    const second = new QuotaSnapshotStore(dbPath);
    try {
      expect(second.get('volcano-profile')).not.toBeNull();
    } finally {
      second.close();
    }
  });

  test('independent file boundary: the db lives next to (not inside) upstream files', async () => {
    const { QuotaSnapshotStore } =
      await import('../src/quota-router/snapshot-store.js');
    const dbPath = makeDbPath();
    const store = new QuotaSnapshotStore(dbPath);
    store.close();
    // 目录里只有 quota-router.db 系（含 WAL 副产物），不触碰任何上游 messages.db
    const files = fs.readdirSync(path.dirname(dbPath));
    expect(files).toContain('quota-router.db');
    expect(files.some((f) => f.includes('messages'))).toBe(false);
  });
});
