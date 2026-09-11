# 额度快照落独立 SQLite 文件，不动上游 db.ts

额度路由模块的衍生数据（额度快照缓存）落在独立文件 `data/db/quota-router.db`，由该模块独占拥有；上游 `messages.db`（db.ts 14.5k 行巨石）schema 一行不动。上游库的迁移链是「上游语义零改动」的红线区；衍生数据应当可整体丢弃重建，而不触碰上游 schema。

**Consequences**: 仓库内将有两个 SQLite 文件——messages.db 属上游语义，quota-router.db 属 HClaw 原创，归属以文件划界，不共享连接。
