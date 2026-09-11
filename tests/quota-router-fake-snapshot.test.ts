import { describe, expect, test } from 'vitest';

import {
  isMissingSnapshot,
  makeMissingSnapshot,
  makeQuotaSnapshot,
  QUOTA_TIERS,
  QUOTA_TIER_LABELS,
  snapshotAgeMs,
  TIER_SAMPLE_USED_PERCENTAGE,
  TIER_SAMPLE_USD_BALANCE,
  type FakeQuotaSnapshot,
} from './quota-router-stubs/fake-snapshot.js';

// 假快照生成器自检：四档 × 三类异构信号全覆盖且数值确定性，
// 数据时间新旧与缺失源意图可表达，输出对象深冻结防测试间串改。

const NOW = Date.parse('2026-09-11T08:00:00.000Z');

describe('fake quota snapshot generator covers the four tiers deterministically', () => {
  test('tier samples pin the canonical used-percentage scale', () => {
    expect(QUOTA_TIERS).toEqual(['plenty', 'tight', 'critical', 'exhausted']);
    expect(TIER_SAMPLE_USED_PERCENTAGE).toEqual({
      plenty: 10,
      tight: 75,
      critical: 96,
      exhausted: 100,
    });
  });

  test('the Chinese tier labels match the CONTEXT.md unified scale', () => {
    expect(QUOTA_TIER_LABELS).toEqual({
      plenty: '充足',
      tight: '紧张',
      critical: '临界',
      exhausted: '耗尽',
    });
  });

  test('every tier yields contract-shaped snapshots for every signal kind', () => {
    for (const tier of QUOTA_TIERS) {
      for (const signal of ['absolute', 'percentage', 'currency'] as const) {
        const snapshot = makeQuotaSnapshot('p1', { tier, signal, now: NOW });
        expect(snapshot.providerId).toBe('p1');
        expect(snapshot.tier).toBe(tier);
        expect(snapshot.signalKind).toBe(signal);
        expect(Number.isNaN(Date.parse(snapshot.fetchedAt))).toBe(false);
        expect(Array.isArray(snapshot.windows)).toBe(true);
        expect(Array.isArray(snapshot.summary)).toBe(true);
        for (const window of snapshot.windows) {
          // 七字段固定契约
          expect(Object.keys(window).sort()).toEqual([
            'label',
            'percentage',
            'remaining',
            'resetAt',
            'total',
            'unit',
            'used',
          ]);
        }
      }
    }
  });
});

describe('heterogeneous signal kinds mirror the real provider window shapes', () => {
  test('absolute signal mirrors the volcano AFP window (remaining = total - used)', () => {
    const snapshot = makeQuotaSnapshot('glm', { tier: 'tight', now: NOW });
    expect(snapshot.signalKind).toBe('absolute');
    expect(snapshot.windows).toHaveLength(1);
    const window = snapshot.windows[0];
    expect(window).toEqual({
      label: '5h Rolling',
      total: 500_000,
      used: 375_000,
      remaining: 125_000,
      percentage: 75,
      resetAt: '2026-09-11T13:00:00Z',
      unit: 'AFP',
    });
  });

  test('percentage signal mirrors the opencode window (total pinned at 100, unit %)', () => {
    const snapshot = makeQuotaSnapshot('opencode', {
      tier: 'critical',
      signal: 'percentage',
      now: NOW,
    });
    expect(snapshot.windows).toEqual([
      {
        label: '5h Rolling',
        total: 100,
        used: 96,
        remaining: 4,
        percentage: 96,
        resetAt: '2026-09-11T13:00:00Z',
        unit: '%',
      },
    ]);
  });

  test('exhausted leaves nothing remaining on both numeric signal kinds', () => {
    for (const signal of ['absolute', 'percentage'] as const) {
      const snapshot = makeQuotaSnapshot('p', {
        tier: 'exhausted',
        signal,
        now: NOW,
      });
      expect(snapshot.windows[0].remaining).toBe(0);
      expect(snapshot.windows[0].percentage).toBe(100);
    }
  });

  test('currency signal mirrors the deepseek balance-only shape (empty windows)', () => {
    const snapshot = makeQuotaSnapshot('deepseek', {
      tier: 'tight',
      signal: 'currency',
      now: NOW,
    });
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.summary).toEqual([{ label: 'USD 总余额', value: 15 }]);
    expect(TIER_SAMPLE_USD_BALANCE).toEqual({
      plenty: 100,
      tight: 15,
      critical: 3,
      exhausted: 0,
    });
    const exhausted = makeQuotaSnapshot('deepseek', {
      tier: 'exhausted',
      signal: 'currency',
      now: NOW,
    });
    expect(exhausted.summary).toEqual([{ label: 'USD 总余额', value: 0 }]);
  });
});

describe('data freshness and missing-source intents are expressible', () => {
  test('fresh snapshots stamp fetchedAt at the injected clock', () => {
    const snapshot = makeQuotaSnapshot('p', { tier: 'plenty', now: NOW });
    expect(snapshot.fetchedAt).toBe('2026-09-11T08:00:00Z');
    expect(snapshotAgeMs(snapshot, NOW)).toBe(0);
  });

  test('ageMs produces stale snapshots whose data time is measurably old', () => {
    const oneHour = 60 * 60 * 1000;
    const snapshot = makeQuotaSnapshot('p', {
      tier: 'plenty',
      ageMs: oneHour,
      now: NOW,
    });
    expect(snapshot.fetchedAt).toBe('2026-09-11T07:00:00Z');
    expect(snapshotAgeMs(snapshot, NOW)).toBe(oneHour);
    expect(snapshotAgeMs(snapshot, NOW + oneHour)).toBe(oneHour * 2);
  });

  test('missing source yields a fail-open marker without window data', () => {
    const missing = makeMissingSnapshot('p');
    expect(missing).toEqual({ providerId: 'p', missing: true });
    expect(isMissingSnapshot(missing)).toBe(true);
    expect('windows' in missing).toBe(false);

    const present = makeQuotaSnapshot('p', { tier: 'plenty', now: NOW });
    expect(isMissingSnapshot(present)).toBe(false);
  });
});

describe('generated snapshots are deeply frozen', () => {
  test('mutation attempts leave the snapshot untouched', () => {
    const snapshot: FakeQuotaSnapshot = makeQuotaSnapshot('p', {
      tier: 'critical',
      now: NOW,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.windows)).toBe(true);
    expect(Object.isFrozen(snapshot.windows[0])).toBe(true);
    expect(Object.isFrozen(snapshot.summary[0])).toBe(true);
  });
});
