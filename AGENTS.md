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
- 上游语义零改动红线：上游 `src/`、数据库 schema、`MINICLAW_*` env 前缀、数据目录、会话 cookie、MCP 工具前缀**一律不动**；原创能力只长新模块（ADR-0003/0005/0006）
- 分支纪律：`main` 仅稳定态；一切改造在 `develop`；每票走 `feature/<topic>`，`--no-ff` 合回 develop
- 验证链模板：typecheck → 单测 → build → E2E → lint → 上游基线对比；基线数见 `docs/limitations.md`（T1 落盘）
- 渲染面交付三重审查：双轴 code review + OCR（规则入库 `.opencodereview/rule.json`，T1 起）+ judge 视觉验收
- 提交描述一律中文；每票关票评论附验收证据（issues 即工作日志）
