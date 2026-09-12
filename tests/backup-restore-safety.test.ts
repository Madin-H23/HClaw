import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-safety-'));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to resolve test server port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// ─── Windows 适配（#10）─────────────────────────────────────────────────
// 上游测试辅助依赖 make/find/cp -a/mktemp/tar 这套 POSIX 工具链；Windows 上
// `make` 不在 PATH（spawn ENOENT），且 Git-Bash 的 GNU tar 会把 `C:\...` 形态
// 的 -f 操作数解析为远程主机（"Cannot connect to C: resolve failed"）。下面用
// Node 等价实现同一条备份管线（createTarGz / makeBackup / extractArchive），
// 并给 restore-backup.mjs 子进程注入把系统 bsdtar（System32）提到 PATH 首位的
// 环境，使脚本内部 spawnSync('tar') 在 Windows 解析到系统 tar 而非 Git-Bash
// GNU tar。测试意图与覆盖不变：备份仍逐条经过 sqlite-snapshot /
// prepare-backup-tree / backup-manifest 三个真实脚本，恢复仍走真实
// restore-backup.mjs（含全部校验/锁/暂存逻辑）。POSIX 平台行为一字不变。
const systemTar = path.join(
  process.env.SystemRoot ?? String.raw`C:\Windows`,
  'System32',
  'tar.exe',
);

function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base =
    process.platform === 'win32'
      ? {
          ...process.env,
          // Windows：System32 优先，`tar` 解析到系统 bsdtar（GNU tar 会把
          // 含盘符冒号的归档路径当远程主机）。POSIX：原样继承环境。
          PATH: `${path.dirname(systemTar)}${path.delimiter}${process.env.PATH ?? ''}`,
        }
      : { ...process.env };
  return { ...base, ...overrides };
}

function execRestore(
  args: readonly string[],
  envOverrides: NodeJS.ProcessEnv = {},
) {
  return execFileAsync('node', ['scripts/restore-backup.mjs', ...args], {
    cwd: root,
    env: childEnv(envOverrides),
  });
}

async function extractArchive(archive: string, dir: string): Promise<void> {
  // 测试自身的解包校验步骤：Windows 用系统 bsdtar 绝对路径（理由见上），
  // POSIX 沿用 PATH 里的系统 tar。
  await execFileAsync(process.platform === 'win32' ? systemTar : 'tar', [
    '-xzf',
    archive,
    '-C',
    dir,
  ]);
}

const BLOCK_SIZE = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE);

function writeTarHeader(options: {
  name: string;
  mode: number;
  typeflag: string;
  linkname?: string;
  size?: number;
}): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  const write = (offset: number, length: number, value: string) => {
    if (Buffer.byteLength(value, 'utf8') > length) {
      throw new Error(`tar header field overflow: ${value}`);
    }
    header.write(value, offset, length, 'utf8');
  };
  const octal = (value: number, digits: number) =>
    `${value.toString(8).padStart(digits, '0')}\0`;
  write(0, 100, options.name.slice(-100));
  write(100, 8, octal(options.mode, 7));
  write(108, 8, octal(0, 7)); // uid
  write(116, 8, octal(0, 7)); // gid
  write(124, 12, octal(options.size ?? 0, 11));
  write(136, 12, octal(0, 11)); // mtime
  write(156, 1, options.typeflag);
  write(157, 100, options.linkname ?? '');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  // 校验和按惯例先把 chksum 字段填空格再累计，最后写回 6 位八进制 + '\0 '。
  header.write('        ', 148, 8, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function appendPaxPathRecord(blocks: Buffer[], name: string): void {
  // POSIX pax 扩展头："len path=<name>\n"，len 覆盖整条记录（含自身位数）。
  const base = ` path=${name}\n`;
  let digits = 1;
  while (String(base.length + digits).length !== digits) digits += 1;
  const payload = Buffer.from(`${base.length + digits}${base}`, 'utf8');
  const padding = Buffer.alloc(
    (BLOCK_SIZE - (payload.length % BLOCK_SIZE)) % BLOCK_SIZE,
  );
  blocks.push(
    writeTarHeader({
      name: 'PaxHeaders/entry',
      mode: 0o644,
      typeflag: 'x',
      size: payload.length,
    }),
    payload,
    padding,
  );
}

function createTarGz(
  archivePath: string,
  rootDir: string,
  entryName: string,
): void {
  // 纯 Node ustar/pax 打包器，替代测试对系统 tar -czf 的直接调用。
  // 支持目录（typeflag 5）/普通文件（0）/符号链接（2，含 linkname）三类条目，
  // 路径超 ustar name(100) 容量时自动走 pax 扩展头（GNU tar 与 bsdtar 均可读）。
  const blocks: Buffer[] = [];
  const appendUstar = (
    name: string,
    mode: number,
    typeflag: string,
    linkname: string | undefined,
    content?: Buffer,
  ) => {
    if (Buffer.byteLength(name, 'utf8') > 100) {
      appendPaxPathRecord(blocks, name);
    }
    blocks.push(
      writeTarHeader({ name, mode, typeflag, linkname, size: content?.length }),
    );
    if (content) {
      blocks.push(content);
      const pad = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE;
      if (pad > 0) blocks.push(Buffer.alloc(pad));
    }
  };
  const walk = (dir: string, archiveDir: string) => {
    appendUstar(archiveDir, 0o755, '5', undefined);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      const archivePath = `${archiveDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        appendUstar(archivePath, 0o777, '2', fs.readlinkSync(candidate));
      } else if (entry.isDirectory()) {
        walk(candidate, archivePath);
      } else if (entry.isFile()) {
        appendUstar(
          archivePath,
          0o644,
          '0',
          undefined,
          fs.readFileSync(candidate),
        );
      } else {
        throw new Error(`Unsafe runtime special file: ${archivePath}`);
      }
    }
  };
  walk(path.join(rootDir, entryName), entryName);
  blocks.push(ZERO_BLOCK, ZERO_BLOCK);
  fs.writeFileSync(archivePath, zlib.gzipSync(Buffer.concat(blocks)));
}

const BACKUP_COMPONENTS = [
  'config',
  'groups',
  'sessions',
  'skills',
  'mcp-servers',
  'plugins',
  'memory',
  'avatars',
  'extra',
  'builtin-skills',
] as const;

function assertNoHardLinkedFiles(rootDir: string): void {
  // 对应 Makefile backup 的 `find -xdev -type f -links +1` 源头预检：硬链接
  // 文件会被 tar 存成 link-type 条目导致备份无法恢复，必须在复制前拒绝。
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && fs.statSync(candidate).nlink > 1) {
        throw new Error(`Runtime data contains hard-linked file: ${candidate}`);
      }
    }
  }
}

function copyArchiveTree(source: string, destination: string): void {
  // `cp -a` 等价：目录递归、普通文件拷贝、符号链接原样重建。
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyArchiveTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function assertNoUnsafeBackupEntries(rootDir: string): void {
  // 对应 Makefile 的 `find \( -type l -o !-type f !-type d \)` 双保险复查。
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error(`Unsafe backup entry: ${candidate}`);
      }
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
}

function pruneWorkspaceLogs(groupsDir: string): void {
  // 对应 find groups -mindepth 2 -maxdepth 2 -type d -name logs -prune -exec rm -rf。
  if (!fs.statSync(groupsDir, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const workspace of fs.readdirSync(groupsDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    fs.rmSync(path.join(groupsDir, workspace.name, 'logs'), {
      recursive: true,
      force: true,
    });
  }
}

let backupSequence = 0;

async function makeBackup(
  sourceData: string,
  backupDir: string,
): Promise<string> {
  // Makefile backup 目标的 Node 等价实现（步骤映射见上方 Windows 适配注释），
  // 返回 prepare-backup-tree 的 stdout（make 汇总输出的同一来源）。任何一步
  // 失败都会在创建 backupDir 之前抛出（与上游"拒绝即无产物"语义一致）。
  assertNoHardLinkedFiles(sourceData);
  const stagingRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-backup-'),
  );
  const stagedData = path.join(stagingRoot, 'data');
  const archive = path.join(
    backupDir,
    `miniclaw-backup-${Date.now()}-${(backupSequence += 1)}.tar.gz`,
  );
  const tmpFile = `${archive}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.join(stagedData, 'db'), { recursive: true });
    await execFileAsync(
      'node',
      [
        'scripts/sqlite-snapshot.mjs',
        path.join(sourceData, 'db', 'messages.db'),
        path.join(stagedData, 'db', 'messages.db'),
      ],
      { cwd: root },
    );
    for (const component of BACKUP_COMPONENTS) {
      if (
        fs
          .statSync(path.join(sourceData, component), {
            throwIfNoEntry: false,
          })
          ?.isDirectory()
      ) {
        fs.mkdirSync(path.join(stagedData, component), { recursive: true });
        copyArchiveTree(
          path.join(sourceData, component),
          path.join(stagedData, component),
        );
      }
    }
    const prepared = await execFileAsync(
      'node',
      ['scripts/prepare-backup-tree.mjs', stagedData],
      { cwd: root },
    );
    assertNoUnsafeBackupEntries(stagedData);
    pruneWorkspaceLogs(path.join(stagedData, 'groups'));
    await execFileAsync('node', ['scripts/backup-manifest.mjs', stagedData], {
      cwd: root,
    });
    fs.mkdirSync(backupDir, { recursive: true });
    createTarGz(tmpFile, stagingRoot, 'data');
    fs.renameSync(tmpFile, archive);
    fs.chmodSync(archive, 0o600);
    return prepared.stdout;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(tmpFile, { force: true });
  }
}
// ─── Windows 适配结束 ───────────────────────────────────────────────────

describe('runtime backup and restore safety', () => {
  test('omits generated session .claude links but preserves the surrounding session', async () => {
    const sourceData = path.join(tmp, 'generated-link-source-data');
    const backupDir = path.join(tmp, 'generated-link-backups');
    const extractDir = path.join(tmp, 'generated-link-extract');
    const dbDir = path.join(sourceData, 'db');
    const sessionRoot = path.join(
      sourceData,
      'sessions',
      'workspace-1',
      'agents',
      'agent-1',
    );
    const claudeDir = path.join(sessionRoot, '.claude');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, 'conversation.json'), '{}');
    fs.symlinkSync('/tmp', path.join(claudeDir, 'skills', 'host-skill'));

    const stdout = await makeBackup(sourceData, backupDir);
    expect(stdout).toContain('可在运行时重建');
    const archive = path.join(
      backupDir,
      fs.readdirSync(backupDir).find((name) => name.endsWith('.tar.gz'))!,
    );
    fs.mkdirSync(extractDir, { recursive: true });
    await extractArchive(archive, extractDir);
    expect(
      fs.readFileSync(
        path.join(
          extractDir,
          'data',
          'sessions',
          'workspace-1',
          'agents',
          'agent-1',
          'conversation.json',
        ),
        'utf8',
      ),
    ).toBe('{}');
    expect(
      fs.existsSync(
        path.join(
          extractDir,
          'data',
          'sessions',
          'workspace-1',
          'agents',
          'agent-1',
          '.claude',
          'skills',
          'host-skill',
        ),
      ),
    ).toBe(false);
  });

  test('refuses to create an unrestorable archive from runtime symlinks', async () => {
    const sourceData = path.join(tmp, 'symlink-source-data');
    const backupDir = path.join(tmp, 'symlink-backups');
    const dbDir = path.join(sourceData, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(sourceData, 'skills'), { recursive: true });
    fs.symlinkSync('/tmp', path.join(sourceData, 'skills', 'external'));

    await expect(makeBackup(sourceData, backupDir)).rejects.toThrow();
    expect(
      fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [],
    ).toHaveLength(0);
  });

  test('refuses to create an unrestorable archive from hard-linked runtime files', async () => {
    // A regular file with nlink > 1 is stored by tar as a link-type ('h')
    // entry pointing at its first-seen sibling instead of a full copy.
    // restore-backup.mjs's validateArchiveEntries rejects link-type entries
    // outright, so a hard link that makes it into a backup produces an
    // archive that reports "backup complete" but can never be restored.
    // Must be caught at backup time, not discovered during a real restore.
    const sourceData = path.join(tmp, 'hardlink-source-data');
    const backupDir = path.join(tmp, 'hardlink-backups');
    const dbDir = path.join(sourceData, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(sourceData, 'config'), { recursive: true });
    const original = path.join(sourceData, 'config', 'settings.json');
    fs.writeFileSync(original, '{}');
    fs.linkSync(original, path.join(sourceData, 'config', 'settings-2.json'));

    await expect(makeBackup(sourceData, backupDir)).rejects.toThrow();
    expect(
      fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [],
    ).toHaveLength(0);
  });

  test('rejects symbolic links and other special archive entries before extraction', async () => {
    const archiveRoot = path.join(tmp, 'malicious-archive');
    const archive = path.join(tmp, 'malicious-backup.tar.gz');
    const restoreData = path.join(tmp, 'malicious-restore');
    fs.mkdirSync(path.join(archiveRoot, 'data', 'db'), { recursive: true });
    fs.symlinkSync('/tmp', path.join(archiveRoot, 'data', 'sessions'));
    createTarGz(archive, archiveRoot, 'data');

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);

    await expect(
      execRestore(['restore', archive, restoreData, String(port)]),
    ).rejects.toThrow(/Unsafe backup archive entry type/);
    expect(fs.existsSync(restoreData)).toBe(false);
  });

  test('rejects forged symlink metadata that escapes restored data', async () => {
    const archiveRoot = path.join(tmp, 'malicious-metadata-archive');
    const archive = path.join(tmp, 'malicious-metadata-backup.tar.gz');
    const restoreData = path.join(tmp, 'malicious-metadata-restore');
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(archiveRoot, 'data', 'groups'), { recursive: true });
    fs.writeFileSync(
      path.join(archiveRoot, 'data', 'backup-symlinks.json'),
      JSON.stringify({
        formatVersion: 1,
        links: [{ path: 'groups/escape', target: '../../../tmp' }],
      }),
    );
    createTarGz(archive, archiveRoot, 'data');

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execRestore(['restore', archive, restoreData, String(port)]),
    ).rejects.toThrow(/escapes restored data/);
    expect(fs.existsSync(restoreData)).toBe(false);
  });

  test(
    'restores realistic archives whose validated file listing exceeds one MiB',
    async () => {
      const archiveRoot = path.join(tmp, 'large-listing-archive');
      const archive = path.join(tmp, 'large-listing-backup.tar.gz');
      const restoreData = path.join(tmp, 'large-listing-restore');
      const dbDir = path.join(archiveRoot, 'data', 'db');
      const groupsDir = path.join(archiveRoot, 'data', 'groups');
      fs.mkdirSync(dbDir, { recursive: true });
      fs.mkdirSync(groupsDir, { recursive: true });
      const db = new Database(path.join(dbDir, 'messages.db'));
      db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
      db.close();
      const suffix = 'x'.repeat(180);
      for (let index = 0; index < 5_000; index += 1) {
        fs.writeFileSync(path.join(groupsDir, `entry-${index}-${suffix}`), 'x');
      }
      createTarGz(archive, archiveRoot, 'data');

      const portProbe = net.createServer();
      const port = await listen(portProbe);
      await close(portProbe);
      await execRestore(['restore', archive, restoreData, String(port)]);
      expect(fs.readdirSync(path.join(restoreData, 'groups'))).toHaveLength(
        5_000,
      );
      // Windows 适配（#10）：纯 Node 打包比系统 tar 慢，且全量并行负载下 CPU
      // 争用明显——win32 把本用例超时放宽到 60s（实测单跑 ~6s，20s 预算在
      // 并行下偶发抖动超时，属 #17 型漫游）；POSIX 维持 20s 原值。
    },
    process.platform === 'win32' ? 60_000 : 20_000,
  );

  test('sweeps an orphaned staging directory left by a previously killed restore', async () => {
    // A `.miniclaw-restore-*` staging dir only survives past a restore
    // invocation if that invocation was killed hard enough to skip its own
    // `finally` cleanup (SIGKILL/OOM/host crash). It holds the pre-restore
    // rollback copy — i.e. real secrets/DB — and must not accumulate on
    // disk forever. Simulate that leak directly rather than reproducing a
    // real SIGKILL race, then confirm the next restore invocation sweeps it.
    const archiveRoot = path.join(tmp, 'orphan-sweep-archive');
    const archive = path.join(tmp, 'orphan-sweep-backup.tar.gz');
    const restoreData = path.join(tmp, 'orphan-sweep-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    createTarGz(archive, archiveRoot, 'data');

    fs.mkdirSync(restoreParent, { recursive: true });
    const orphan = fs.mkdtempSync(
      path.join(restoreParent, '.miniclaw-restore-'),
    );
    fs.mkdirSync(path.join(orphan, 'rollback', 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(orphan, 'rollback', 'db', 'messages.db'),
      'leaked pre-restore bytes from a killed run',
    );
    expect(fs.existsSync(orphan)).toBe(true);

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await execRestore(['restore', archive, restoreData, String(port)]);

    expect(fs.existsSync(orphan)).toBe(false);
    expect(
      fs
        .readdirSync(restoreParent)
        .filter((name) => name.startsWith('.miniclaw-restore-')),
    ).toHaveLength(0);
    expect(fs.existsSync(path.join(restoreData, 'db', 'messages.db'))).toBe(
      true,
    );
  });

  test('preserves an orphaned rollback directory when the new restore attempt itself fails validation', async () => {
    // A leaked `.miniclaw-restore-*` staging dir may hold the ONLY
    // surviving copy of good pre-restore data (e.g. a prior run killed
    // between moving the live component to rollback and moving the new one
    // into place). If a later restore attempt sweeps that orphan BEFORE
    // proving its own archive is valid, and that archive then fails
    // validation (corrupt DB here), the orphan's data is gone forever with
    // nothing successfully restored either — compounding data loss instead
    // of just leaving the earlier problem in place. The orphan must survive
    // a failed restore attempt.
    const archiveRoot = path.join(tmp, 'orphan-preserve-archive');
    const archive = path.join(tmp, 'orphan-preserve-backup.tar.gz');
    const restoreData = path.join(tmp, 'orphan-preserve-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    // Corrupt/invalid database content — validateDatabase's integrity_check
    // will fail on this, aborting the restore after extraction.
    fs.writeFileSync(path.join(dbDir, 'messages.db'), 'not a real sqlite db');
    createTarGz(archive, archiveRoot, 'data');

    fs.mkdirSync(restoreParent, { recursive: true });
    const orphan = fs.mkdtempSync(
      path.join(restoreParent, '.miniclaw-restore-'),
    );
    fs.mkdirSync(path.join(orphan, 'rollback', 'db'), { recursive: true });
    const survivingBytes = 'the only surviving copy of the old database';
    fs.writeFileSync(
      path.join(orphan, 'rollback', 'db', 'messages.db'),
      survivingBytes,
    );

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execRestore(['restore', archive, restoreData, String(port)]),
    ).rejects.toThrow();

    // The failed attempt's own stage dir is cleaned by its `finally`, but
    // the pre-existing orphan (and the only surviving data inside it) must
    // still be there — untouched by this failed attempt.
    expect(fs.existsSync(orphan)).toBe(true);
    expect(
      fs.readFileSync(
        path.join(orphan, 'rollback', 'db', 'messages.db'),
        'utf8',
      ),
    ).toBe(survivingBytes);
  });

  test("refuses to start a second restore while one is already in progress, so it cannot delete the other's in-flight staging dir", async () => {
    // cleanupOrphanedRestoreStagingDirs cannot tell "an abandoned staging
    // dir from a crashed run" apart from "another restore's staging/
    // rollback dir that is still in active use right now" — both just look
    // like a `.miniclaw-restore-*` directory that isn't this process's
    // own. Without serialization, whichever restore finishes first would
    // delete the other's in-flight rollback data. Simulate a live
    // in-progress restore by writing a lock file stamped with our own pid
    // (guaranteed alive for the duration of this test).
    const archiveRoot = path.join(tmp, 'lock-live-archive');
    const archive = path.join(tmp, 'lock-live-backup.tar.gz');
    const restoreData = path.join(tmp, 'lock-live-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    createTarGz(archive, archiveRoot, 'data');

    fs.mkdirSync(restoreParent, { recursive: true });
    fs.writeFileSync(
      path.join(restoreParent, '.miniclaw-restore.lock'),
      String(process.pid),
      { flag: 'wx' },
    );

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execRestore(['restore', archive, restoreData, String(port)]),
    ).rejects.toThrow(/already in progress/);
    expect(fs.existsSync(restoreData)).toBe(false);
    // The live lock (still our own pid) must not have been touched.
    expect(
      fs.readFileSync(
        path.join(restoreParent, '.miniclaw-restore.lock'),
        'utf8',
      ),
    ).toBe(String(process.pid));
  });

  test('releases the restore lock when staging directory creation fails', async () => {
    const archiveRoot = path.join(tmp, 'lock-mkdtemp-failure-archive');
    const archive = path.join(tmp, 'lock-mkdtemp-failure-backup.tar.gz');
    const restoreData = path.join(tmp, 'lock-mkdtemp-failure-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const lockPath = path.join(restoreParent, '.miniclaw-restore.lock');
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    createTarGz(archive, archiveRoot, 'data');

    // Inject a deterministic ENOSPC at the exact fs.mkdtempSync call used by
    // restore-backup.mjs. The lock write immediately before it still succeeds,
    // reproducing the early-failure window without relying on real disk
    // exhaustion or filesystem-specific path-length limits.
    const preload = path.join(tmp, 'fail-restore-mkdtemp.cjs');
    fs.writeFileSync(
      preload,
      String.raw`
const fs = require('node:fs');
const originalMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...args) {
  if (String(prefix).endsWith('.miniclaw-restore-')) {
    const error = new Error('simulated ENOSPC while creating restore staging directory');
    error.code = 'ENOSPC';
    throw error;
  }
  return originalMkdtempSync.call(this, prefix, ...args);
};
`,
    );

    fs.mkdirSync(restoreParent, { recursive: true });
    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execRestore(['restore', archive, restoreData, String(port)], {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`]
          .filter(Boolean)
          .join(' '),
      }),
    ).rejects.toThrow(/simulated ENOSPC/);

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(
      fs
        .readdirSync(restoreParent)
        .filter((name) => name.startsWith('.miniclaw-restore-')),
    ).toHaveLength(0);

    // A normal retry must proceed immediately rather than fail closed on a
    // stale lock left by the failed staging allocation.
    await execRestore(['restore', archive, restoreData, String(port)]);
    expect(fs.existsSync(path.join(restoreData, 'db', 'messages.db'))).toBe(
      true,
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('fails closed on a stale lock until an operator removes it', async () => {
    const archiveRoot = path.join(tmp, 'lock-stale-archive');
    const archive = path.join(tmp, 'lock-stale-backup.tar.gz');
    const restoreData = path.join(tmp, 'lock-stale-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    createTarGz(archive, archiveRoot, 'data');

    fs.mkdirSync(restoreParent, { recursive: true });
    // Spawn a short-lived process and wait for it to exit so its pid is
    // guaranteed dead, then stamp the lock with that now-unused pid —
    // simulating a restore that was killed without releasing its lock.
    const deadPid = await new Promise((resolve) => {
      const child = spawn('node', ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve(child.pid));
    });
    fs.writeFileSync(
      path.join(restoreParent, '.miniclaw-restore.lock'),
      String(deadPid),
      { flag: 'wx' },
    );

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execRestore(['restore', archive, restoreData, String(port)]),
    ).rejects.toThrow(/remove this lock manually/);

    expect(fs.existsSync(restoreData)).toBe(false);
    // The script must not rename or unlink a pathname that could have been
    // replaced by a newly acquired live lock after its liveness check.
    expect(
      fs.existsSync(path.join(restoreParent, '.miniclaw-restore.lock')),
    ).toBe(true);

    fs.rmSync(path.join(restoreParent, '.miniclaw-restore.lock'));
    await execRestore(['restore', archive, restoreData, String(port)]);
    expect(fs.existsSync(path.join(restoreData, 'db', 'messages.db'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(restoreParent, '.miniclaw-restore.lock')),
    ).toBe(false);
  });

  test('two restores observing the same stale lock both fail closed', async () => {
    const archiveRootA = path.join(tmp, 'lock-race-archive-a');
    const archiveRootB = path.join(tmp, 'lock-race-archive-b');
    const archiveA = path.join(tmp, 'lock-race-backup-a.tar.gz');
    const archiveB = path.join(tmp, 'lock-race-backup-b.tar.gz');
    const restoreData = path.join(tmp, 'lock-race-restore', 'data');
    const restoreParent = path.dirname(restoreData);

    for (const [archiveRoot, archive, marker] of [
      [archiveRootA, archiveA, 'A'],
      [archiveRootB, archiveB, 'B'],
    ] as const) {
      const dbDir = path.join(archiveRoot, 'data', 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      const db = new Database(path.join(dbDir, 'messages.db'));
      db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, marker TEXT)');
      db.prepare('INSERT INTO sample (marker) VALUES (?)').run(marker);
      db.close();
      createTarGz(archive, archiveRoot, 'data');
    }

    fs.mkdirSync(restoreParent, { recursive: true });
    const deadPid = await new Promise<number>((resolve) => {
      const child = spawn('node', ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve(child.pid as number));
    });
    fs.writeFileSync(
      path.join(restoreParent, '.miniclaw-restore.lock'),
      String(deadPid),
      { flag: 'wx' },
    );

    const portProbeA = net.createServer();
    const portA = await listen(portProbeA);
    await close(portProbeA);
    const portProbeB = net.createServer();
    const portB = await listen(portProbeB);
    await close(portProbeB);

    const runA = execRestore(['restore', archiveA, restoreData, String(portA)]);
    const runB = execRestore(['restore', archiveB, restoreData, String(portB)]);

    const [resultA, resultB] = await Promise.allSettled([runA, runB]);
    const fulfilled = [resultA, resultB].filter(
      (r) => r.status === 'fulfilled',
    );
    const rejected = [resultA, resultB].filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(0);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect(String(result.reason)).toMatch(/remove this lock manually/);
    }

    expect(fs.existsSync(restoreData)).toBe(false);
    // Neither contender may mutate the stale pathname or enter staging.
    expect(
      fs.existsSync(path.join(restoreParent, '.miniclaw-restore.lock')),
    ).toBe(true);
    const leftoverStaging = fs
      .readdirSync(restoreParent)
      .filter((name) => name.startsWith('.miniclaw-restore-'));
    expect(leftoverStaging).toHaveLength(0);
  });

  test('includes committed WAL rows and refuses restore while the service port is active', async () => {
    const sourceData = path.join(tmp, 'source-data');
    const backupDir = path.join(tmp, 'backups');
    const restoreData = path.join(tmp, 'restored-data');
    const dbDir = path.join(sourceData, 'db');
    const dbPath = path.join(dbDir, 'messages.db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(path.join(sourceData, 'config'), { recursive: true });
    const sessionSecretPath = path.join(
      sourceData,
      'config',
      'session-secret.key',
    );
    fs.writeFileSync(sessionSecretPath, 'test-only-secret', { mode: 0o644 });
    const persistentMarkers = [
      ['mcp-servers', 'user-1', 'servers.json'],
      ['plugins', 'users', 'user-1.json'],
      ['memory', 'workspace-1', 'memory.md'],
      ['avatars', 'agent-1.txt'],
      ['builtin-skills', 'catalog.json'],
    ];
    for (const parts of persistentMarkers) {
      const markerPath = path.join(sourceData, ...parts);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, `marker:${parts.join('/')}`);
    }
    const workspaceRoot = path.join(sourceData, 'groups', 'workspace-1');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'CLAUDE.md'), 'workspace rules');
    fs.symlinkSync('CLAUDE.md', path.join(workspaceRoot, 'AGENTS.md'));
    fs.symlinkSync('/tmp', path.join(workspaceRoot, 'external-cache'));

    const writer = new Database(dbPath);
    try {
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec(
        'CREATE TABLE audit_rows (id INTEGER PRIMARY KEY, value TEXT)',
      );
      writer.prepare('INSERT INTO audit_rows(value) VALUES (?)').run('main');
      writer.pragma('wal_checkpoint(TRUNCATE)');
      writer.prepare('INSERT INTO audit_rows(value) VALUES (?)').run('wal');

      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      const detachedMain = path.join(tmp, 'detached-main.db');
      fs.copyFileSync(dbPath, detachedMain);
      const detached = new Database(detachedMain, { readonly: true });
      expect(
        (
          detached
            .prepare('SELECT COUNT(*) AS count FROM audit_rows')
            .get() as {
            count: number;
          }
        ).count,
      ).toBe(1);
      detached.close();

      await makeBackup(sourceData, backupDir);
      const archives = fs
        .readdirSync(backupDir)
        .filter((name) => name.endsWith('.tar.gz'));
      expect(archives).toHaveLength(1);
      const archive = path.join(backupDir, archives[0]);

      const activeServer = net.createServer();
      const port = await listen(activeServer);
      try {
        // make restore 的端口守卫本体在 restore-backup.mjs（assertPortFree，
        // restore 入口同样先于一切文件系统改动复查）。make 在 Windows 不可用，
        // 这里直接调脚本并断言其拒绝消息（覆盖不减反增）。
        await expect(
          execRestore(['restore', archive, restoreData, String(port)]),
        ).rejects.toThrow(/Refusing to restore while a service is listening/);
        expect(fs.existsSync(path.join(restoreData, 'db', 'messages.db'))).toBe(
          false,
        );
      } finally {
        await close(activeServer);
      }

      const staleExtra = path.join(restoreData, 'extra', 'stale.txt');
      fs.mkdirSync(path.dirname(staleExtra), { recursive: true });
      fs.writeFileSync(staleExtra, 'must be removed by authoritative restore');
      await execRestore(['restore', archive, restoreData, String(port)]);

      const restoredDbPath = path.join(restoreData, 'db', 'messages.db');
      // Windows/NTFS：restore-backup.mjs 的 chmodSync(0o600) 不落地 POSIX 权限
      // 位，statSync().mode 实际返回 0o666（#13 同簇平台差异）。win32 下退为
      // 行为级断言（密钥文件内容可读且已落盘）；POSIX 维持 0o600 原断言。
      if (process.platform === 'win32') {
        expect(
          fs.readFileSync(
            path.join(restoreData, 'config', 'session-secret.key'),
            'utf8',
          ),
        ).toBe('test-only-secret');
      } else {
        expect(
          fs.statSync(path.join(restoreData, 'config', 'session-secret.key'))
            .mode & 0o777,
        ).toBe(0o600);
      }
      for (const parts of persistentMarkers) {
        expect(fs.readFileSync(path.join(restoreData, ...parts), 'utf8')).toBe(
          `marker:${parts.join('/')}`,
        );
      }
      const restoredWorkspaceLink = path.join(
        restoreData,
        'groups',
        'workspace-1',
        'AGENTS.md',
      );
      expect(fs.lstatSync(restoredWorkspaceLink).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(restoredWorkspaceLink)).toBe('CLAUDE.md');
      expect(fs.readFileSync(restoredWorkspaceLink, 'utf8')).toBe(
        'workspace rules',
      );
      expect(
        fs.existsSync(
          path.join(restoreData, 'groups', 'workspace-1', 'external-cache'),
        ),
      ).toBe(false);
      expect(fs.existsSync(path.join(restoreData, 'extra'))).toBe(false);
      expect(fs.existsSync(`${restoredDbPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${restoredDbPath}-shm`)).toBe(false);
      const restored = new Database(restoredDbPath, { readonly: true });
      expect(
        (
          restored
            .prepare('SELECT COUNT(*) AS count FROM audit_rows')
            .get() as { count: number }
        ).count,
      ).toBe(2);
      restored.close();
    } finally {
      writer.close();
    }
  }, 20_000);
});
