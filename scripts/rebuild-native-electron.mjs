/**
 * better-sqlite3 按 electron ABI 重编（T8 打包链 desktop:rebuild:electron）。
 *
 * 目标版本从根 package.json devDependencies.electron 动态读取（单一事实源，
 * 与 electron/electron-builder.yml 的 electronVersion 同源维护），避免脚本内
 * 硬编码随 electron 升级漂移。node-pty 为 NAPI 预编译无需处理。
 *
 * 用法：npm run desktop:rebuild:electron（等价于在 better-sqlite3 包目录跑
 * `prebuild-install -r electron -t <electron 版本>`；官方预编译下载失败时
 * 请先查代理，再考虑 MSVC 源码编译兜底）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const electronVersion = pkg.devDependencies?.electron;
if (!electronVersion) {
  console.error('devDependencies.electron 未配置，无法确定重编目标');
  process.exit(1);
}

const target = String(electronVersion).replace(/^v/, '');
const cwd = path.join(repoRoot, 'node_modules', 'better-sqlite3');
console.log(`prebuild-install -r electron -t ${target}（cwd=${cwd}）`);
execSync(`npx prebuild-install -r electron -t ${target}`, {
  cwd,
  stdio: 'inherit',
});
