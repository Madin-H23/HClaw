# Issue tracker: GitHub

这个 repo 的 issues 和 specs 存放在 GitHub issues 中。所有操作都使用 `gh` CLI。
**⚠️ 双 remote 险情：仓库同时有 upstream（helsome/miniclaw，已 404）与 origin（Madin-H23/HClaw），所有 gh 命令必须显式 `-R Madin-H23/HClaw`，否则可能解析到上游。**

## Conventions

- **Create an issue**: `gh issue create -R Madin-H23/HClaw --title "..." --body "..."`。多行 body 使用 heredoc 或 body 文件。
- **Read an issue**: `gh issue view <number> -R Madin-H23/HClaw --comments`，用 `jq` 过滤 comments，并同时获取 labels。
- **List issues**: `gh issue list -R Madin-H23/HClaw --state open --json number,title,body,labels --jq '[.[] | {number, title, body, labels: [.labels[].name]}]'`，按需加 `--label` / `--state`。
- **Comment on an issue**: `gh issue comment <number> -R Madin-H23/HClaw --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R Madin-H23/HClaw --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R Madin-H23/HClaw --comment "..."`
- **网络**：gh 走 `HTTPS_PROXY=http://127.0.0.1:3067`（Karing）；瞬时 `unexpected EOF` 重试即可。

## Pull requests as a triage surface

**PRs as a request surface: no.**（个人项目，不收 external PRs。）

## When a skill says "publish to the issue tracker"

创建一个 GitHub issue（`-R Madin-H23/HClaw`）。

## When a skill says "fetch the relevant ticket"

运行 `gh issue view <number> -R Madin-H23/HClaw --comments`。

## Blocking（tracer-bullet tickets）

- **Native issue dependencies** 为 canonical：`gh api --method POST repos/Madin-H23/HClaw/issues/<n>/dependencies/blocked_by -F issue_id=<blocker-db-id>`（dbId 用 `gh api repos/Madin-H23/HClaw/issues/<n> --jq .id` 取，**不是** #number）。
- 核验：`gh api repos/Madin-H23/HClaw/issues/<n>/dependencies/blocked_by --jq 'map(.number)'`。
- Current edges：#4←#2,#3 · #5←#2 · #6←#4,#5 · #7←#6 · #8←#7 · #9←#8（#2 与 #3 为起点）。
