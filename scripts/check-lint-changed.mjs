import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// ESLint incremental gate (#27): lint only TS/JS files that diverged from the
// base ref (same acquisition model as scripts/check-format-changed.mjs with
// FORMAT_BASE_REF, but keyed on LINT_BASE_REF). Existing violations in
// untouched files are out of scope by design.
const root = path.resolve(import.meta.dirname, '..');
const lintedExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs']);
// Root-package gate only; web/ and container/ are separate npm packages with
// their own toolchains (same scope as eslint.config.mjs ignores).
const excludedPrefixes = ['web/', 'container/'];

function git(args, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'inherit'],
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function addLines(target, value) {
  for (const line of value.split('\n')) {
    if (line) target.add(line);
  }
}

const files = new Set();
let base = process.env.LINT_BASE_REF?.trim();
if (base && !git(['rev-parse', '--verify', `${base}^{commit}`], true)) {
  base = undefined;
}
// 本仓库纪律：一切改造在 develop——缺省回退链首选 origin/develop。
if (!base && git(['rev-parse', '--verify', 'origin/develop^{commit}'], true)) {
  base = 'origin/develop';
}
if (!base && git(['rev-parse', '--verify', 'origin/main^{commit}'], true)) {
  base = 'origin/main';
}
if (!base && git(['rev-parse', '--verify', 'HEAD^'], true)) base = 'HEAD^';

if (base) {
  const mergeBase = git(['merge-base', base, 'HEAD'], true) || base;
  addLines(
    files,
    git(['diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}...HEAD`]),
  );
}
addLines(files, git(['diff', '--name-only', '--diff-filter=ACMR']));
addLines(files, git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
addLines(files, git(['ls-files', '--others', '--exclude-standard']));

const candidates = [...files]
  .filter((file) => lintedExtensions.has(path.extname(file).toLowerCase()))
  .filter((file) => !excludedPrefixes.some((prefix) => file.startsWith(prefix)))
  .filter((file) => fs.existsSync(path.join(root, file)))
  .sort();

if (candidates.length === 0) {
  console.log('No changed files require ESLint checks.');
  process.exit(0);
}

console.log(
  `ESLint incremental gate: ${candidates.length} file(s) vs base ${base ?? 'worktree'}`,
);

// Spawn eslint via node directly: the .bin sh shim cannot be spawned on
// Windows (spawnSync EINVAL for .cmd since Node's CVE-2024-27980 hardening),
// same handling as scripts/check-format-changed.mjs. --max-warnings=0 makes
// the gate fail on warnings; --no-warn-ignored tolerates ignored paths in the
// changed-file list.
const eslintBin = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const result = spawnSync(
  process.execPath,
  [eslintBin, '--no-warn-ignored', '--max-warnings=0', ...candidates],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
