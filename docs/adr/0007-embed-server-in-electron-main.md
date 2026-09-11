# Windows 安装包内嵌 server 进 electron main

HClaw 打包主打单机「装完即用」：electron main 进程内启动完整 server（与 HCode ADR-0001「壳内嵌 Harness」同构）；远程 self-hosted server 模式保留（壳的 `MINICLAW_SERVER_URL` 逻辑原样不动）。已知最大工程风险是 better-sqlite3 需按 electron ABI 重编。

**Consequences**: 若原生模块重编受阻，降级方案为「手动起 server（Docker/Node）+ 壳连 localhost」，内嵌目标顺延 P1——降级事实如实记入 docs/limitations.md，不静默。
