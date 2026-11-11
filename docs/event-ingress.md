# 受信任业务事件入口（v0.2）

## 选择接入方式

保留 `POST /api/events`，必须使用独立 `ingest` Bearer 凭证。新增 `POST /api/webhooks/{sourceId}`，供企业自己的可信邮件/样品网关回调；**不是已经实现 Gmail、Microsoft 365、SendGrid 等渠道的原生通知适配。** 原生渠道的认证、邮件获取和字段规范化仍由受控网关负责。

新增的 webhook 默认关闭。`npm run init` 生成的 `data/event-sources.local.json` 为 `[]`。升级用户没有此文件也按关闭处理。接线时参考 `config/event-sources.example.json`，配置实际租户、sourceId、密钥环境变量并在完成网关验收后启用。密钥至少 32 字节，使用随机生成的值；存放 `.env` 或企业密钥管理，不放源代码或配置样例。

## 规范化事件 JSON

仅接受四个顶层字段：`id`、`type`、`correlationId`、`payload`（租户由服务端配置确定，不能在请求中传 `tenantId`）。其中 `type` 仅为 `buyer.reply_received` 或 `sample.update`。payload 按相应契约校验。

- `id`：源系统稳定的事件 ID。重复回调必须沿用原 ID；同一 ID 改正文会返回 409。
- `correlationId`：之前真实发送/提交回执中 TWC 收到的关联标识；每个运行必须唯一，不可给不同客户复用同一个 provider thread ID。
- `payload`：买家回复使用 `BuyerReplyV1`；样品进度使用 `SampleUpdateV1`，见 `src/contracts.ts` / `schemas/`。

服务端按 sourceId + 外部事件 ID 生成稳定的内部 ID，并保留 `sourceId`、`externalId`。不同事件源的相同事件 ID 不会碰撞。

## 签名

请求头：

```
x-twc-timestamp: Unix 秒数字符串
x-twc-signature: sha256=<64 位小写十六进制 HMAC>
Content-Type: application/json
```

签名内容严格为以下字节序列，JSON 不能在签名后重新序列化：

```
UTF8(timestamp + "\n" + sourceId + "\n") + 原始 HTTP body 字节
```

入站 webhook 的签名格式与旧的出站 `/execute` 网关协议不同（出站是毫秒时间戳加点号）；请使用对应文档与独立密钥，不要混用签名助手。

算法 HMAC-SHA256，允许服务器时间前后 300 秒。过期或无效签名返回 401。时间窗口内的重复投递由数据库事件 ID 幂等处理。最大请求体为 1 MB。服务端与网关应正确校时，并通过 TLS 或受控的本机回环通信。

已提供实际投递脚本，不生成假事件：

```powershell
node --env-file-if-exists=.env scripts/send-event.mjs https://YOUR-HOST/api/webhooks/mail-gateway .\actual-event.json TWC_MAIL_EVENTS_SECRET
```

替换地址，文件内容来自真实网关；密钥仅从环境变量读取。脚本验证 payload、签名并输出 HTTP 结果，不打印密钥。

## 事件状态

`unmatched`：回执尚未登记，先保留事件。`ready`：已匹配运行和预期邮箱，可以供等待节点消费。`quarantined`：邮箱不匹配、事件早于运行或运行已关闭，保留给人工核对。`consumed`：已被运行消费。收件箱支持分页和重新校验；重新校验不会改正文、改收件人或跳过签名。

邮件 `from` 与已审批收件人匹配**不是**真实发件人身份认证。HMAC 只能证明此请求来自持有网关密钥的一方。网关必须自行完成来源验证、防伪、必要的邮件鉴权检查，并且不能允许不可信来信内容触发工具调用。

## 核验边界

已做本地 HTTP 签名、篡改、过期、重复、冲突、归属隔离、提前事件和重启测试；远端邮件/样品渠道尚未接入。实现采用 Node.js 的 `createHmac` / `timingSafeEqual`，参考官方文档：<https://nodejs.org/api/crypto.html>。SQLite 使用参考：<https://nodejs.org/api/sqlite.html>。

## v0.4 人工跟进

运行已结束，但关联回执、收件人及时间校验均通过的后续事件，在保留 `quarantined` 状态的同时生成唯一人工待办。领取或处理待办不将事件标记为 `consumed`，不重新启动原运行，也不让该事件绕过成果账本的证据规则。详见 [跟进队列](followups.md)。
