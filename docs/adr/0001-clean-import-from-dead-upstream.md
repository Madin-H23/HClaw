# 本地副本净导入，不保留上游 git 历史

helsome/miniclaw 在 GitHub 已不可达（404，2026-09-11 实测），无法 fork、无法拉取上游更新。按二开叙事约定，以本地评估副本（HEAD 3ff1c8d，2026-08-18）robocopy 净导入为唯一 import 提交（e1ebc69），远端占位 README 以 unrelated-histories 合入。upstream remote 仅作出处记录，fetch 会失败属预期。

**Considered Options**: ①fork 按钮——保留上游 commit 历史且无法改名，弃；②clone 后推送——同样保留上游历史，与「面试 commit 历史即『哪些是我写的』证据链」冲突，弃；③净导入 re-init（本决策）——首条真实提交即 import 基线，改造史从零可审计。
