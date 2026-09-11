# Domain Docs

Engineering skills 探索 codebase 时，应如何消费这个 repo 的 domain documentation。

## Before exploring, read these

- repo 根目录的 **`CONTEXT.md`**（本 repo 为 single context，无 CONTEXT-MAP.md）
- **`docs/adr/`** — 0001 净导入基线 / 0002 多用户保留 / 0003 自持路由直连 / 0004 fail-open / 0005 品牌浅改 / 0006 独立快照库 / 0007 内嵌 server。凡动选路、存储、品牌、打包，先读对应 ADR。

## Use the glossary's vocabulary

当你的输出命名某个 domain concept 时（issue title、refactor proposal、hypothesis、test name），使用 `CONTEXT.md` 中定义的 term，不要漂移到 glossary 明确避免的 synonyms。特别注意：

- **供应商** ≠ **渠道**：模型侧一律「供应商/provider」，IM 侧一律「渠道/channel」
- 「额度」裸用禁止：**供应商额度**（quota-tool 供数）与**用户余额**（上游 billing）必须带前缀
- 上游 fallback 专指失败触发的降级；额度触发的叫**降档**

如果你需要的概念还不在 glossary 中，这是一个信号：要么你正在发明项目没有使用的语言（重新考虑），要么确实存在缺口（为 `/domain-modeling` 记录）。

## Flag ADR conflicts

如果你的输出与现有 ADR 矛盾，明确指出，而不是静默覆盖：

> _Contradicts ADR-0004 (quota-routing fail-open) — but worth reopening because…_
