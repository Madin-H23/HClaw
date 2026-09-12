# AGENTS.md

HClaw — [helsome/miniclaw](https://github.com/helsome/miniclaw)（MIT，上游已 404，基线=本地副本 3ff1c8d）的深度二开：自托管多渠道 Agent 工作台，额度感知路由（Pi Runtime，TypeScript）。
当前主战场：**额度感知路由 MVP**（SPEC #1，tracer-bullet tickets #2-#9，native blocking）。

## Agent skills

### Issue tracker

Issues 存放在 GitHub Issues（`gh` CLI 操作）。See `docs/agents/issue-tracker.md`。
⚠️ 本仓库双 remote（upstream=上游 / origin=自己的仓），**所有 gh 命令显式 `-R Madin-H23/HClaw`**。

### Triage labels

四个 canonical triage roles 映射到同名字符串 label（needs-triage / needs-info / ready-for-agent / ready-for-human）。See `docs/agents/triage-labels.md`。

### Domain docs

Single-context：repo 根 `CONTEXT.md`（纯词汇表，术语权威源）+ `docs/adr/0001-0007`。See `docs/agents/domain.md`。

## 必读

- `CONTEXT.md` — 词汇表：**供应商**（模型端点）与**渠道**（IM 通道）是两个词，别混；「额度」裸用禁，必须带前缀（供应商额度/用户余额）
- 上游语义零改动红线：上游数据库 schema、`MINICLAW_*` env 前缀、数据目录、会话 cookie、MCP 工具前缀**一律不动**；巨石主文件（主入口/数据库）不添加逻辑；原创逻辑只长新模块，缝级 wiring 保持最小并以 no-op 行为不变的测试证明（ADR-0003/0005/0006，注入点清单见 SPEC #1）
- 分支纪律：`main` 仅稳定态；一切改造在 `develop`；每票走 `feature/<topic>`，`--no-ff` 合回 develop
- 验证链模板：typecheck → 单测 → build → E2E → lint（format:check + lint:types）→ 上游基线对比；基线数见 `docs/limitations.md`（T1 落盘）
- 渲染面交付三重审查：双轴 code review + OCR（规则入库 `.opencodereview/rule.json`，T1 起）+ judge 视觉验收
- 提交描述一律中文；每票关票评论附验收证据（issues 即工作日志）

## 三层门禁

| 层           | 命令                                      | 管什么                              | 口径                                                                                           |
| ------------ | ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| 格式         | `npm run format:check`                    | prettier 排版/行尾（整文件）        | 增量：`FORMAT_BASE_REF`（缺省 origin/develop）分叉的改动文件                                   |
| 类型         | `npm run typecheck` / `desktop:typecheck` | tsc 类型正确性                      | 全 project：root tsconfig=src/**，electron/tsconfig.json=electron/src/**                       |
| 规约         | `npm run lint:types`                      | ESLint typescript-eslint 最小规则集 | 增量：`LINT_BASE_REF`（缺省 origin/develop）分叉的改动文件，warning 即败（`--max-warnings=0`） |
| 规约（快扫） | `npm run lint:oxlint`                     | oxlint 默认 correct 档全仓          | informational：不 gate，存量基线见 `docs/limitations.md`，error 级诊断才失败                   |

- 规则集最小起步，不开全量 recommended（防存量喷发）；加规则须先说清「抓什么、HClaw 为什么需要」。现行 6 条（配置 `eslint.config.mjs`）：
  - `@typescript-eslint/no-floating-promises` — 抓「无人在等」的 Promise：IM 投递/SQLite/调度等异步面的抛错逃逸（B3/B4 人工抓过的 resolver 抛错）正是此类目。
  - `@typescript-eslint/no-misused-promises` — 抓 async 函数被放进期望同步 void 回调的位置（事件回调、forEach、条件表达式）：错位会吞错误或产生幽灵行为。
  - `@typescript-eslint/await-thenable` — 抓 await 非 thenable（方法名拼错、多余 await）：只有类型感知才有此信号。
  - `@typescript-eslint/no-unnecessary-type-assertion` — 抓无产出的类型断言：断言是绕过类型系统的手工豁免，多余断言掩盖类型漂移。
  - `no-async-promise-executor` — 抓 Promise executor 内 async：其抛出不会 reject 外层 Promise，回调转 Promise 的包装处（IPC/SDK 适配）是真实坑。
  - `no-promise-executor-return` — 抓 executor 意外 return 非空值：会提前 resolve，包装逻辑半途而废。
- 豁免纪律：预期不 await 的 fire-and-forget 行必须显式标注——`void expr;`（类型面）或 `// eslint-disable-next-line <rule> -- 理由`；豁免是有意识的标注不是逃逸，陈旧豁免（规则已不再触发）会被 reportUnusedDisableDirectives + `--max-warnings=0` 挂闸。
- 覆盖边界：类型感知规则只作用于真实 tsconfig project 内的文件（src/**、electron/src/**，projectService 就近挂靠既有 tsconfig）；tests/、scripts/ 的 TS 不在任何 tsconfig（vitest/tsc 转译即用），只吃非类型规则；web/、container/ 是独立 npm 包，不在根包门禁范围。
