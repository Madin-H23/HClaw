import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import Database from '../src/sqlite-compat.js';
import {
  BillingBalanceSource,
  isMissingUserBalance,
  type BillingBalanceReader,
} from '../src/quota-router/billing-balance-source.js';

// 上游 billing 余额源（T4）：只读消费上游既有导出（db.ts 的 getUserBalance
// 形状），用户余额语义原样——不重组字段、不判断余额、不新建任何闸门（上游
// 既有 fail-closed 余额闸原样保留）。fixture 用临时 SQLite 建上游建表语句的
// 所需子集（user_balances，逐列对齐 src/db.ts），零网络零真凭据。

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const tmpDirs: string[] = [];
/** reader 持有的 fixture 连接登记表：afterEach 统一关闭，杜绝句柄泄漏 */
const readerClosers: Array<() => void> = [];

function makeFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-fix-'));
  tmpDirs.push(dir);
  return dir;
}

/** 上游 user_balances 建表语句的所需子集（逐列对齐 src/db.ts 原文） */
function buildFixtureDb(dbPath: string): void {
  const db = new Database(dbPath) as {
    prepare(sql: string): { run(...args: unknown[]): unknown };
    close(): void;
  };
  try {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS user_balances (
        user_id TEXT PRIMARY KEY,
        balance_usd REAL NOT NULL DEFAULT 0,
        total_deposited_usd REAL NOT NULL DEFAULT 0,
        total_consumed_usd REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
    ).run();
    // 最小 users 桩：为满足 user_balances 外键引用（better-sqlite3 连接启用
    // FK 约束）；列取上游主键原文，余额行配对插入上游同款用户
    db.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)').run();
    db.prepare('INSERT INTO users (id) VALUES (?)').run('user-alice');
    db.prepare('INSERT INTO users (id) VALUES (?)').run('user-bob');
    const insert = db.prepare(
      `INSERT INTO user_balances
       (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('user-alice', 12.5, 20, 7.5, '2026-09-11T00:00:00Z');
    // 负余额：上游语义允许透传的形态（适配器不做任何拦截判定）
    insert.run('user-bob', -1.25, 5, 6.25, '2026-09-10T00:00:00Z');
  } finally {
    db.close();
  }
}

/** 裸读实现：对 fixture 库做上游同款 SELECT（查无行返回 null，不 auto-init） */
function makeRawReader(dbPath: string): BillingBalanceReader {
  const db = new Database(dbPath) as {
    prepare(sql: string): { get(...args: unknown[]): unknown };
    close(): void;
  };
  readerClosers.push(() => db.close());
  return (userId: string) => {
    const row = db
      .prepare('SELECT * FROM user_balances WHERE user_id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      user_id: String(row.user_id),
      balance_usd: Number(row.balance_usd) || 0,
      total_deposited_usd: Number(row.total_deposited_usd) || 0,
      total_consumed_usd: Number(row.total_consumed_usd) || 0,
      updated_at: String(row.updated_at),
    };
  };
}

let fixtureDir: string;
let dbPath: string;

beforeEach(() => {
  fixtureDir = makeFixtureDir();
  dbPath = path.join(fixtureDir, 'messages.db');
  buildFixtureDb(dbPath);
});

afterEach(async () => {
  for (const close of readerClosers.splice(0)) close();
  await removeTmpDirs();
});

/** Windows 临时目录删除存在偶发 EPERM（见 docs/limitations.md 抖动簇）：短重试 */
async function removeTmpDirs(): Promise<void> {
  for (const dir of tmpDirs.splice(0)) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (lastErr && fs.existsSync(dir)) throw lastErr;
  }
}

describe('upstream billing balance source passes through upstream semantics', () => {
  test('hit → upstream UserBalance shape untouched (snake_case fields as-is)', () => {
    const source = new BillingBalanceSource({
      readBalance: makeRawReader(dbPath),
    });
    expect(source.getUserBalance('user-alice')).toEqual({
      user_id: 'user-alice',
      balance_usd: 12.5,
      total_deposited_usd: 20,
      total_consumed_usd: 7.5,
      updated_at: '2026-09-11T00:00:00Z',
    });
    expect(source.lastFailure()).toBeNull();
  });

  test('no gate here: negative balance passes through unjudged', () => {
    const source = new BillingBalanceSource({
      readBalance: makeRawReader(dbPath),
    });
    const balance = source.getUserBalance('user-bob');
    expect(isMissingUserBalance(balance)).toBe(false);
    expect(balance).toMatchObject({ balance_usd: -1.25 });
  });

  test('empty table (reader returns null) → missing mark', () => {
    const source = new BillingBalanceSource({
      readBalance: makeRawReader(dbPath),
    });
    const balance = source.getUserBalance('user-nobody');
    expect(balance).toEqual({ userId: 'user-nobody', missing: true });
    expect(isMissingUserBalance(balance)).toBe(true);
  });

  test('upstream uninitialized (reader throws) → missing + reader-error, never throws', () => {
    // 上游未初始化时 db.ts 的读取函数在 undefined 连接上 .prepare 抛 TypeError
    const uninitialized: BillingBalanceReader = () => {
      const db = undefined as unknown as {
        prepare(sql: string): { get(...args: unknown[]): unknown };
      };
      return db.prepare('SELECT * FROM user_balances') as never;
    };
    const source = new BillingBalanceSource({ readBalance: uninitialized });
    const balance = source.getUserBalance('user-alice');
    expect(balance).toEqual({ userId: 'user-alice', missing: true });
    expect(source.lastFailure()?.kind).toBe('reader-error');
  });

  test('production wiring shape: reader may be the upstream exported function itself', () => {
    // db.ts 导出的 getUserBalance 永不返回 null（auto-init 零行语义）——
    // 装配侧可直接传该函数；此处以同签名桩证明类型与透传行为
    const upstreamLike: BillingBalanceReader = (userId) => ({
      user_id: userId,
      balance_usd: 0,
      total_deposited_usd: 0,
      total_consumed_usd: 0,
      updated_at: '2026-09-11T00:00:00Z',
    });
    const source = new BillingBalanceSource({ readBalance: upstreamLike });
    expect(source.getUserBalance('brand-new-user')).toEqual({
      user_id: 'brand-new-user',
      balance_usd: 0,
      total_deposited_usd: 0,
      total_consumed_usd: 0,
      updated_at: '2026-09-11T00:00:00Z',
    });
  });
});
