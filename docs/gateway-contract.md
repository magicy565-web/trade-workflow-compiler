# 受控商业网关协议

TWC 自带通用客户端，不内置邮件账号、SMTP、CRM 或样品系统服务端。网关应由企业已有服务或新接入层实现。本协议不是 OpenMausBot 原生 API。

## 为什么不能让主控直接发信

研究 Worker 的自然语言输出不是“已授权商业动作”。TWC 只在独立 approver 批准具体输入后，调用固定 capability 对应的网关。网关必须再次执行最小权限、收件人校验、拒收、预算和账号策略。不要让它把请求自由转给一个拥有所有权限的通用 Agent。

## Binding

本地 Registry 配置 `adapter:http`、base endpoint、secretEnv。远程必须 HTTPS；localhost 可以 HTTP。共享秘密至少 32 个字符，存环境变量，不进请求正文或 Git。示例只含 disabled 配置，见 `config/gateway-binding.example.json`。

## GET {base}/health

带 `Authorization: Bearer <secret>`。需要返回：

```json
{
  "status": "ok",
  "idempotency": "durable",
  "capabilities": [{ "id": "outreach.send", "version": "1.0.0" }]
}
```

这是协议结构示例，不表示已经有真实服务。必须同时匹配 capability ID 与版本。广告宣称 durable 并不能证明实现正确，现场验收需要检查网关自身事务、唯一键和提供方回执。

## POST {base}/execute

Headers：

```text
Authorization: Bearer <secret>
Content-Type: application/json
Idempotency-Key: <稳定64位SHA256键>
X-TWC-Timestamp: <Unix毫秒>
X-TWC-Signature: <HMAC-SHA256(secret, timestamp + "." + raw-body)的hex>
```

正文含 `idempotencyKey`、`tenantId`、`runId`、`stepId`、`capabilityId`、`capabilityVersion`、`input`、`context`、`businessRequest`、`maxCostMicros`。固定 schema 见 `schemas/`。context 是不可变企业事实；业务动作只能使用已经审批的 input，不能根据其他信息擅自改收件人、正文、价格或下单数量。

服务端应恒定时间验证凭证与 HMAC，验证时间偏差、raw body、稳定 key，拒绝重放键对应不同 payload。密钥与租户/能力/账号绑定；不能相信任意传入 tenantId 就授予相应账户权限。

业务幂等必须持久化在服务端数据库：先用唯一键预留动作，再调用支持幂等的提供方，并保存原始回执。仅缓存 HTTP 应答或“先发邮件后插入成功表”无法保证崩溃后不重复。无法证明是否已发送时，返回不明确状态并由人工核对，不要自行重发。

成功响应：

```json
{
  "status": "completed",
  "idempotencyKey": "<原始稳定键>",
  "output": "<符合能力输出契约的真实对象>",
  "actualCostMicros": 0
}
```

`output` 应为对象，以上字符串仅解释字段。`actualCostMicros` 可省略；0 只能表示提供方确认确实没有该笔计费，不能作为不知道成本的替代。

`outreach.send` 与 `quote.send` 输出 `SendReceiptsV1`：**一个收件人、一条真实提供方回执和唯一 correlationId**；样品提交输出 `SampleReceiptV1`。输出中“acceptedAt”只证明提供方接收，不证明送达、打开、成交或产生收入。

TWC 在有限 HTTP 超时内只接受明确 completed 回执；pending、非 JSON、错误 key、无效输出或通信错误会让外部动作进入 NEEDS_RECONCILIATION，不自动重复调用。现有网关若是异步队列，需设计自己的持久化回执/人工对账流程；不要把“进队列”包装成邮件已发送。

## 事件回流

邮箱/供应商集成验证真实来源后，用独立 ingest token 调用 TWC `/api/events`。发送回执 correlationId 必须与真实线程/业务实体稳定关联。同一个批次不能共用 correlationId 后把所有人的回复混入一个运行。退订要立即调用 `/api/suppressions`。

## 现场验收必须检查

授权输入完全一致、秘密不落日志、错签名拒绝、重复同键返回同一回执、重复键不同内容拒绝、网关崩溃窗口不重复、真实退订阻断、实际费用返回、错误提供方响应不变成成功。

本仓库的本地 HTTP fixture 测试覆盖客户端协议处理，不代表你的实际邮箱网关已经通过这些生产验收。
