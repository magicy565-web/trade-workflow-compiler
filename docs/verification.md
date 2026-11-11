# v0.5.0 开发与验证

本版完成定价引擎到报价工作流的只读交接与发送前复核，基于 v0.4 人工待办。数据库仍为 schema 4。

## 已实现

- `quote.import` 只读取定价 viewer 身份和对客报价投影；强制显式租户映射、seller/customer/quote ID 一致、已定稿、未过期。
- `PricedQuoteV1` 保留十进制字符串、币种和商业条款；固定渲染正文，不交由 Worker 改写价格。
- 工作流发布、定价财务审批、实际发送审批分别保留；发送前重新获取并比较完整内容。
- 发送网关必须声明最终定价复核能力，并回传匹配的报价哈希；派发前拒绝是 FAILED，派发后不确定结果是 NEEDS_RECONCILIATION。
- 新回执可用于待审核 quote_sent 成果记录；新能力默认关闭、旧流程不自动换用定价接入。
- 同时纳入 v0.4 审查修复：取消单任务/批次时，已到达未消费的有效回复进入人工待办，事务故障不会丢失回复。

## 实际验证

| 检查 | 结果 | 证据 |
|---|---|---|
| TypeScript 类型检查、构建、全套测试 | 159 项通过，0 失败、0 跳过 | reports/v0.5.0/check.txt |
| 定价协议专项 | 19 项：精度、身份/租户、失效、投影篡改、编译来源、撤回阻断、取消竞争、网关哈希与成果回执 | test/pricing.test.mjs |
| 单任务/批次取消回归 | 2 项，包含重复取消及事务故障注入 | test/cancel-followups.test.mjs |
| 实际跨仓库服务联调 | Python 定价 API + TWC Engine + HTTP 记录网关；全部断言通过 | reports/v0.5.0/pricing-live.json |
| Schema 导出 | 新增 PricedQuoteV1，与源码构建一致 | schemas/PricedQuoteV1.schema.json |
| 浏览器脚本语法 | node --check public/app.js 通过 | 本轮本机执行 |

跨项目定价源码来自 `magicy565-web/trade-pricing-engine` 提交 `5870194415e4eef928a15cc5c26d4bb4ba26b542`，下载文件逐个对照 Git blob SHA。独立 Python venv 安装该提交的 requirements.txt：FastAPI 0.128.2、Pydantic 2.13.5、uvicorn 0.48.0。主测试使用 Node 24.22.1、TypeScript 5.8.3；Python 为 3.12.14。

联调使用实际定价 API，测试报价经过创建、计算、提交、财务审批和内部定稿；验证仅批准未定稿不能导入、发送需要独立 TWC 审批、原始对客投影一致、网关发送前复核、等待不重复派发，以及 TWC 审批后由定价 API 撤回导致零发送调用。测试网关只记录一次合成投递，真实邮件发送数为 0。临时数据库关闭后删除，生产入口无业务种子或测试成功回退。

## 验收边界

没有实际客户报价或真实邮件账号参与本轮；没有接入生产邮件网关、实际 Worker 或 Temporal Server。HTTP health 的能力声明不能替代对网关实现的现场验收。定价复核与邮件提供方接收之间没有跨系统事务，不承诺原子撤回；严格保障需进一步扩展定价发送授权协议。

旧 Registry 不会自动新增能力。现有配置、企业名、收件人归属及远端租户映射需要部署者提供真实值。对账只确认提供方结果，不重发。

本轮只更新工作台版本与接入说明文字，没有宣称浏览器交互验收。此前浏览器自动化因系统 socket 权限阻止；详见 v0.4 历史报告。GitHub Actions 不作为本次通过证据；前一轮远端任务没有实际执行步骤，本轮不重复手动触发。

复现方法见 docs/pricing-bridge.md。历史记录：docs/verification-v0.4.md、docs/verification-v0.3.md。

## 后续开发：只读报价预检

新增 `npm run preview:quote -- <request.json> <registry.json> <tenant>`，在创建运行之前验证报价导入并预览固定邮件内容。输出明确标识无发送授权，不调用网关或创建审批。新增实际 CLI 子进程与 HTTP 服务测试，覆盖成功、撤回、租户不匹配、disabled 和密钥不泄露。最新全套 163 项通过，证据：reports/v0.5.0/preview-check.txt。
