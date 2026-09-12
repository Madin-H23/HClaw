import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  findClaudeMdExcludeLeaks,
  resolveManagedHostClaudeMdExcludes,
} from '../container/agent-runner/src/claude-memory-policy.js';

// Windows 适配（#12）：被测模块的输出契约是「可移植正斜杠 picomatch 模式」
// （claude-memory-policy.ts 的 toClaudePattern 把分隔符统一为 /，见本文件
// 'emits portable picomatch patterns for Windows host paths' 用例）。期望值
// 改用 path.posix.join 构造：POSIX 上与原 path.join 逐字符一致，Windows 上
// 与模块真实输出（win32 join 后 portable 化）形态匹配。
const portableJoin = (...segments: string[]): string =>
  path.posix.join(...segments);

describe('managed host Claude memory policy', () => {
  test('excludes OS-home and configured host instructions in managed mode', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: { context: { source: 'managed' } },
        homeDir: '/Users/operator',
        externalClaudeDir: '/Volumes/config/claude',
        projectRoot: '/Users/operator/airepo/miniclaw',
      }),
    ).toEqual([
      portableJoin('/Users/operator/.claude', 'CLAUDE.md'),
      portableJoin('/Users/operator/.claude', 'rules', '**'),
      portableJoin('/Volumes/config/claude', 'CLAUDE.md'),
      portableJoin('/Volumes/config/claude', 'rules', '**'),
      portableJoin('/Users/operator/airepo/miniclaw', 'CLAUDE.md'),
      portableJoin('/Users/operator/airepo/miniclaw', '.claude', 'CLAUDE.md'),
      portableJoin('/Users/operator/airepo/miniclaw', 'CLAUDE.local.md'),
      portableJoin('/Users/operator/airepo/miniclaw', '.claude', 'rules', '**'),
    ]);
  });

  test('keeps workspace-local memory while excluding only platform project memory', () => {
    const groupWorkspace =
      '/Users/operator/airepo/miniclaw/data/groups/address-agent';
    const excludes = resolveManagedHostClaudeMdExcludes({
      executionMode: 'host',
      runtimePolicy: { context: { source: 'managed' } },
      homeDir: '/Users/operator',
      projectRoot: '/Users/operator/airepo/miniclaw',
    });

    expect(excludes).not.toContain(portableJoin(groupWorkspace, 'CLAUDE.md'));
    expect(excludes).toContain(
      portableJoin('/Users/operator/airepo/miniclaw', 'CLAUDE.md'),
    );
  });

  test('treats a missing legacy context source as managed and deduplicates roots', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: {},
        homeDir: '/Users/operator',
        externalClaudeDir: '/Users/operator/.claude',
      }),
    ).toEqual([
      portableJoin('/Users/operator/.claude', 'CLAUDE.md'),
      portableJoin('/Users/operator/.claude', 'rules', '**'),
    ]);
  });

  test('preserves explicitly enabled host context and ignores container runs', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: { context: { source: 'host_claude' } },
        homeDir: '/Users/operator',
      }),
    ).toEqual([]);
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'container',
        runtimePolicy: { context: { source: 'managed' } },
        homeDir: '/home/node',
      }),
    ).toEqual([]);
  });

  test('detects an SDK memory file that escaped the applied exclusions', () => {
    expect(
      findClaudeMdExcludeLeaks(
        [
          { path: '/repo/CLAUDE.md' },
          { path: '/repo/.claude/rules/runtime.md' },
          { path: '/repo/data/groups/address/CLAUDE.md' },
        ],
        ['/repo/CLAUDE.md', path.join('/repo/.claude/rules', '**')],
      ),
    ).toEqual([
      // Windows 适配（#12）：findClaudeMdExcludeLeaks 回显的是 portable 化后的
      // 输入路径（不做平台 normalize）。POSIX 上 path.normalize 为恒等变换，
      // 原断言与之等价；Windows 上 path.normalize 会改写成反斜杠形态而偏离
      // 模块的 portable 契约，故期望值直接用与输入一致的字符串。
      '/repo/CLAUDE.md',
      '/repo/.claude/rules/runtime.md',
    ]);
  });

  test('emits portable picomatch patterns for Windows host paths', () => {
    const excludes = resolveManagedHostClaudeMdExcludes({
      executionMode: 'host',
      runtimePolicy: { context: { source: 'managed' } },
      homeDir: 'C:\\Users\\operator',
      externalClaudeDir: 'D:\\Claude',
      projectRoot: 'C:\\code\\miniclaw',
    });

    expect(excludes).toContain('C:/Users/operator/.claude/CLAUDE.md');
    expect(excludes).toContain('D:/Claude/rules/**');
    expect(excludes).toContain('C:/code/miniclaw/.claude/rules/**');
    expect(excludes.every((entry) => !entry.includes('\\'))).toBe(true);
    expect(
      findClaudeMdExcludeLeaks(
        [{ path: 'C:\\code\\miniclaw\\.claude\\rules\\agent.md' }],
        excludes,
      ),
    ).toEqual(['C:/code/miniclaw/.claude/rules/agent.md']);
  });
});
