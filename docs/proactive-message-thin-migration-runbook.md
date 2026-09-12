# 薄迁移 Runbook：Ydisks 探活 + relay 晨检迁入 HClaw 定时任务（批二 B5，票 #25）

> 目标：两个现网 ZCode cron 例行**检查逻辑零改写**地迁入 HClaw 定时任务
> （HClaw 只做调度+通知），与原 cron **并跑 ≥3 天**双源记录一致后再切换。
> 切换（停旧 cron）是并跑验证后的**运维动作**，不在本票自动化范围。
> 前置：三渠道凭证已按 `docs/proactive-message-setup-wizard.md` 配好。

## 1. 登记方式选型：命令级引用登记（脚本本体不入库）

**结论：种子=任务登记配置（本文第 2 节），`script_command` 原样承载现网检
查命令串；两脚本的「本体」（relay 的 start\_\*.bat、Ydisks 程序）留原位不动、
不入仓库。**

选型理由（票面二选一：脚本路径引用 vs 内容入库）：

1. **「脚本路径引用」严格不成立**：这两个检查在现网不是独立脚本文件，而是
   ZCode cron prompt 里的内联命令（Ydisks=一条 curl 探活 + AI 判定；relay
   晨检=拉起 bat + netstat 端口检查步骤）。可引用的只有命令本身。
2. **命令级引用 = 零改写最彻底**：`script_command` 直接承载现网命令串，
   diff 审查口径=逐条对照本文第 3 节「零改写对照表」与 ZCode cron 原文；
   检查逻辑（探测目标/超时/判定/重试语义）没有任何转写层。
3. **不选「内容入库」**：把命令或脚本复制进仓库会形成第二事实源（仓库副本
   与现网 cron 必然漂移），且固化一次性机器路径——违背薄迁移「检查逻辑零
   改写、迁移风险趋零」的初衷。路径出现在登记配置（运维数据）而非代码/文档
   常量里，属登记信息非凭证。

方言级机械替换（cmd.exe 执行环境所需，**非逻辑改写**，逐条见第 3 节）：
HClaw script 任务在 Windows 经 `spawn(command, {shell: true})` = cmd.exe 执行
（`src/script-runner.ts`），现网 cron 命令是 bash 方言（`/dev/null`、`grep`）。

## 2. 任务登记种子（两条）

### 种子 A：Ydisks 探活（仅探活禁重启）

| 字段                           | 值                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------- |
| schedule_type / schedule_value | `cron` / `20 9 * * 1-5`（对齐现网：工作日 09:20）                            |
| execution_type                 | `script`                                                                     |
| script_command                 | `curl -s -o NUL -m 8 -f -w "%{http_code}" http://127.0.0.1:59188/`           |
| notify_channels                | `["feishu","dingtalk","wechat"]`（可按需裁剪；微信最保守，仅此每日一条无碍） |
| prompt（任务名/说明）          | `Ydisks 探活巡检（仅探活禁重启；迁自 ZCode cron，检查逻辑零改写）`           |

语义：Ydisks 后台（127.0.0.1:59188）HTTP 探活，8 秒超时；成功→成功通知，
失败（非 2xx/连接失败）→失败告警。**铁律沿现网：只探活，命令无任何启停动作。**

### 种子 B：relay 晨检（保活+三端口检查）

| 字段                           | 值                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------- |
| schedule_type / schedule_value | `cron` / `10 9 * * 1-5`（对齐现网：工作日 09:10）                             |
| execution_type                 | `script`                                                                      |
| script_command                 | 见下方命令块                                                                  |
| notify_channels                | `["feishu","dingtalk","wechat"]`（同上可裁剪）                                |
| prompt（任务名/说明）          | `relay 晨检（gmi 8787 + B.ai 8789 保活 + Karing 3067 检查；迁自 ZCode cron）` |

```text
call "C:\Users\28951\.zcode\relay\start_relay.bat" && call "C:\Users\28951\.zcode\relay\start_bai_relay.bat" && ping -n 5 127.0.0.1 >NUL && ((netstat -ano | findstr ":8787" | findstr "LISTENING" >NUL && netstat -ano | findstr ":8789" | findstr "LISTENING" >NUL) || (ping -n 6 127.0.0.1 >NUL && netstat -ano | findstr ":8787" | findstr "LISTENING" >NUL && netstat -ano | findstr ":8789" | findstr "LISTENING" >NUL)) && netstat -ano | findstr ":3067" | findstr "LISTENING" >NUL
```

语义（与现网 cron prompt 逐步对应）：拉起两个 relay bat（自带单实例清理，
重复执行无害）→ 等 4 秒 → 8787+8789 须 LISTENING（未监听等 5 秒重查一次）
→ Karing 3067 须 LISTENING（单查不重试）。三口全绿=成功通知；任一失败=
告警（Karing 不在线时 relay 无法出站，提示用户干预——通知内容带任务头）。

### 登记操作（二选一）

- **UI**：工作台 → 任务页 → 新建任务 → 执行类型选「脚本」→ 按上表填入
  （计划类型 cron、命令、通知渠道）→ 保存后任务行「立即运行」可手动验证。
- **API**（admin 登录态 Cookie）：

```bash
curl -X POST http://127.0.0.1:<WEB_PORT>/api/tasks \
  -H "Content-Type: application/json" \
  -H "Cookie: __Host-miniclaw_session=<admin 会话>" \
  -d '{
    "prompt": "Ydisks 探活巡检（仅探活禁重启；迁自 ZCode cron）",
    "schedule_type": "cron",
    "schedule_value": "20 9 * * 1-5",
    "execution_type": "script",
    "script_command": "curl -s -o NUL -m 8 -f -w \"%{http_code}\" http://127.0.0.1:59188/",
    "notify_channels": ["feishu", "dingtalk", "wechat"]
  }'
```

（种子 B 同法；script_command 上限 4096 字符，实际约 400，余量充足。）

## 3. 零改写对照表（diff 审查口径）

### A. Ydisks 探活

| 现网 cron 原文（bash 方言 / AI 判定）                                 | 登记版（cmd 方言 / 退出码判定）      | 差异性质                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `curl -s -o /dev/null -m 8 -w '%{http_code}' http://127.0.0.1:59188/` | 同命令，`/dev/null`→`NUL`            | 方言（cmd 无 /dev/null）                                                                                            |
| prompt 判定「非 200 或连接失败 → 报警」                               | 增 `-f`：非 2xx 使 curl 退非 0       | 机械折算：原判定由 cron prompt 内 AI 承担，script 任务以退出码判成败（成败即通知成败），`-f` 是该判定的命令行等价物 |
| 「200 → 简报」                                                        | 成功通知（HClaw 主动消息，带任务头） | 汇报通道从 ZCode 会话换为 IM 私聊（薄迁移定义：调度+通知归工作台）                                                  |
| 铁律「禁重启/禁启停」                                                 | 命令只读，无任何启停动作             | 原样保持                                                                                                            |

### B. relay 晨检

| 现网 cron 原文                                                     | 登记版                                                        | 差异性质                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `cmd //c "...start_relay.bat"`、`cmd //c "...start_bai_relay.bat"` | `call "...start_relay.bat" && call "...start_bai_relay.bat"`  | 方言+执行环境：登记版在同一 cmd 进程内串行，bat 须经 `call` 才返回继续（bash 里的 `cmd //c` 是每次独立进程，无需 call）      |
| 「等 4 秒后检查」                                                  | `ping -n 5 127.0.0.1 >NUL`                                    | 机械替换：`timeout /t 4` 在无控制台的 spawn 下报「Input redirection is not supported」退非 0；ping -n 5 ≈ 4 秒等待，等价计时 |
| `netstat -ano \| grep ":8787" \| grep LISTENING`（8789 同）        | `netstat -ano \| findstr ":8787" \| findstr "LISTENING" >NUL` | 方言（grep→findstr）                                                                                                         |
| 「未监听再等 5 秒重查一次」                                        | `\|\| (ping -n 6 … && netstat…8787… && netstat…8789…)`        | 原样（relay 两端口一次重查；Karing 不参与重试）                                                                              |
| Karing 3067 检查（单查、失败属「需用户干预」）                     | 尾部 `&& netstat…":3067"…>NUL`                                | 原样（单查不重试；失败=整体失败=告警）                                                                                       |
| 汇报「8787/8789/3067 各自状态」                                    | 成功/失败通知经主动消息（审计留痕）                           | 汇报通道更换（同 A）；失败定位可查 script 任务运行日志与投递审计                                                             |

## 4. 并跑 ≥3 天：双源对照记录模板

**并跑启动条件**：第 2 节两条任务登记完成 + 真机冒烟（向导第 4 节）通过 +
**旧 ZCode cron 保持不动**。并跑期两源同刻触发（时刻已对齐现网）。

记录方式：每个工作日两源各跑后，在**本文件同目录建
`thin-migration-parlog-<起始日期>.md`**（不入仓库亦可，本地台账），逐行填：

```markdown
# 双源对照记录（并跑起始：YYYY-MM-DD）

一致判据：同刻触发窗口内，两源对同一检查目标的结论一致（正常/异常），
异常时异常对象一致；汇报渠道/文案形态不要求一致（旧=ZCode 会话，新=IM 私聊）。
频控类结果（审计 outcome=hold/discard/skipped）属节制语义非故障，记「备注」列。

| 日期  | 任务        | ZCode 结论（时刻）  | HClaw 结论（时刻）             | 一致? | 备注（审计 outcome/分歧原因） |
| ----- | ----------- | ------------------- | ------------------------------ | ----- | ----------------------------- |
| 09-15 | Ydisks 探活 | 200 正常（09:20）   | sent「探活 200 正常」（09:20） | ✅    |                               |
| 09-15 | relay 晨检  | 三端口在线（09:10） | sent（09:10）                  | ✅    |                               |
```

HClaw 侧取证命令：

```bash
# 投递审计（最近 10 条：渠道/结果/目标/理由）
node -e "const db=require('better-sqlite3')('<DATA_DIR>/db/proactive-message-deliveries.db');console.table(db.prepare('SELECT channel_id,outcome,target,reason,task_id,created_at_ms FROM delivery_records ORDER BY id DESC LIMIT 10').all())"
# 任务运行记录：工作台任务页运行历史（脚本任务 stdout/exit code）
```

**切换判据与动作**：

- 连续 **≥3 个完整天**（建议覆盖一个周一）双源记录一致、无未解释分歧
- 频控原因导致的「少发」（hold/silence 窗口/discard）不算不一致，但要在
  备注列可解释
- 达标后：停旧 ZCode cron（`CronList` → 删除对应 automation）——**运维动作，
  由维护者执行**；HClaw 侧任务保持 active
- 未达标：分歧逐条溯源（第 3 节对照表 → HClaw 审计 → script 运行日志），
  修正后再计 3 天

## 5. 边界与已知限制

- 登记命令含本机绝对路径（relay bat），换机/迁移路径时**只改任务配置**，
  本文档种子表同步更新（登记数据非仓库代码事实源）
- 并跑期 relay 晨检两源都会拉起 bat——bat 自带单实例清理，重复执行无害
  （现网 prompt 原文背书）；若不放心可把 HClaw 版排后 5 分钟错峰
- 微信渠道投递受 2.4 节保守频控约束（2 条/分钟+1 小时冷却），每日级探活
  通知不受影响；若某日多任务同告警，微信侧可能被限速合并——以飞书/钉钉
  侧送达为准，详见 `docs/limitations.md`
