# HClaw 自持路由，直连供应商；CC Switch 平行不对接流量

额度感知路由的执行面是 HClaw 自己的上游 provider 池（Anthropic 兼容端点直连各供应商），不借道 CC Switch 的本地代理（127.0.0.1:15721）。三源数据全部只读对接：quota-tool HTTP 查剩余额度、`cc-switch.db` 只读拿模型单价与已花成本、上游 billing 出用户余额。CC Switch 继续服务 Claude Code 等其他客户端，与 HClaw 互不干扰。

**Considered Options**: 流量走 CC Switch 代理——它只转发「当前激活」的一家供应商且无切换 API，HClaw 要做多家路由就得反向操纵它的库，脆弱且语义倒置，弃。
