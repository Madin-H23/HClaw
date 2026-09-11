# 已知局限（Limitations）

> 本文档随票滚动维护；T1（#2）落盘首节基线与首批取舍。

## 上游测试 Windows 基线（T1 实测）

- **日期**：2026-09-11
- **环境**：Windows 11 x64（10.0.26200）/ Node v24.19.0 / vitest 4.1.1 / git `core.autocrlf=true`（CRLF 工作区）/ 依赖完整（根 + web + container/agent-runner）
- **命令**：`npx vitest run --reporter=dot`（仓库根，单次运行）
- **基线数**：测试文件 334 = 297 通过 / 37 失败；**用例 2876 = 2796 通过 / 57 失败 / 23 跳过**；耗时约 49s
- 57 个失败归并为 7 簇，均为上游固有/环境固有用例，已按簇单立 `needs-triage` 票（#10–#16）；本基线是后续所有票「上游基线对比」的对照点。

### 失败用例全量清单（按簇）

**簇一：Unix 工具链依赖（make / tar），11 例 — #10**（tests/backup-restore-safety.test.ts）

1. omits generated session .claude links but preserves the surrounding session
2. rejects symbolic links and other special archive entries before extraction
3. rejects forged symlink metadata that escapes restored data
4. restores realistic archives whose validated file listing exceeds one MiB
5. sweeps an orphaned staging directory left by a previously killed restore
6. preserves an orphaned rollback directory when the new restore attempt itself fails validation
7. refuses to start a second restore while one is already in progress, so it cannot delete the other's in-flight staging dir
8. releases the restore lock when staging directory creation fails
9. fails closed on a stale lock until an operator removes it
10. two restores observing the same stale lock both fail closed
11. includes committed WAL rows and refuses restore while the service port is active

**簇二：autocrlf CRLF 检出 vs 源码文本契约断言，14 例 — #11**

1. provider connector initial failure safety contract QQ does not start background reconnect before manager acceptance（channel-connector-failure-safety）
2. Feishu route safety integration bootstraps an unregistered P2P chat before the route check…（feishu-route-safety）
3. graceful shutdown lifecycle order stops intake and agents, terminalizes cards, then disconnects IM（graceful-shutdown-order）
4. Makefile runtime contract uses the same native process model…（makefile-runtime-contract）
5. buildCommandIndex — YAML frontmatter parsing parses well-formed frontmatter…（plugin-command-index）
6. provider fallback source contracts a synthetic assistant provider error cannot park the SDK stream（provider-model-fallback-contract）
7. reproducible build contract generated StreamEvent copies stay synchronized and formatted（reproducible-build-contract）
   8–10. resolveTurnOutcome does not mark or commit a final reply until the physical channel ACKs it / routes streaming-card local images through the exact turn outbox… / returns a negative MCP image acknowledgement…（turn-outcome ×3）
   11–13. warm channel outbox scope wiring contract：bindChannelOutboxScope takes an explicit correlation id… / both warm admissions bind the scope with the IPC deliveryId / cold turns keep relying on the runtime default（warm-channel-outbox-scope-correlation ×3）
8. dynamic Workflow product contract keeps running Workflow state across a held background acknowledgement（workflow-card-contract）

**簇三：POSIX 绝对路径断言，14 例 — #12**
1–4. managed host Claude memory policy：excludes OS-home and configured host instructions… / keeps workspace-local memory… / treats a missing legacy context source… / detects an SDK memory file that escaped the applied exclusions（claude-memory-policy ×4）
5–9. node-resolver：buildNodeCandidates NVM_BIN / FNM_MULTISHELL_PATH / VOLTA_HOME are joined with node / resolveBinaryOnPath returns first executable match in PATH order / resolveBinaryOnPath skips empty segments without crashing / resolveNodeBinary does not choose Bun-like execPath or argv0… / resolveNodeBinary falls back to NVM_BIN/node…（node-resolver ×5）
10–12. plugin-expander-routing-bugs：P2-bug-4 customCwd honored in host mode（customCwd → cwd / no customCwd → fallback）+ P2-bug-3 sibling-resolved customCwd propagates…（×3）
13–14. mount-purpose directory browsing lists only configured roots… / keeps a broad root navigable…（routes-browse-host-mount ×2）

**簇四：POSIX 权限位断言（0o600=384 vs NTFS 实际 438），4 例 — #13**

1. channel account routes publishes one stable mode-0600 encryption key in a mode-0700 directory（routes-channel-accounts）
   2–4. MCP secret exposure boundary：first runtime read atomically migrates legacy embedded secrets and is idempotent / reclaims a pre-existing stale migration lock… / never returns secret values and stores definitions separately（routes-mcp-server-secrets ×3）

**簇五：冒号/控制字符路径（NTFS 不允许创建 + 盘符冒号被校验拒绝），11 例 — #14**
1–6. validateAdditionalMountsStrict：returns canonical runtime and persistence forms / rejects a host path containing a colon / rejects a host path containing a control character / hot-reloads a tightened allowlist in the same process / revalidation fails after a previously valid directory is deleted / revalidation fails after a directory is replaced by an escaping symlink（mount-security-strict ×6）
7–8. buildVolumeMounts host-directory runtime authorization：mounts every valid persisted entry… / re-reads a tightened allowlist without restarting the process（container-runner-host-mount ×2）
9–11. POST /api/groups additional_mounts：persists the canonical source and explicit safe defaults / strict validation rejects a host path containing a colon / strict validation rejects a host path containing a control character（routes-groups-host-mount ×3）

**簇六：进程树终止 / SIGKILL 语义平台差异，2 例 — #15**

1. script run cancellation aborts only the selected process and never maps SIGKILL to exit 0（script-runner-abort）
2. host script privilege revocation terminates the active process tree owned by the revoked user（script-runner-revocation）

**簇七：品牌浅改与上游术语测试冲突（非 Windows 固有），1 例 — #16**

1. product terminology keeps Pi runtime and subagent terminology technically explicit（frontend-product-terminology）——断言上游 README 文案 `智能体优先工作模型`；本仓库 README 已按 ADR-0005 重写为 HClaw 定位段（上游署名保留），develop 基线即失败。

### 非确定性抖动（额外观察，— #17）

同日多轮回归实测：在 57 例确定性失败之外，Windows 并行负载下还会**随机**多出 0–4 例失败并逐轮漫游（已观测涉及 `routes-tasks-contract`、`routes-provider-runtime-apply`、`plugin-materializer`），单独重跑即转绿；典型报错为临时目录 `EPERM: rename/rm`（含 `afterAll` 清理失败导致用例全过仍记文件失败）。T1 验收口径：**确定性失败集合与上列 57 例一致、无新增确定性失败**；抖动簇治理见 #17。

### 基线使用约定

- 后续票验收时重跑同一命令，**确定性失败集合与本节清单一致**（允许 #17 所述的漫游抖动额外出现，需单独重跑确认转绿）且新票自身新增测试全绿，即视为「基线对比通过」。
- 基线为单次实测；失败簇清零（#10–#17 关闭）后应更新本节数字并附新日期。

## 应用图标

沿用上游 miniclaw 图标资产（`electron/assets/miniclaw-icon.png`、`web/public/icons/*`、文件名不改）。图标替换与产品名同理属 ADR-0005 产品可见面，但**不在 T1 范围**（票面明确「应用图标不在本票」）；`loading-logo.svg` / wordmark 同批后续票处理。

## 已知取舍

### 品牌浅改边界（T1 实际执行面）

T1 按 ADR-0005 完成**产品身份面**替换：electron 壳（窗口标题 / app.setName / 应用菜单 / About「HClaw · 炉心」/ 后端未连接错误页 / URL 校验错误标签）、打包配置（`productName`/`appId=com.hfamily.hclaw`/copyright）、web 入口（`index.html` title 与 apple-title、PWA manifest name）、登录页 / 初始设置向导 / 欢迎语 / 侧栏与加载页 logo alt、站点显示名默认值（`DEFAULT_APPEARANCE_CONFIG.appName='HClaw'`，AI 人格名 `aiName` 仍沿用内置主 Agent 名）。

**未替换**（留待后续票，需视觉验收）：

- 功能文案中指称平台/内置主 Agent 的「Miniclaw」（如「Miniclaw Skills」「主 Miniclaw 模型配置」）——与内置主 Agent 名（`ASSISTANT_NAME='Miniclaw'`，上游数据语义、测试冻结 "keeps the current Miniclaw default name stable"）纠缠，且部分文案被上游 DOM 测试断言（`Home · 固定归属 Miniclaw`、`Miniclaw 内置` 等），T1 不夹带。
- 代码注释、上游署名（README Attribution、About 灵感来源段、Help 菜单「Miniclaw on GitHub」、ShareCard 的 github.com/helsome/miniclaw 署名行）按纪律保留。
- 全部代码标识符保留上游：`MINICLAW_*` env、`~/.miniclaw` 数据目录、`__Host-miniclaw_session` cookie、`mcp__miniclaw__*` 前缀、`miniclawDesktop` 桥、`miniclaw-theme` 等 localStorage 键（ADR-0005）。

### 其他取舍

- **上游测试冻结的旧产品名**：`tests/electron-shell-contract.test.ts` 断言打包配置 `productName: Miniclaw`，与票面指令「productName 改 HClaw」直接冲突。已将该测试的品牌断言同步为 `productName: HClaw`（附注释），测试意图（打包聚焦桌面壳、图标与产物目录不动）不变；上游图标断言 `miniclaw-icon.png` 未动（图标不在本票）。
- **copyright 字段**：`electron-builder.yml` 的 copyright 随 productName 一并改为 HClaw contributors（安装包元数据属产品可见面）；上游署名以 README Attribution + LICENSE（未动）承载。
- **CI runner**：`hclaw-ci.yml` 选 ubuntu-24.04（与上游 ci.yml 同平台，全量单测在该平台全绿）。Windows runner 接入待 #10–#15 簇清零，届时需验证 better-sqlite3 在 runner 上可编译（本地 Windows 已实测 `npm ci` 成功、better-sqlite3 可用）。
- **quota-router 注入默认 no-op**：生产装配路径暂无 `setQuotaRoutingPolicy` 调用方，缝上默认挂 no-op 策略——这是 T1 的预期形态（额度感知未生效、行为零变化），后续票接装配。

## 真模型手动冒烟清单

（待后续接入真实模型/真实额度数据的票填充；T1 无可列项。）
