# HClaw 🦞🔥

> The hearth of your AI infrastructure — a self-hosted, multi-channel agent workbench with quota-aware model routing.
> 你自己的 AI 基建炉心：自托管、多渠道接入、按额度与成本自动选择模型的 Agent 工作台。

**HClaw** = **H**earth **Claw**——壁炉是家的炉心，爪子伸向你常用的每一个渠道。

基于开源项目 [Miniclaw](https://github.com/helsome/miniclaw)（Pi Agent Runtime, MIT）深度二次开发。

## 旗舰特性（原创改造）

- **Quota-Aware Routing（额度感知路由）**：对接自建额度监控 multi-vendor-quota-tool 与 CC Switch 中央代理，按剩余额度与成本在多家供应商间自动选择模型——真实额度数据驱动，非静态配置
- **IM Automation（渠道自动化）**：个人自动化（提醒/邮件/巡检）迁移为工作台渠道与定时任务
- **Evals & Guardrails（评测与护栏）**：子代理编排 + 评测体系 + 可观测护栏（规划中）

上游原生能力：多用户工作台（Agent Profile / Workspace / Session 三层模型）、Skills、MCP、会话持久化、七种 IM 渠道。

## Attribution

Based on [miniclaw](https://github.com/helsome/miniclaw) by helsome (MIT). 深度二次开发，非官方分支；上游设计归功于原项目，原创改造见本仓库 commit 历史与上方特性清单。