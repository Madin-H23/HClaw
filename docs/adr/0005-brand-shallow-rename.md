# 品牌浅改：产品面改名，代码标识符保上游 miniclaw

HClaw 只替换产品可见面（名称/图标/界面品牌词/README）；`MINICLAW_*` 环境变量前缀、`~/.miniclaw` 数据目录、`__Host-miniclaw_session` cookie、`mcp__miniclaw__*` 工具前缀全部保留上游原样。替换这些等于改上游运行时语义并要求存量数据迁移，违背上游语义零改动的合流对价；个人数据（会话/工作区/账单）留在原路径，零迁移风险。
