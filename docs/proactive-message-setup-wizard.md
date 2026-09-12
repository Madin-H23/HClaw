# 主动消息三渠道凭证配置向导（批二 B5，票 #25）

> 维护者操作手册：微信/飞书/钉钉三渠道的机器人/应用建立、凭证填入、私聊目标
> 获取、真机冒烟，逐条可勾选。**真实凭证只填在本地工作台/配置文件，任何凭证
> 值不入仓库**。前置代码态：B5 接线已完成（`resolveAdapter` 真解析，渠道未
> 连接/目标未配置时主动消息为 skipped，不发送）。

## 0. 全局前置（一次性）

- [ ] HClaw 服务已启动，admin 账号可登录工作台（Web UI）
- [ ] 定位数据目录（下文以 `<DATA_DIR>` 指代）。`DATA_DIR` 在代码里锚定
      `process.cwd()` 下的 `data`（`src/config.ts` 的 `path.resolve(PROJECT_ROOT, 'data')`），
      随运行形态有两个落点：- **开发/源码态**（仓库根执行 `npm run dev` / `npm start`）：`<仓库根>/data` - **桌面内嵌态**（HClaw 桌面版）：`%APPDATA%/HClaw/server/data`
      （内嵌引导先 chdir 到 `%APPDATA%/HClaw/server`，再落 `data` 子目录）- 拿不准就看 `<DATA_DIR>` 下是否有 `db/messages.db` 与 `config/` 子目录
- [ ] （冒烟前）了解频控配置文件：`<DATA_DIR>/config/proactive-message.json`
      （不存在=缺省最少节制：10 条/分钟、无冷却、无静默窗口）

三渠道私聊目标的取法统一：**用手机/客户端给机器人发一条私聊消息**，工作台
自动登记该会话，然后从会话 jid 里取目标 id（三渠道形态不同，见各节）。查
已登记会话 jid 的命令（任一 SQLite 工具，或用仓库自带 better-sqlite3；
**须在仓库根执行**——`require('better-sqlite3')` 靠仓库 `node_modules` 解析）：

```bash
node -e "const db=require('better-sqlite3')('<DATA_DIR>/db/messages.db');console.table(db.prepare(\"SELECT jid,name FROM registered_groups WHERE jid LIKE '%:%'\").all())"
```

私聊 jid 形态（与 `docs/` 内 B3 探查记录一致）：

| 渠道 | jid 形态                | `defaultTarget` 填法                        |
| ---- | ----------------------- | ------------------------------------------- |
| 飞书 | `feishu:ou_xxxxxxxx`    | `ou_xxxxxxxx`（`open_id`，`ou_` 前缀）      |
| 微信 | `wechat:wxid_xxxxxxxx`  | `wxid_xxxxxxxx`（裸 wxid，不带前缀）        |
| 钉钉 | `dingtalk:c2c:xxxxxxxx` | `c2c:xxxxxxxx`（兼容 `dingtalk:c2c:` 前缀） |

---

## 1. 飞书（open.feishu.cn 自建应用）

### 1.1 建应用

- [ ] 打开 https://open.feishu.cn/app → 「创建企业自建应用」，记下名称
- [ ] 「凭证与基础信息」页复制 **App ID** 与 **App Secret**
- [ ] 「添加应用能力」→ 添加 **机器人** 能力（不加这步，飞书客户端搜不到
      该机器人、也没法对它私聊，后续步骤全部无从谈起）
- [ ] 「权限管理」开通：`im:message`（获取与发送单聊、群组消息）——至少
      `im:message:send_as_bot`（以应用身份发消息）
- [ ] 「事件与回调」：订阅方式保持**长连接**（WebSocket），订阅「接收消息
      im.message.receive_v1」
- [ ] 「版本管理与发布」：创建版本并发布（企业自建应用管理员审核通过）

### 1.2 凭证填哪

- [ ] 工作台 → 设置 → 渠道账号 → 添加账号 → **飞书**
- [ ] 填账号名称 + App ID + App Secret → 保存并连接；连接状态转绿即成

（等价旧路径：设置 → IM 配置里填全局飞书凭证，落
`<DATA_DIR>/config/feishu-provider.json`；推荐走渠道账号。）

### 1.3 私聊目标怎么拿（open_id）

- [ ] 在飞书客户端搜索该应用机器人，发一条任意私聊消息（如「hi」）
- [ ] 用第 0 节命令查 `registered_groups`，取 `feishu:ou_xxx` 的 `ou_xxx`
      ——这就是 open_id

### 1.4 配置默认目标

- [ ] 编辑 `<DATA_DIR>/config/proactive-message.json`（不存在则新建）：

```json
{
  "version": 1,
  "channels": {
    "feishu": { "defaultTarget": "ou_xxxxxxxx" }
  }
}
```

配置热生效（改完即用，无需重启）。

### 1.5 验证

- [ ] 见第 4 节冒烟清单「飞书」条目；快速旁证：
      `node -e "const db=require('better-sqlite3')('<DATA_DIR>/db/proactive-message-deliveries.db');console.table(db.prepare('SELECT channel_id,outcome,target,reason FROM delivery_records ORDER BY id DESC LIMIT 5').all())"`
      应看到 `feishu / sent / ou_xxx`

---

## 2. 微信（iLink 机器人协议，扫码授权）

> ⚠️ 风险告知（SPEC #20 拍板、已记 `docs/limitations.md`）：微信通道走
> iLink 机器人协议，**存在账号风控风险**（发送频率过高可能触发限制）。因此
> 微信渠道的频控建议取三渠道最保守值（见 2.4），冒烟消息每次用**不同内容**
> （同内容会撞 HClaw 自身的冷却去重，造成「没收到」的误判）。

### 2.1 建机器人（= 扫码授权，无开放平台应用）

- [ ] 工作台 → 设置 → 渠道账号 → 添加账号 → **微信**
- [ ] 填账号名称 → 「创建并扫码」，工作台生成微信登录二维码
- [ ] 手机微信扫码并在手机上确认；如微信要求验证码，按提示在 UI 输入
- [ ] 账号状态转绿（长轮询在线）

### 2.2 凭证填哪

- [ ] 无需手工填凭证：botToken / ilinkBotId 由扫码授权自动取得并加密落本地
      （channel_accounts 体系）；**不要**把 token 抄进任何文件/仓库

### 2.3 私聊目标怎么拿（wxid，⚠ 前置步骤不可跳）

- [ ] **先手动私聊一次**：在微信里找到该机器人会话，发任意一条消息——
      机器人对某用户主动发送依赖连接内的 context_token 缓存，**token 仅来自
      该用户此前的入站消息**；没私聊过 = 冒烟必失败
- [ ] 查 `registered_groups` 取 `wechat:wxid_xxx` 的裸 `wxid_xxx`

### 2.4 配置默认目标（微信=最保守频率）

- [ ] `proactive-message.json` 加（示例值即建议值——微信限速压到 2 条/分钟 + 1 小时冷却，实际触发频率由任务侧保持每日级）：

```json
{
  "version": 1,
  "channels": {
    "wechat": {
      "defaultTarget": "wxid_xxxxxxxx",
      "rateLimitPerMinute": 2,
      "cooldownMs": 3600000
    }
  }
}
```

### 2.5 验证

- [ ] 见第 4 节冒烟清单「微信」条目（**换一条与上次不同的内容**再触发）

---

## 3. 钉钉（open-dev.dingtalk.com 企业内部应用）

### 3.1 建应用

- [ ] 打开 https://open-dev.dingtalk.com/fe/app → 「创建应用」（企业内部应用）
- [ ] 「凭证」页复制 **Client ID（旧称 AppKey）** 与 **Client Secret（AppSecret）**
- [ ] 「应用能力」添加「机器人」能力
- [ ] 「版本管理与发布」：发布应用（机器人可用）

### 3.2 凭证填哪

- [ ] 工作台 → 设置 → 渠道账号 → 添加账号 → **钉钉**
- [ ] 填账号名称 + AppKey（Client ID）+ AppSecret（Client Secret）→ 保存并连接

### 3.3 私聊目标怎么拿（c2c 会话 id）

- [ ] 在钉钉找到该机器人，发一条单聊消息（工作台经 Stream 模式收到）
- [ ] 查 `registered_groups` 取 `dingtalk:c2c:xxx`，`defaultTarget` 填
      `c2c:xxx`。注：钉钉 C2C 的主动发送不依赖先入站消息（AI Card 兜底直发
      conversationId），但首次仍需发一条消息来确定目标 id

### 3.4 配置默认目标

```json
{
  "version": 1,
  "channels": {
    "dingtalk": { "defaultTarget": "c2c:xxxxxxxx" }
  }
}
```

### 3.5 验证

- [ ] 见第 4 节冒烟清单「钉钉」条目

---

## 4. 真机冒烟清单（维护者逐条执行）

> 每渠道一次：**触发一次带 `notify_channels` 的定时任务** → 手机私聊收到纯文
> 本 → 审计库 `sent`。任务可以用第 5 步登记的探活任务，也可以临时建一个
> script 任务（命令 `exit 0`、notify_channels 勾对应渠道、手动「立即运行」）。

**通用观察命令**（每次触发后查最近 5 条投递审计）：

```bash
node -e "const db=require('better-sqlite3')('<DATA_DIR>/db/proactive-message-deliveries.db');console.table(db.prepare('SELECT channel_id,outcome,target,reason,trigger_type FROM delivery_records ORDER BY id DESC LIMIT 5').all())"
```

- [ ] **飞书**：任务 notify_channels 含 `feishu` → 立即运行 → 飞书私聊收到
      带任务头的纯文本 → 审计 `feishu/sent/ou_xxx`
- [ ] **微信**（前置：2.3 已手动私聊过一次）：notify_channels 含 `wechat` →
      立即运行 → 微信私聊收到纯文本 → 审计 `wechat/sent/wxid_xxx`；
      **重复冒烟时必须换内容**（同内容在 cooldownMs 内会被冷却去重丢弃，
      审计 `discard`——这是频控在正确工作，不是故障）
- [ ] **钉钉**：notify_channels 含 `dingtalk` → 立即运行 → 钉钉机器人单聊
      收到纯文本（文本类；若走卡片兜底形态，以收到内容为准）→ 审计
      `dingtalk/sent/c2c:xxx`
- [ ] **默认安全复核**：任选一渠道从 `proactive-message.json` 删掉
      `defaultTarget` → 触发 → 手机**不**收到 → 审计 `skipped`
      （reason 含「目标未配置/no-target」语义）→ 恢复配置
- [ ] **未连接安全复核**（可选）：断开某渠道账号（UI 停用）→ 触发 → 不发
      送，审计 `skipped`（adapter-unavailable 语义）→ 重新启用

冒烟全过 = 票 #25 的三渠道真机验收达成；勾选结果与审计输出截图/文本贴回
issue #25。
