/**
 * T7-C：quota-router 配置 adminOverride 旋钮解析（票 #8 配置面补口）
 *
 * 语义（config.ts 文档注释）：true = 放行被额度否决的绑定（降档目标存在时仍
 * 降档优先）并记告警 + 发「额度放行」卡片；缺省/非法值一律 false（不放行）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_QUOTA_ROUTER_CONFIG,
  QuotaRouterConfigLoader,
} from '../src/quota-router/config.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(raw: unknown): QuotaRouterConfigLoader {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cfg-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'quota-router.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return new QuotaRouterConfigLoader(file);
}

describe('adminOverride 旋钮解析', () => {
  test('文件不存在 → 缺省 false（不放行）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cfg-'));
    tmpDirs.push(dir);
    const loader = new QuotaRouterConfigLoader(path.join(dir, 'absent.json'));
    expect(loader.get().adminOverride).toBe(false);
  });

  test('显式 true → true；显式 false → false', () => {
    expect(writeConfig({ adminOverride: true }).get().adminOverride).toBe(true);
    expect(writeConfig({ adminOverride: false }).get().adminOverride).toBe(
      false,
    );
  });

  test('缺省字段 / 非法值 → false（宽松解析不炸选路）', () => {
    expect(writeConfig({}).get().adminOverride).toBe(false);
    expect(writeConfig({ adminOverride: 'yes' }).get().adminOverride).toBe(
      false,
    );
    expect(writeConfig({ adminOverride: 1 }).get().adminOverride).toBe(false);
  });

  test('缺省常量 adminOverride = false（未配置文件时的全局缺省）', () => {
    expect(DEFAULT_QUOTA_ROUTER_CONFIG.adminOverride).toBe(false);
  });

  test('热生效：改文件后 get() 读到新值', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cfg-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'quota-router.json');
    fs.writeFileSync(file, JSON.stringify({ adminOverride: false }));
    const loader = new QuotaRouterConfigLoader(file);
    expect(loader.get().adminOverride).toBe(false);
    // mtime 精度：显式 bumped mtime 保证重读（Windows mtime 粒度粗）
    fs.writeFileSync(file, JSON.stringify({ adminOverride: true }));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);
    expect(loader.get().adminOverride).toBe(true);
  });
});
