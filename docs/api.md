# HTTP API v1

服务默认 `http://127.0.0.1:8787`。除静态资源和 `/health` 外，所有请求使用 `Authorization: Bearer <本地角色令牌>`。写入使用 `Content-Type: application/json`；请求最多 1 MiB。服务器从令牌确定 tenantId、userId、role，不接受客户端冒充这些字段。

| 方法与路径 | 角色 | 用途 |
|---|---|---|
| GET /health | 无 | 本服务健康；明确返回 externalIntegrationsVerified:false |
| GET /api/me | 任意有效令牌 | 当前身份 |
| GET /api/capabilities | admin/operator/approver/viewer | 能力元信息；不返回凭证和命令 |
| POST /api/compile | admin/operator | 规则编译并保存 draft，blocked 也保存以供检查 |
| POST /api/plan | admin/operator | 显式调用配置好的模型选择模板，再执行相同校验 |
| GET /api/workflows | admin/operator/approver/viewer | 流程版本 |
| POST /api/workflows/:id/:version/publish | approver | 发布严格匹配 hash 的版本 |
| POST /api/workflows/:id/:version/revise | admin/operator | 接收完整新 spec；ID/tenant 不变，version+1 |
| POST /api/runs | admin/operator | 启动已发布版本，必须提供稳定 idempotencyKey |
| GET /api/runs | admin/operator/approver/viewer/worker | 当前租户运行 |
| GET /api/runs/:id | 同上 | 状态、原始上下文、步骤输出及证据 |
| POST /api/runs/:id/advance | worker | 推进一个状态机步骤，供外部调度器使用 |
| POST /api/runs/:id/cancel | admin/operator | 停止本地后续调度，不保证撤销远端操作 |
| POST /api/runs/:id/reconcile | approver | 外部动作不明确时，用真实提供方回执对账 |
| GET /api/approvals | admin/operator/approver/viewer | 精确内容、hash、期限 |
| POST /api/approvals/:id/decision | approver | 具体动作批准/拒绝 |
| POST /api/events | ingest | 接收真实业务事件 |
| POST /api/suppressions | admin/operator/ingest | 添加拒收邮箱 |
| GET /api/audit | admin/approver/viewer | 当前租户审计事件和链校验 |

admin 不是万能业务审批角色。发布、动作审批、对账仍要求独立 approver；worker 没有审批和事件写入权限；ingest 没有启动或发信权限。

## 编译输入

使用 `config/request.template.json` 作为结构模板。companyName、products、targetMarkets、budgetMicros 必须是企业明确提供的值。`facts` 放真正的询盘、价格表、限制条件及证据引用，不要把示例当成生产资料。可选 playbook 只有：`buyer-development`、`inquiry-quote`、`sample-followup`。

编译结果含 `status`、`intent`、`errors`、`warnings`、`workflow` 和保存后的 `definition`。HTTP 200 并不等于可运行，必须检查业务 status；只有 `ready_for_approval` 且审批发布后才能启动。

## 发布、启动、动作审批

发布正文：`{"hash":"<definition.hash>"}`。

启动正文：`{"workflowId":"<id>","version":1,"idempotencyKey":"<16-80字符稳定业务请求ID>"}`。同一 tenant 重复 key、相同版本返回同一个运行；相同 key 指向不同版本会拒绝。

动作审批正文：`{"hash":"<approval.payloadHash>","approved":true}`。审批人必须检查 `payload` 的完整收件人、正文和条款。false 表示拒绝，决定写入后不可反悔修改；需要变更内容必须创建新流程/运行并重新授权。

## 真实事件接入

事件 envelope：

```json
{
  "id": "<邮件或业务系统中稳定、唯一的事件ID>",
  "type": "buyer.reply_received",
  "correlationId": "<发送网关回执中相同的correlationId>",
  "payload": {
    "from": "<真实发件人邮箱>",
    "subject": "<真实主题>",
    "body": "<真实正文>",
    "messageId": "<原始邮件message-id>"
  }
}
```

这里的尖括号值仅说明字段，不是可提交的真实记录。`sample.update` 的 payload 见 `schemas/SampleUpdateV1.schema.json`。

接入层应验证邮件/网关真实性、事件签名和来源收件关系，再用独立 ingest key 调用本接口。TWC 没有直接对 Gmail、IMAP 或供应商 webhook 做认证。不能把公开用户提交的任意文字当作已核实的买家回复。对退订事件先调用 suppression：`{"email":"<真实邮箱>","reason":"<退订来源引用>"}`。

## 异常对账

正文：`{"output":<符合该动作输出契约的真实回执>,"providerEvidence":"<真实提供方回执或事故编号说明>"}`。只能用于 NEEDS_RECONCILIATION。人工确认动作已发生并提交结果后才进入后续步骤；不提供“不知道，重发一次”的按钮。

## 错误

常见 400 输入/Schema、401 缺令牌、403 角色/来源限制、404 找不到、409 状态/哈希/重复冲突、413 大请求。内部错误不把上游凭证或完整异常堆栈返回客户端。模型和网关调用的外部日志由部署者脱敏。

接口暂未分页，适合小规模独立实例；不要在没有容量测试的情况下当成大规模 SaaS 使用。

## v0.2 批次与事件 API

| 路径 | 权限 | 用途 |
|---|---|---|
| `GET /api/runs/:id/batch-preview` | admin/operator/approver/viewer | 查看 BATCH_READY 的真实候选与预算，拒收或重复邮箱不可选 |
| `POST /api/batches` | admin/operator | `{sourceRunId, recipients: string[], idempotencyKey}`，原子创建子运行 |
| `GET /api/batches` | admin/operator/approver/viewer | 最近 100 个批次的状态、预算与计数 |
| `GET /api/batches/:id` | admin/operator/approver/viewer | 批次及独立客户任务 |
| `POST /api/batches/:id/pause` | admin/operator | 阻止后续调度，不取消在途动作 |
| `POST /api/batches/:id/resume` | admin/operator | 恢复；存在未对账动作或已取消时拒绝 |
| `POST /api/batches/:id/cancel` | admin/operator | 取消尚未结束任务，在途外部动作转人工对账 |
| `GET /api/events?before=<cursor>&limit=100` | admin/operator/approver/viewer | `{items, nextCursor}`，分页收件箱，单页最多 100 |
| `GET /api/events/:id` | admin/operator/approver/viewer | 原始事件及归属校验状态 |
| `POST /api/events/:id/recheck` | admin/operator | 重新运行校验，不允许修改或强行改绑 |
| `POST /api/webhooks/:sourceId` | 源配置与 HMAC | 服务端固定租户的受信任事件入口，无 Bearer 自动授权 |

创建批次不批准邮件内容。具体内容仍走原 `/api/approvals/:id/decision`。不确定结果仍走原 `/api/runs/:id/reconcile`，需要独立 approver 提供 `{output, providerEvidence}`。收到回执后会再次验证收件人与关联标识。

`GET /api/runs` 仍是最近 500 个运行的视图，不能当成无限历史导出；批次详情列出该批次全部成员（最多 50）。完整运行保存在本地数据库。事件收件箱不使用这项 500 条运行视图限制。
