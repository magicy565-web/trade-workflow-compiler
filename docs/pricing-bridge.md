# 定价引擎 → 工作流报价交接（v0.5）

适配目标：`magicy565-web/trade-pricing-engine` v0.2.0，验收源码提交 `5870194415e4eef928a15cc5c26d4bb4ba26b542`。

## 业务范围

定价引擎负责案例、成本、政策、计算、财务审批和内部定稿。TWC 读取已定稿报价，固定对客内容、审核收件人并授权一次发送；之后复用现有回复、待办与成果证据流程。

`issued` 表示定价引擎内部定稿，`delivery_status: NOT_SENT` 表示没有邮件发送证据。TWC 必须取得实际网关回执才能记录发送结果；这也不等于送达或成交。TWC 不代替定价审批，也不自动创建询盘、计算价格或更改价格政策。

旧 `QuoteDraftV1` 的整数分金额无法无损承载高精度单价。本版新增 `PricedQuoteV1`，数量、单价、总额都保持原始十进制字符串，支持定价引擎的币种、贸易条款、地点、付款条件、交期和有效期。TWC 不重新计算或四舍五入。调度预算仍是 USD 微元，与报价币种独立。

## 配置

1. 启动定价引擎，准备一个真实且仍有效的 `issued` 报价。为 TWC 提供该实例的独立 `viewer` 令牌；admin、agent、approver 令牌均被适配器拒绝。
2. 在 TWC 本地 `.env` 中配置 `TWC_PRICING_VIEWER_TOKEN` 和独立的 `TWC_PRICED_GATEWAY_SECRET`。不得把值填入企业事实、Registry 或请求正文。
3. 将 `config/pricing-binding.example.json` 的两个条目合并进现有 `data/capabilities.local.json`。修改真实 endpoint、TWC `tenantId` 与定价实例 `pricingTenantId`；同名能力只能有一条。样例保持 disabled，管理员完成接线后才改 enabled。
4. 配置真实的 `replies.classify` 只读能力；询盘报价流程在等待买家回复后需要它。未配置会阻止编译。
5. `npm run doctor` 检查对应能力的结果。它会同时报告其他 disabled 能力并返回退出码 2；无需为通过全局 doctor 而开启无关能力。健康结果仅验证协议和 viewer 身份，不验证具体报价或真实发送。
6. 重启 TWC，重新编译和发布。既有流程绑定哈希不会静默改变。

端点只允许 HTTPS，环回地址允许 HTTP；不允许 URL 凭证、fragment、query 和重定向。密钥在管理员配置的远端服务中使用，不能从业务输入指定端点。

## 业务输入

工作台选择“询盘报价”，企业名称必须与定价引擎 seller 完全一致。在“企业事实与业务输入”的 JSON 内添加：

```json
{
  "pricingQuote": {
    "quoteId": "填写真实报价编号",
    "customer": "填写报价中的完整客户名称",
    "to": "由操作员确认的真实收件邮箱"
  }
}
```

以上是字段说明，不能作为真实业务提交。报价编号必须符合定价引擎标识符格式。API 对应位置是 `context.facts.pricingQuote`。

定价引擎对客投影不含邮箱，因此邮箱与客户的关联仍由操作员明确提供，并由独立审批人核对；系统不能证明这个邮箱属于该买家。租户映射、seller、customer、quote ID 必须一致。只能读取 `GET /v1/me` 与 `GET /v1/quotes/{id}/customer`；不会调用包含内部成本的报价详情端点。

流程：导入并固定正文 → 独立批准具体内容 → 重新验证 → 网关发送 → 等待回复。没有 `pricingQuote` 的既有询盘流程保持原行为；本功能不会使旧 `quote.prepare` 自动获得定价引擎认证。

## 发送前复核与网关契约

TWC 在外部动作持久化派发之前重新读取完整对客投影、检查状态和有效期，并重新渲染正文。只要任何字段、收件人或正文不再等于已批准内容，就停止。读取失败、撤回、成本证据撤销、案例修订或政策变化导致定价引擎拒绝返回时，同样停止。此时没有调用发送接口，运行是 `FAILED`，不能解释为已发送。

网关 `GET /health` 必须声明：

```json
{
  "status": "ok",
  "idempotency": "durable",
  "capabilities": [
    {"id": "quote.send_priced", "version": "1.0.0", "pricingValidation": "before_send"}
  ]
}
```

`POST /execute` 输入是完整 `PricedQuoteV1`。除通用网关的认证、授权、幂等、拒收检查外，网关必须：

- 使用自己预配置的租户与定价 viewer 凭证，直接向定价引擎核验；不得接受请求中的任意远端地址。
- 在实际提交给邮件提供方前，检查当前报价仍 `issued`、未过期，seller/customer 匹配、完整对客投影等于 `input.quote`，其规范化 SHA-256 等于 `input.pricing.customerHash`。
- 原样发送已批准的 `input.to/subject/body`，不可用 Worker 重写价格、条件或收件人。对照 TWC 固定正文渲染或使用同一适配器 `validateForDispatch`，避免正文与报价投影不同。
- 返回通用 `completed` envelope、`SendReceiptsV1` 输出，并在 envelope 顶层增加 `pricingCustomerHash`，值必须等于本次复核的哈希。哈希规则是 `src/util.ts` 的递归按键排序 JSON + UTF-8 SHA-256，金额字符串必须保留。

“声明支持”不能证明网关确实执行了检查。本仓库没有生产邮件网关实现；现场需要验证实际实现与提供方幂等机制。TWC 和定价系统没有跨系统事务，最后复核与提供方提交之间仍可能发生撤回；若需要严格原子撤回保障，必须扩展定价侧的发送授权/锁定协议，本版不声称已消除这个竞争窗口。

外部请求发出后，超时、错误回执或缺失哈希属于 `NEEDS_RECONCILIATION`，不能自动重发。人工对账仅确认已经发生的提供方结果，不重新授权过期报价。`quote_sent` 可引用新能力的有效回执，仍须成果审核，不能自动计为订单。

## 复现验证

核心测试：`npm run check`。实际跨项目测试还需单独安装定价仓库锁定的 Python 依赖：

```sh
TWC_PRICING_SOURCE=/absolute/path/trade-pricing-engine \
TWC_PRICING_PYTHON=/absolute/path/trade-pricing-engine/.venv/bin/python \
npm run test:pricing
```

PowerShell：先分别设置 `$env:TWC_PRICING_SOURCE` 和 `$env:TWC_PRICING_PYTHON`，再运行 `npm.cmd run test:pricing`。

该命令启动真实的定价 FastAPI 服务、TWC Engine 和隔离 HTTP 记录网关，临时数据库只包含标记的合成测试报价；验证已批准但未定稿拒绝、原始投影一致、二次审批、发送前复核、撤回后零派发、等待状态不重发。没有凭证时直接报错，不伪装成通过或跳过。测试代码和定价仓库 tests/helpers.py 仅用于隔离验证，生产入口不加载它们。
