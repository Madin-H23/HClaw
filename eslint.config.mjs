// HClaw 规约层（#27）：ESLint 增量门禁配置。
// 设计约束见 AGENTS.md「三层门禁」节：
// - 只开最小规则集，每条在 AGENTS.md 有「抓什么/为什么」；不开全量 recommended，防存量喷发。
// - 类型感知规则只作用于已在真实 tsconfig project 内的文件（src/**、electron/src/**）；
//   tests/、scripts/ 的 TS 文件不在任何 tsconfig（vitest/tsc 均转译即用），只吃非类型规则。
// - 豁免必须行级显式标注并写理由：`// eslint-disable-next-line <rule> -- 理由`；
//   失效豁免由 reportUnusedDisableDirectives（flat config 默认 warn）+ --max-warnings=0 挂闸。
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // 根门禁只管根包源码；web/、container/ 是独立 npm 包（自带 tsconfig 与工具链），不入本闸。
    ignores: [
      'dist/**',
      'coverage/**',
      'electron/dist/**',
      'electron/release/**',
      'web/**',
      'container/**',
    ],
  },
  {
    // 类型感知块：projectService 就近挂 root tsconfig.json（src/**）与
    // electron/tsconfig.json（electron/src/**），不需要额外 project 文件。
    files: ['src/**/*.ts', 'electron/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
    },
  },
  {
    // 非类型块：tests/、scripts/ 与根级 .ts/.mjs（vitest.config.ts 等）——只吃与
    // Promise 执行模型相关的正确性规则（无需类型信息，转译即用文件也可判）。
    files: [
      'tests/**/*.ts',
      'tests/**/*.tsx',
      'scripts/**/*.ts',
      'scripts/**/*.mjs',
      '*.ts',
      '*.mjs',
    ],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
    },
  },
);
