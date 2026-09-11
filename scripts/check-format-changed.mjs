import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const write = process.argv.includes('--write');
const supportedExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mjs',
  '.scss',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

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
let base = process.env.FORMAT_BASE_REF?.trim();
if (base && !git(['rev-parse', '--verify', `${base}^{commit}`], true)) {
  base = undefined;
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
  .filter((file) => supportedExtensions.has(path.extname(file).toLowerCase()))
  .filter((file) => fs.existsSync(path.join(root, file)))
  .sort();

if (candidates.length === 0) {
  console.log('No changed files require Prettier checks.');
  process.exit(0);
}

// Spawn prettier via node directly: the .bin sh shim cannot be spawned on
// Windows (spawnSync EINVAL for .cmd since Node's CVE-2024-27980 hardening),
// and going through a shell would re-interpret candidate paths.
const prettierBin = path.join(
  root,
  'node_modules',
  'prettier',
  'bin',
  'prettier.cjs',
);
const result = spawnSync(
  process.execPath,
  [prettierBin, write ? '--write' : '--check', ...candidates],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
