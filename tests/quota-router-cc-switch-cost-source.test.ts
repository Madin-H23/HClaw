import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import Database from '../src/sqlite-compat.js';
import {
  CcSwitchCostSource,
  defaultCcSwitchDbPath,
  isMissingProviderSpentCost,
  type ProviderSpentCost,
} from '../src/quota-router/cc-switch-cost-source.js';

// CC Switch 成本源（T4）：只读对接 cc-switch.db（ADR-0003 三源只读、绝不写入）。
// fixture 副本 schema 与真实库逐列一致（2026-09-11 只读探查实证，数据脱敏）；
// 零写入用两层实证：文件内容/mtime 不变 + OS 只读文件上仍可查询（若以读写
// 通道打开，CANTOPEN 会直接失败）。

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const tmpDirs: string[] = [];

function makeFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-switch-fix-'));
  tmpDirs.push(dir);
  return dir;
}

/** 与真实库逐列一致的 fixture 建表（脱敏数据，值格式同真实 TEXT 十进制串） */
function buildFixtureDb(dbPath: string): void {
  const db = new Database(dbPath) as {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown };
    close(): void;
  };
  try {
    db.exec(`
      CREATE TABLE model_pricing (
        model_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        input_cost_per_million TEXT NOT NULL,
        output_cost_per_million TEXT NOT NULL,
        cache_read_cost_per_million TEXT NOT NULL,
        cache_creation_cost_per_million TEXT NOT NULL
      );
      CREATE TABLE usage_daily_rollups (
        date TEXT NOT NULL,
        app_type TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        request_model TEXT NOT NULL,
        pricing_model TEXT NOT NULL,
        request_count INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        total_cost_usd TEXT NOT NULL,
        avg_latency_ms INTEGER NOT NULL,
        input_token_semantics INTEGER NOT NULL,
        PRIMARY KEY (date, app_type, provider_id, model, request_model, pricing_model)
      );
    `);
    const price = db.prepare(
      `INSERT INTO model_pricing VALUES (?, ?, ?, ?, ?, ?)`,
    );
    price.run('test-model-a', 'Test Model A', '5', '25', '0.50', '6.25');
    price.run('test-model-b', 'Test Model B', '2', '8', '0.20', '2');
    price.run('broken-model', 'Broken Price', 'abc', '25', '0.50', '6.25');
    // 脏数据形态（P2-1）：空串会被 Number('')===0 误判成"免费"，科学计数法
    // 非 CC Switch 真实十进制串域——两者都必须折 missing
    price.run('empty-model', 'Empty Price', '', '25', '0.50', '6.25');
    price.run('sci-model', 'Sci Notation', '1e3', '25', '0.50', '6.25');

    const rollup = db.prepare(
      `INSERT INTO usage_daily_rollups
       (date, app_type, provider_id, model, request_model, pricing_model,
        request_count, success_count, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, total_cost_usd,
        avg_latency_ms, input_token_semantics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 供应商 vendor-uuid-1：三天的用量（成本为 TEXT 十进制串，同真实库）
    rollup.run(
      '2026-09-02',
      'claude',
      'vendor-uuid-1',
      'test-model-a',
      'test-model-a',
      'test-model-a',
      2,
      2,
      1000,
      2000,
      0,
      0,
      '0.10',
      500,
      0,
    );
    rollup.run(
      '2026-09-05',
      'claude',
      'vendor-uuid-1',
      'test-model-a',
      'test-model-a',
      'test-model-a',
      3,
      3,
      1500,
      2500,
      0,
      0,
      '0.20',
      600,
      0,
    );
    rollup.run(
      '2026-09-10',
      'claude',
      'vendor-uuid-1',
      'test-model-b',
      'test-model-b',
      'test-model-b',
      4,
      4,
      2000,
      3000,
      0,
      0,
      '0.30',
      700,
      0,
    );
    // 真实库存在的伪供应商前缀：不在 providers 表，聚合照常成立
    rollup.run(
      '2026-09-08',
      'claude',
      '_session:abc',
      'test-model-a',
      'test-model-a',
      'test-model-a',
      1,
      1,
      100,
      100,
      0,
      0,
      '0.01',
      100,
      0,
    );
  } finally {
    db.close();
  }
}

function fileFingerprint(dbPath: string): { sha256: string; mtimeMs: number } {
  return {
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(dbPath))
      .digest('hex'),
    mtimeMs: fs.statSync(dbPath).mtimeMs,
  };
}

// 固定时钟：窗口计算的确定性（now = 2026-09-11 UTC）
const FIXED_NOW_MS = Date.parse('2026-09-11T00:00:00Z');

let fixtureDir: string;
let dbPath: string;

beforeEach(() => {
  fixtureDir = makeFixtureDir();
  dbPath = path.join(fixtureDir, 'cc-switch.db');
  buildFixtureDb(dbPath);
});

afterEach(async () => {
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

describe('cc-switch cost source reads model pricing (read-only)', () => {
  test('returns parsed per-million USD prices on exact model_id match', () => {
    const source = new CcSwitchCostSource({ dbPath, busyTimeoutMs: 100 });
    try {
      expect(source.getModelPrice('test-model-a')).toEqual({
        modelId: 'test-model-a',
        displayName: 'Test Model A',
        inputCostPerMillion: 5,
        outputCostPerMillion: 25,
        cacheReadCostPerMillion: 0.5,
        cacheCreationCostPerMillion: 6.25,
      });
      expect(source.lastFailure()).toBeNull();
    } finally {
      source.close();
    }
  });

  test('unknown model → missing mark (no exception)', () => {
    const source = new CcSwitchCostSource({ dbPath, busyTimeoutMs: 100 });
    try {
      expect(source.getModelPrice('no-such-model')).toEqual({
        modelId: 'no-such-model',
        missing: true,
      });
    } finally {
      source.close();
    }
  });

  test('unparseable price string → missing + unexpected failure (no throw)', () => {
    const source = new CcSwitchCostSource({ dbPath, busyTimeoutMs: 100 });
    try {
      expect(source.getModelPrice('broken-model')).toEqual({
        modelId: 'broken-model',
        missing: true,
      });
      expect(source.lastFailure()?.kind).toBe('unexpected');
    } finally {
      source.close();
    }
  });

  test('empty or non-decimal price strings ("", "1e3") → missing, never misjudged as free', () => {
    const source = new CcSwitchCostSource({ dbPath, busyTimeoutMs: 100 });
    try {
      expect(source.getModelPrice('empty-model')).toEqual({
        modelId: 'empty-model',
        missing: true,
      });
      expect(source.getModelPrice('sci-model')).toEqual({
        modelId: 'sci-model',
        missing: true,
      });
      expect(source.lastFailure()?.kind).toBe('unexpected');
    } finally {
      source.close();
    }
  });
});

describe('cc-switch cost source aggregates provider spent cost', () => {
  test('full-history aggregation over TEXT cost strings', () => {
    const source = new CcSwitchCostSource({
      dbPath,
      busyTimeoutMs: 100,
      nowMs: () => FIXED_NOW_MS,
    });
    try {
      const cost = source.getProviderSpentCost('vendor-uuid-1');
      expect(isMissingProviderSpentCost(cost)).toBe(false);
      // SUM(CAST) 浮点累加精度随 SQLite 版本浮动（≥3.44 才有 Kahan 求和）：
      // 金额用近似断言，不绑定求和实现
      expect((cost as ProviderSpentCost).totalCostUsd).toBeCloseTo(0.6, 10);
      expect(cost).toMatchObject({
        providerId: 'vendor-uuid-1',
        requestCount: 9,
        firstDate: '2026-09-02',
        lastDate: '2026-09-10',
        windowDays: null,
      });
    } finally {
      source.close();
    }
  });

  test('windowDays limits aggregation to the recent window', () => {
    const source = new CcSwitchCostSource({
      dbPath,
      busyTimeoutMs: 100,
      nowMs: () => FIXED_NOW_MS,
    });
    try {
      const cost = source.getProviderSpentCost('vendor-uuid-1', {
        windowDays: 7,
      });
      expect(isMissingProviderSpentCost(cost)).toBe(false);
      expect((cost as ProviderSpentCost).totalCostUsd).toBeCloseTo(0.5, 10);
      expect(cost).toMatchObject({
        providerId: 'vendor-uuid-1',
        requestCount: 7, // 09-05 + 09-10（09-02 落在窗口外）
        firstDate: '2026-09-05',
        lastDate: '2026-09-10',
        windowDays: 7,
      });
    } finally {
      source.close();
    }
  });

  test('pseudo-provider ids (not in providers table) aggregate fine', () => {
    const source = new CcSwitchCostSource({ dbPath, busyTimeoutMs: 100 });
    try {
      const cost = source.getProviderSpentCost('_session:abc');
      expect(cost).toEqual({
        providerId: '_session:abc',
        totalCostUsd: 0.01,
        requestCount: 1,
        firstDate: '2026-09-08',
        lastDate: '2026-09-08',
        windowDays: null,
      });
    } finally {
      source.close();
    }
  });

  test('provider without any usage rows → missing mark', () => {
    const source = new CcSwitchCostSource({ dbPath, busyTimeoutMs: 100 });
    try {
      expect(source.getProviderSpentCost('vendor-nobody')).toEqual({
        providerId: 'vendor-nobody',
        missing: true,
      });
    } finally {
      source.close();
    }
  });
});

describe('cc-switch cost source degrades explicitly, never throws', () => {
  test('missing db file → file-missing failure + missing marks', () => {
    const source = new CcSwitchCostSource({
      dbPath: path.join(fixtureDir, 'absent.db'),
      busyTimeoutMs: 10,
    });
    try {
      expect(source.getModelPrice('test-model-a')).toEqual({
        modelId: 'test-model-a',
        missing: true,
      });
      expect(source.lastFailure()?.kind).toBe('file-missing');
    } finally {
      source.close();
    }
  });

  test('db without required tables → schema-missing failure', () => {
    const barePath = path.join(fixtureDir, 'bare.db');
    const bare = new Database(barePath) as { close(): void };
    bare.close();
    const source = new CcSwitchCostSource({
      dbPath: barePath,
      busyTimeoutMs: 10,
    });
    try {
      expect(source.getModelPrice('test-model-a')).toEqual({
        modelId: 'test-model-a',
        missing: true,
      });
      expect(source.lastFailure()?.kind).toBe('schema-missing');
    } finally {
      source.close();
    }
  });

  test('lock conflict (exclusive writer) → locked failure; recovers after release', () => {
    const holder = new Database(dbPath as string) as {
      exec(sql: string): void;
      close(): void;
    };
    const source = new CcSwitchCostSource({ dbPath, busyTimeoutMs: 10 });
    try {
      holder.exec('BEGIN EXCLUSIVE');
      try {
        expect(source.getModelPrice('test-model-a')).toEqual({
          modelId: 'test-model-a',
          missing: true,
        });
        expect(source.lastFailure()?.kind).toBe('locked');
      } finally {
        holder.exec('COMMIT');
        holder.close();
      }
      // 锁释放后自动重开恢复（降级不永久化）
      const recovered = source.getModelPrice('test-model-a');
      expect(isMissingPrice(recovered)).toBe(false);
      expect(recovered).toMatchObject({ displayName: 'Test Model A' });
      expect(source.lastFailure()).toBeNull();
    } finally {
      source.close();
    }
  });
});

describe('cc-switch cost source zero-write evidence', () => {
  test('fixture bytes and mtime unchanged across every query path', () => {
    const before = fileFingerprint(dbPath);
    const source = new CcSwitchCostSource({
      dbPath,
      busyTimeoutMs: 100,
      nowMs: () => FIXED_NOW_MS,
    });
    try {
      source.getModelPrice('test-model-a'); // 命中
      source.getModelPrice('no-such-model'); // 未命中
      source.getModelPrice('broken-model'); // 解析失败
      source.getProviderSpentCost('vendor-uuid-1'); // 全历史聚合
      source.getProviderSpentCost('vendor-uuid-1', { windowDays: 7 }); // 窗口聚合
      source.getProviderSpentCost('vendor-nobody'); // 无记录
    } finally {
      source.close();
    }
    expect(fileFingerprint(dbPath)).toEqual(before);
  });

  test('still queries successfully on an OS read-only file (readonly-open behavior proof)', () => {
    fs.chmodSync(dbPath, 0o444); // Windows: FILE_ATTRIBUTE_READONLY
    const source = new CcSwitchCostSource({ dbPath, busyTimeoutMs: 100 });
    try {
      // 若适配器走读写通道（SQLITE_OPEN_READWRITE），此处会 CANTOPEN 失败
      const price = source.getModelPrice('test-model-a');
      expect(price).toMatchObject({ modelId: 'test-model-a' });
      expect(isMissingPrice(price)).toBe(false);
      expect(source.getProviderSpentCost('vendor-uuid-1')).toMatchObject({
        providerId: 'vendor-uuid-1',
      });
      expect(source.lastFailure()).toBeNull();
    } finally {
      source.close();
      fs.chmodSync(dbPath, 0o666); // 还原权限，保证临时目录可清理
    }
  });
});

describe('default path', () => {
  test('defaults to ~/.cc-switch/cc-switch.db', () => {
    expect(defaultCcSwitchDbPath().replace(/\\/g, '/')).toBe(
      `${os.homedir().replace(/\\/g, '/')}/.cc-switch/cc-switch.db`,
    );
  });
});

function isMissingPrice(
  price: ReturnType<CcSwitchCostSource['getModelPrice']>,
): boolean {
  return (price as { missing?: boolean }).missing === true;
}
