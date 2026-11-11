# 商业成果证据账本 · v0.3

目标是明确区分“Worker 完成任务”“供应商回执”“买家真实反馈”“人工确认商机”和“实际订单事实”，**不允许 AI 自行宣布成交**。

## 身份与边界

- `admin` / `operator`：登记成果声明（仅当前租户及真实运行）。
- `approver`：独立审核；报告人不可自己审核；审核决定不可撤回、更改。
- `viewer`：只读查看统计与验收档案。
- `worker` / `ingest`：不能登记或审核成果，也不能读取账本接口。

## 证据与审查

| 声明类型 | 允许的证据类型 | 校验 |
|---|---|---|
| 已发送开发信、已发报价、已申请样品 | provider_receipt | 本运行完成的动作节点与非空回执关联 ID |
| 买家回复 | business_event | 本运行已经消费的 `buyer.reply_received` |
| 收到 RFQ | business_event 或 external_record | 已消费回复 + 分类结果是 rfq；或单独的 HTTPS 文档指针 |
| 样品反馈 | business_event 或 external_record | 已消费 `sample.update` 或 HTTPS 文档指针 |
| 合格商机、订单确认 | external_record | 人工提交 HTTPS 文档指针；订单金额只可选填 USD 美分 |

真实回执/事件只证明系统接收了被信任接口声明的内容，不替代提供方身份认证或真实性验证；网关必须自己认证数据源。

## API

`POST /api/outcomes`（Bearer: operator/admin）：

```json
{
  "runId": "<existing-run-id>",
  "idempotencyKey": "outcome-unique-request-0001",
  "kind": "buyer_replied",
  "evidence": {
    "kind": "business_event",
    "reference": "<consumed-event-id>",
    "note": "已经核对邮件源记录及对应的运行 ID"
  },
  "occurredAt": "2026-11-11T04:00:00.000Z"
}
```

`POST /api/outcomes/:id/decision`（Bearer: approver）：

```json
{"hash":"<evidenceHash>","approved":true,"note":"已在授权邮箱中人工核验该条真实回复与联系人"}
```

读取：`GET /api/outcomes?limit=200`、`GET /api/outcomes/summary`、`GET /api/runs/:id/outcomes` 和 `GET /api/runs/:id/dossier`。所有路径强制租户隔离。

## 统计解释

- `humanReviewedByKind`：人工审核通过的“声明”计数，而不是已获得独立佐证的真实收入。
- `humanReviewedOrderValueUsdMinor`：人工审核通过的“订单文档标称金额”之和；**不是到账款项**。
- `reportedProviderCostMicros`：执行网关或 Worker 返回的成本上报，**不是账单**。
- 验收档案 `manifestSha256`：用于传输前后检查档案一致性，**不是电子签名或独立可信时间戳**。

订单或商机纠纷、客户撤销、重复支付、跨账期财务确认均需企业的 ERP/CRM 或会计系统另行建立正式数据源，不应在本模块中推定事实。
