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
8. resolveTurnOutcome does not mark or commit a final reply until the physical channel ACKs it（turn-outcome）
9. resolveTurnOutcome routes streaming-card local images through the exact turn outbox and includes their ACK（turn-outcome）
10. resolveTurnOutcome returns a negative MCP image acknowledgement when physical delivery is unconfirmed（turn-outcome）
11. warm channel outbox scope wiring contract bindChannelOutboxScope takes an explicit correlation id, defaulting to the runtime（warm-channel-outbox-scope-correlation）
12. warm channel outbox scope wiring contract both warm admissions bind the scope with the IPC deliveryId（warm-channel-outbox-scope-correlation）
13. warm channel outbox scope wiring contract cold turns keep relying on the runtime default（warm-channel-outbox-scope-correlation）
14. dynamic Workflow product contract keeps running Workflow state across a held background acknowledgement（workflow-card-contract）

**簇三：POSIX 绝对路径断言，14 例 — #12**
1–4. managed host Claude memory policy：excludes OS-home and configured host instructions… / keeps workspace-local memory… / treats a missing legacy context source… / detects an SDK memory file that escaped the applied exclusions（claude-memory-policy ×4）
5–9. node-resolver：buildNodeCandidates NVM_BIN / FNM_MULTISHELL_PATH / VOLTA_HOME are joined with node / resolveBinaryOnPath returns first executable match in PATH order / resolveBinaryOnPath skips empty segments without crashing / resolveNodeBinary does not choose Bun-like execPath or argv0… / resolveNodeBinary falls back to NVM_BIN/node…（node-resolver ×5）
10–12. plugin-expander-routing-bugs：P2-bug-4 customCwd honored in host mode（customCwd → cwd / no customCwd → fallback）+ P2-bug-3 sibling-resolved customCwd propagates…（×3）
13–14. mount-purpose directory browsing lists only configured roots… / keeps a broad root navigable…（routes-browse-host-mount ×2）

**簇四：POSIX 权限位断言（0o600=384 vs NTFS 实际 438），4 例 — #13**

1. channel account routes publishes one stable mode-0600 encryption key in a mode-0700 directory（routes-channel-accounts）
2. MCP secret exposure boundary first runtime read atomically migrates legacy embedded secrets and is idempotent（routes-mcp-server-secrets）
3. MCP secret exposure boundary reclaims a pre-existing stale migration lock without leaving plaintext secrets（routes-mcp-server-secrets）
4. MCP secret exposure boundary never returns secret values and stores definitions separately（routes-mcp-server-secrets）

**簇五：冒号/控制字符路径（NTFS 不允许创建 + 盘符冒号被校验拒绝），11 例 — #14**
1–6. validateAdditionalMountsStrict：returns canonical runtime and persistence forms / rejects a host path containing a colon / rejects a host path containing a control character / hot-reloads a tightened allowlist in the same process / revalidation fails after a previously valid directory is deleted / revalidation fails after a directory is replaced by an escaping symlink（mount-security-strict ×6）
7–8. buildVolumeMounts host-directory runtime authorization：mounts every valid persisted entry… / re-reads a tightened allowlist without restarting the process（container-runner-host-mount ×2）
9–11. POST /api/groups additional_mounts：persists the canonical source and explicit safe defaults / strict validation rejects a host path containing a colon / strict validation rejects a host path containing a control character（routes-groups-host-mount ×3）

**簇六：进程树终止 / SIGKILL 语义平台差异，2 例 — #15**

1. script run cancellation aborts only the selected process and never maps SIGKILL to exit 0（script-runner-abort）
2. host script privilege revocation terminates the active process tree owned by the revoked user（script-runner-revocation）

**簇七：品牌浅改与上游术语测试冲突（非 Windows 固有），1 例 — #16（✅ 2026-09-12 裁决②解决：README「上游原生能力」行补回术语，CI 豁免已撤，基线归零）**

1. product terminology keeps Pi runtime and subagent terminology technically explicit（frontend-product-terminology）——断言上游 README 文案 `智能体优先工作模型`；本仓库 README 已按 ADR-0005 重写为 HClaw 定位段（上游署名保留），develop 基线即失败。

### 非确定性抖动（额外观察，— #17）

同日多轮回归实测：在 57 例确定性失败之外，Windows 并行负载下还会**随机**多出 0–4 例失败并逐轮漫游（已观测涉及 `routes-tasks-contract`、`routes-provider-runtime-apply`、`plugin-materializer`），单独重跑即转绿；典型报错为临时目录 `EPERM: rename/rm`（含 `afterAll` 清理失败导致用例全过仍记文件失败）。T1 验收口径：**确定性失败集合与上列 57 例一致、无新增确定性失败**；抖动簇治理见 #17。

### 基线使用约定

- 后续票验收时重跑同一命令，**确定性失败集合与本节清单一致**（允许 #17 所述的漫游抖动额外出现，需单独重跑确认转绿）且新票自身新增测试全绿，即视为「基线对比通过」。
- 基线为单次实测；失败簇清零（#10–#17 关闭）后应更新本节数字并附新日期。

## 应用图标

图标内容已换 HClaw 炉心图（火焰+钳形卷曲），文件名保留上游路径以维持测试契约。替换清单：`electron/assets/miniclaw-icon.png`（1024×1024，内容替换）、`web/public/icons/icon-192.png`、`web/public/icons/apple-touch-icon-180.png`（HTML favicon/touch 引用）、`web/public/icons/icon-512.png`、`web/public/icons/icon-512-maskable.png`（PWA manifest 引用，maskable 版图形按 80% 安全区居中）——尺寸规格与上游一致；矢量母版入库 `docs/assets/hclaw-icon.svg`。未动：`electron/assets/miniclaw.icns`（mac 打包不在本票）、`loading-logo.svg`/`logo-text.svg`（wordmark 动画，随后续渲染面票处理）、其余未被 favicon/manifest 引用的 icon-\* 尺寸。

## 已知取舍

### 品牌浅改边界（T1 实际执行面）

T1 按 ADR-0005 完成**产品身份面**替换：electron 壳（窗口标题 / app.setName / 应用菜单 / About「HClaw · 炉心」/ 后端未连接错误页 / URL 校验错误标签）、打包配置（`productName`/`appId=com.hfamily.hclaw`/copyright）、web 入口（`index.html` title 与 apple-title、PWA manifest name）、登录页 / 初始设置向导 / 欢迎语 / 侧栏与加载页 logo alt、站点显示名默认值（`DEFAULT_APPEARANCE_CONFIG.appName='HClaw'`，AI 人格名 `aiName` 仍沿用内置主 Agent 名）、字体方案 label（`PreferencesSection` 默认字体项——fonts/ 无「Miniclaw」字体包，属产品名用法，归品牌面改 HClaw）。

**userData 迁移注意**：`app.setName('HClaw')` + productName 变更使打包版壳级 userData 目录由 `%APPDATA%/Miniclaw` 变为 `%APPDATA%/HClaw`——`window-state.json` 等壳级本地状态不随自动迁移（`MINICLAW_*` env、server 侧 `~/.miniclaw` 数据目录不受影响）。T1 为首票、无存量装机；后续如需与旧版并存/升级，须补壳级状态迁移逻辑。

**未替换**（留待后续票，需视觉验收）：

- 功能文案中指称平台/内置主 Agent 的「Miniclaw」（如「Miniclaw Skills」「主 Miniclaw 模型配置」）——与内置主 Agent 名（`ASSISTANT_NAME='Miniclaw'`，上游数据语义、测试冻结 "keeps the current Miniclaw default name stable"）纠缠，且部分文案被上游 DOM 测试断言（`Home · 固定归属 Miniclaw`、`Miniclaw 内置` 等），T1 不夹带。
- 代码注释、上游署名（README Attribution、About 灵感来源段、Help 菜单「Miniclaw on GitHub」、ShareCard 的 github.com/helsome/miniclaw 署名行）按纪律保留。
- 全部代码标识符保留上游：`MINICLAW_*` env、`~/.miniclaw` 数据目录、`__Host-miniclaw_session` cookie、`mcp__miniclaw__*` 前缀、`miniclawDesktop` 桥、`miniclaw-theme` 等 localStorage 键（ADR-0005）。

### 其他取舍

- **lint 口径**：`npm run lint` = `npm run format:check`（prettier 对「相对 origin/develop 分叉的变更文件」整文件检查；CI 同口径，`FORMAT_BASE_REF=origin/develop`）。`scripts/check-format-changed.mjs` 顺手修复 Windows spawn 兼容（改用 `process.execPath + prettier.cjs` 直跑，规避 Node 对 `.cmd` 的 spawnSync EINVAL 加固）；Windows autocrlf 工作区会因行尾被整文件标记——已对本分支变更文件统一 prettier 化（行尾 LF + 存量重排，无语义变更）。
- **上游测试断言的两类处理口径**：断言**随产品面改名**的（如 `electron-shell-contract` 冻结 `productName: Miniclaw`）——随品牌更新直接同步断言并注明依据（票面指令 + ADR-0005）；上游**内容契约**冲突（如 #16 断言上游 README 术语段）——涉及上游文案取舍，立票裁决、本票不夹带。#16 已裁决：方案②（README 补回「智能体优先工作模型」术语，上游契约零改动）。
- **上游测试冻结的旧产品名**：`tests/electron-shell-contract.test.ts` 断言打包配置 `productName: Miniclaw`，与票面指令「productName 改 HClaw」直接冲突。已将该测试的品牌断言同步为 `productName: HClaw`（附注释），测试意图（打包聚焦桌面壳、图标与产物目录不动）不变；上游图标断言 `miniclaw-icon.png` 未动（图标不在本票）。
- **copyright 字段**：`electron-builder.yml` 的 copyright 随 productName 一并改为 HClaw contributors（安装包元数据属产品可见面）；上游署名以 README Attribution + LICENSE（未动）承载。
- **CI runner（2026-09-12 更新）**：`hclaw-ci.yml` 三 job——verify（ubuntu：typecheck+format+单测）、test-windows（windows-latest 单测，#10-#15 簇清零后接入）、package-windows（NSIS 打包）。**#16 裁决（方案②）落地后豁免已全部移除，单测在双平台零失败零豁免**；本节 57 例清单保留作历史基线记录。
- **quota-router 注入默认 no-op**：生产装配路径暂无 `setQuotaRoutingPolicy` 调用方，缝上默认挂 no-op 策略——这是 T1 的预期形态（额度感知未生效、行为零变化），后续票接装配。

## Windows 内嵌打包（T8 实测）

> 日期 2026-09-12；形态=ADR-0007 全量内嵌（未触发重编降级）。包=NSIS x64，`npm run desktop:package:win` 出 `electron/release/HClaw Setup <ver>.exe`。

### 内嵌形态（工程事实）

- **技术路径**：electron main 进程动态 `import()` 后端 tsc 编译产物 `dist/index.js`（与 `npm start` 同一运行时形态；上游 `main()` 模块尾部自启，import 即装配）。三选一论证：esbuild 二次 bundle 巨石 + IM SDK 群转换风险高；子进程 spawn 需随包 Node 运行时；直接 import 编译产物改动最小、上游语义零变换。`src/` 零 diff，端口经上游既有 `WEB_PORT` env 注入。
- **cwd 杠杆**：上游 `config.ts` 以 `process.cwd()` 锚定 `DATA_DIR`、`web.ts` 以 `./web/dist` 服务静态前端。内嵌启动先 `chdir` 到可写根 `%APPDATA%/HClaw/server`（userData 下），数据面与静态面同锚。
- **产物物化**：web 前端（extraResources `web-dist` → `userData/server/web/dist`，按包版本戳幂等）；宿主 agent 依赖（`container/agent-runner` extraResources → junction `userData/server/container/agent-runner`，junction 失败退拷贝、再失败放行——preflight 给结构化 setup 错误不阻塞其他面）。
- **better-sqlite3 重编（未降级）**：`desktop:rebuild:electron` 用 prebuild-install 取官方 electron-v140 预编译（electron 39 / ABI 140 实测 SQLITE_OK）；打包后 `desktop:rebuild:node` 自动恢复 Node ABI（顺序错误会让本机 vitest 全挂）。node-pty 为 NAPI 预编译，无需按 ABI 重编。electron-builder 内置 npm rebuild 关闭（`npmRebuild: false`）：其捆绑 node-gyp 在本机 VS2022 探测失败（"Could not find any Visual Studio installation to use"），且对 NAPI 模块本就多余。
- **打包根**：由上游 `electron/` 改为仓库根（files/extraMetadata.main 等路径加 `electron/` 前缀），生产 node_modules 由 electron-builder 按 root package.json 自动收集，`dist/**`、`node_modules/**`、`src/pty-worker.cjs` 整体 asarUnpack 落真实文件系统（ESM import 与 native require 不经过 asar 虚拟路径）。壳契约测试 `tests/electron-shell-contract.test.ts` 图标断言已随打包根同步（注明依据）。

### 已知局限（内嵌打包）

- **agent 执行轮需要系统 Node.js**：宿主回合 preflight 通过后由上游 node-resolver 解析 node 二进制 spawn `container/agent-runner/dist/pi-index.js`（上游语义，`src/` 零 diff 约束）。未装 Node.js 的机器：发消息会收到结构化 setup 错误气泡（数据面/额度面板/卡片/IM 配置面不受影响），终端 PTY 回退 pipe 模式。
- **安装目录名沿包名 `miniclaw`**：`%LOCALAPPDATA%\Programs\miniclaw\HClaw.exe`——目录名来自 package.json `name`（上游代码标识符，ADR-0005 保留）；产品可见面（快捷方式 `HClaw.lnk`、exe 名、DisplayName「HClaw 1.0.0」、appId）均为 HClaw。
- **卸载不删用户数据**：`deleteAppDataOnUninstall: false`（显式落字），`%APPDATA%/HClaw`（含内嵌 server 的 SQLite/会话/额度快照）随卸载保留；junction 断链残留于其中，重装自愈。
- **静默卸载有部分残留（本机 3/3 复现，未清根因）**：`"Uninstall HClaw.exe" /S` 三次实测同形残留——①安装目录部分文件未删（固定清单：`resources.pak`、`snapshot_blob.bin`、`v8_context_snapshot.bin`、`version`、`vk_swiftshader*.dll`、`vulkan-1.dll`、`resources/` 残目录、卸载器本体；HClaw.exe 与其余大文件正常删除）②开始菜单/桌面 `HClaw.lnk` 未删 ③注册表卸载项未删；退出码均为 0（静默模式吞掉失败，无用户可见报错）。疑因：AV/索引器对刚重装文件的短暂句柄 + NSIS 卸载器静默跳过/中止后不回滚快捷方式与注册表段；两次连跑卸载器不推进（疑似首跑后清单态丢失）。**干净机器（无 AV 干扰、应用完全退出）复核待做**；临时清理路径=手删残目录+快捷方式+`reg delete` 卸载项。
- **代理会话内打包的文件锁竞态（环境固有，非包质量）**：本机打包实测 4 次 EBUSY——①旧 `better_sqlite3.node`（重试过）②/③ NSIS 写完临时卸载器、signtool 回写后 makensis 立即回读被拒（内外输出目录皆复现，事后探测无残留占者=瞬时扫描窗口；间隔重试可过，本票成功一轮曾穿过该点）④旧输出目录 `app.asar`/`default_app.asar` 长期锁死清不掉（Restart Manager 指认占用者=ZCode 代理主进程，代理 harness 对工作区新文件的句柄；换仓库外输出目录绕过）。CI 与正常终端环境无此干扰；`directories.output` 保持上游口径 `electron/release` 不变，本票最终包落仓库外一次性目录后校验。
- **server stdout 打包态不可见**：pino 日志走 stdout；内嵌引导事件（物化/端口/就绪/退出码）落 `%APPDATA%/HClaw/server/embedded-server.log`（1MB 轮转）。
- **内嵌启动失败回退的覆盖范围**：装配期失败（入口缺失 / import 同步抛 / 装配期 `process.exit` / 监听超时）→ 弹 `dialog.showErrorBox` 并回退缺省地址 `127.0.0.1:3000`——即 ADR-0007 预案的「手动起 server + 壳连 localhost」形态。装配期对上游 `process.exit` 做临时接管（转记退出码 + 抛可捕错误，监听就绪即还原；`main().catch` 回调内的调用点会逃逸成 unhandledRejection 警告，进程不退，由引导按退出码判定失败）。**覆盖边界**：装配完成（监听就绪）后的 server 运行期 exit 路径不接管，会照上游原语义直接杀壳——已知局限。显式 `MINICLAW_SERVER_URL` / `--server-url` 时完全不内嵌（远程模式语义原样）。
- **端口分配 TOCTOU（已知窗口）**：空闲端口由 `listen(0)` 探测后立即释放，到上游 `startWebServer` 真正 bind 之间有时间窗，极小概率被其他进程抢占——后果为装配失败走弹窗回退，可重试；上游缺省 3000 固定端口同样存在该性质，不另设重试。
- **web 前端物化按版本戳幂等（已知边界）**：同版本号重装/重打包不重物化 `web/dist`（戳=包版本）——同版本内前端内容变化时需手动清 `%APPDATA%/HClaw/server/web/dist`（或删 `.web-dist-version` 戳）触发重物化；正式发版升版本号场景不受影响。
- **macOS/linux 段**：electron-builder.yml 保留上游语义（仅路径随打包根加前缀），本票只在 Windows 实测；mac dmg/zip 与 linux AppImage 未验。
- **CI 打包 job**：`hclaw-ci.yml` 增 `package-windows`（windows-latest，artifact `HClaw-windows-x64-setup`）；runner 上 prebuild 下载与 NSIS 工具下载均走 GitHub 直连，未用镜像。

### 打包/装后人工验收清单（无真实模型可全绿）

1. **装**：`HClaw Setup 1.0.0.exe /S` 静默安装 → `%LOCALAPPDATA%\Programs\miniclaw\` 出现、开始菜单 `HClaw.lnk`、注册表 `HKCU\...\Uninstall` DisplayName=HClaw。
2. **启**：启动「HClaw」→ 窗口出现初始化向导（非「Backend 未连接」错误页）；`%APPDATA%/HClaw/server/embedded-server.log` 有「内嵌 server 就绪：http://127.0.0.1:<port>」。
3. **登录**：向导建管理员 → 进入工作台；清 cookie 重进应见登录页并可登录。
4. **额度面板**（mock 态构造）：设两个 SMOKE 供应商（假 baseUrl 即可）→ `%APPDATA%/HClaw/server/data/config/` 写 `quota-router.json`（映射 → fake quota-tool baseUrl）与 `quota-router-credentials.json`（用仓库 `dist/runtime-config.js` 的 `encryptChannelSecret` 加密，密钥=同目录 `claude-provider.key`）→ 起一个 fake quota-tool（POST /api/query 回 `{ok:true,updatedAt,summary,windows,details}`，windows 项七字段契约见 `src/quota-router/tiers.ts`）→ 侧栏「额度」应出两卡：充足绿档/耗尽红档 + 原始信号 + 数据时间（面板读取即触发懒刷新，首读空、~2s 后刷新）。
5. **降档/否决卡片**：把「耗尽」档供应商 `PUT /api/config/claude/default` 设为默认 → 会话发一条消息 → 池内有可用目标时出【额度降档】卡（重指到充足档）；禁用唯一充足档后再发，出【额度否决】卡（本轮 runner 不启动）。会话流内直接可读（turn-cards 徽标文本）。
6. **卸载**：`"Uninstall HClaw.exe" /S` 后**逐项核对并记录事实**（本机实测为部分残留，见「已知局限」卸载条目，不以「消失」为预期断言）：安装目录是否清空、`HClaw.lnk`（开始菜单/桌面）是否消失、注册表卸载项是否消失、`%APPDATA%/HClaw` 保留（上一条）。发现残留：记录清单 → 手动清理（删残目录/快捷方式 + `reg delete` 卸载项）→ 复核。
7. **图标成品核对**：右键 `%LOCALAPPDATA%\Programs\miniclaw\HClaw.exe` → 属性 → 详细信息/图标，核对 exe 图标为 HClaw 炉心图（非 Electron 默认原子图）；同法核对安装器 `HClaw Setup <ver>.exe` 图标（NSIS 由 `win.icon` 生成的 ico 成品）。

## 主动消息与三渠道真机接入（批二 B5 实测/拍板，#25）

### 微信 iLink 机器人协议——账号风控风险（知情接受）

- 微信通道走 iLink Bot API（`ilinkai.weixin.qq.com`，扫码授权取得 botToken，
  长轮询收信）：**非官方开放平台协议，存在账号风控风险**——发送频率异常可能
  触发微信侧限制。SPEC #20 拍板知情接受并在此记录。
- 缓解口径：微信渠道频控取三渠道**最保守值**（向导建议
  `rateLimitPerMinute: 2` + `cooldownMs: 3600000`，任务侧保持每日级触发）；
  探活/晨检类高频告警优先走飞书/钉钉，微信只收每日级摘要。
- iLink 主动发送依赖连接内 context_token 缓存（**仅来自该用户此前入站消息**）：
  目标账号必须先手动私聊机器人一次，否则主动消息必失败（向导 2.3 前置步骤）。

### 三渠道保守发送频率（拍板记录）

- 全局缺省限速 10 条/分钟是「最少节制」上限（B2 配置缺省），**不建议**三渠道
  按缺省跑真机；实际建议：飞书/钉钉 ≤5 条/分钟（渠道默认覆盖），微信 2 条/分钟
  - 1 小时冷却。理由：个人自托管场景通知量本就每日级，频控上限只兜「任务失控
    轰炸」；微信因风控风险再压一档。
- 冷却去重按内容 SHA-256 键控：同型通知（探活文案常只差一个字段）天然不同
  摘要不会被误吞；真正同内容的重复触发（如手抖连点两次「立即运行」）会被
  冷却丢弃（审计 `discard`）——这是预期节制，不是漏发。

### 主动消息对 im-manager 的依赖（B5 接线后的运行时边界）

- 投递解析链：admin 用户（`listUsers` 首个 active admin）→
  `imManager.getConnectedChannel`（只读，复用 `isOutboundConnectionAllowed`
  出站门控）→ `bindImChannelAdapter`。含义：①**没有 admin 用户=全部渠道
  skipped**（单 admin 假设，沿 ADR-0008「MVP 仅 admin 私聊」）；②渠道账号
  停用/未连接=该渠道 skipped（socket 在 ≠ 有权发，门控不豁免）；③同渠道多
  账号时取**连接序第一个**可用账号（未做按账号指定目标，多账号精确选择留
  后续票，向导走单账号路径）。
- 目标未配置（`proactive-message.json` 缺 `defaultTarget`）=该渠道 skipped——
  接线后默认行为安全（不配置=不发送），全部可观察（投递审计 + 结构化日志）。
- 钉钉 C2C 主动发送不依赖先入站消息（AI Card 兜底直发 conversationId），
  卡片形态与纯文本形态以渠道适配器实际表现为准；飞书/微信按纯文本发送。

### 双投收敛（B5 拍板建议，实施待维护者定）

- 现状：任务声明 `notify_channels` 后，完成点两路并存——新入口（频控+审计+
  默认私聊目标）与上游旧投递面（`sendImWithRetry`，投往任务绑定/fan-out）。
  冷却去重**不能**跨路径吸收双投（旧路径不写频控库、内容摘要必异）。
- **建议方案②「旧路径让位」**：任务已声明 notify_channels 的渠道上旧投递
  跳过。理由：①让位后声明渠道收归有频控/审计/目标治理的路径，正合 SPEC
  「有节制可审计的通知中枢」；②「内容对齐」方案治标不治本——两路文本对齐后
  仍无跨路径账本，双投依旧，还得引入跨路径查账复杂度；③改动面：让位只在
  旧投递点按声明渠道过滤一处，内容对齐要动两路成形逻辑且改变旧路径接收方
  的既有阅读形态。**实施归后续票**（含未声明渠道行为不变的回归验证）。

### 薄迁移（Ydisks/relay）边界

- 登记种子与零改写对照表见 `docs/proactive-message-thin-migration-runbook.md`；
  登记命令含本机绝对路径（运维数据非代码事实源），换机只改任务配置。
- script 任务经 cmd.exe 执行，现网 bash 方言命令的机械替换（NUL/findstr/
  call/ping 等待）逐条记录于对照表——**检查逻辑零改写**的 diff 审计口径。
- 并跑期 relay 晨检两源都会拉起 relay bat（自带单实例清理，重复执行无害）；
  Ydisks 侧两源均为只读探活，「禁重启」铁律由命令只读性保证。

## 真模型手动冒烟清单

（真实供应商/真实额度数据接入手动项；T8 起与「打包/装后人工验收清单」配套——先跑打包清单全绿，再按下列项验真模型链路。）

- [ ] 真实供应商凭证接入（官方/第三方任一）：设置→模型配置建供应商，健康检查转绿
- [ ] 真实 quota-tool 端点接入：`quota-router.json.quotaTool.baseUrl` 指向真实工具，面板档位与工具侧数据一致（非 fake 载荷）
- [ ] 真实回合：会话发任务 → 选中供应商按额度真实决策（充足直选/紧张/临界按阈值）、流式卡片正常收尾
- [ ] 真实降档：耗尽默认供应商 + 真实池 → 降档卡 + 任务落到降档目标且回合成功
- [ ] 真实否决：唯一供应商耗尽 → 否决卡 + 无 runner 启动；`adminOverride:true` 时放行卡 + 告警
- [ ] IM 渠道回合（Feishu/Telegram 任一）：额度事件卡不在 IM 侧刷屏（T7 边界：纯 IM 群不发卡）
