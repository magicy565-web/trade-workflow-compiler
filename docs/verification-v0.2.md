# v0.2.0 实际开发与验收记录

日期：2026-11-11。基线为用户提供的 v0.1.0 ZIP 和 Git bundle，原提交 `35f70c1`。本版沿用原仓库历史，不是另起一套模拟项目。

环境：Linux x64、Node.js 22.16.0、TypeScript 5.8.3、@types/node 22.19.7。开发编译使用环境中已安装的对应工具；分发包无需 node_modules 即可运行。

## 已完成的功能

- 多买家筛选后进入 BATCH_READY，显式选择客户，同一事务拆分独立客户任务并停止原任务。
- 子任务独立内容审批、发送回执、等待回复、分类；研究只做一次，继承结果明确标记来源。
- 共用原授权预算，保留原授权截止时间；并发预留、发布版本完整性、暂停、恢复、取消和不确定动作对账保护。
- 起草/发送收件人范围校验，回执与审批收件人匹配，correlationId 唯一归属，禁止串单。
- 持久化事件收件箱：提前事件保留，错误归属隔离，消费状态、分页、重检、后续回复保留给人工处理。
- 默认关闭的 HMAC 签名入口、时间窗口校验、源系统事件 ID 去重与冲突检查；从真实 JSON 文件投递的脚本。
- 中文界面的批次选择、共享预算与逐客户状态、暂停/恢复/取消、事件收件箱及真实回执对账表单。
- 增量数据库迁移和 v0.1 → v0.2 升级/回滚操作说明。

## 实际检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 原始基线复跑 | 原 80 项通过 | 本次接手时在原 bundle 上执行 |
| TypeScript 类型检查和构建 | 通过 | `reports/check.txt` |
| 当前单元与本地集成测试 | **117 项通过，0 失败，0 跳过** | `reports/tests.tap` |
| 无 node_modules 干净分发目录 | **117 项同样通过** | `reports/clean-distribution-tests.tap` |
| 干净目录实际启动 | 初始化、健康检查版本 0.2.0、真实 HTTP 编译 blocked、12 个能力全部默认关闭、空批次与事件收件箱、正常退出均通过 | `reports/clean-startup.json` |
| 双客户完整运行 | 独立审批、独立回复、研究不重复、源任务不发送、共享预算和审计通过 | `test/batches.test.mjs` |
| 批次事务故障 | 故意在第二个成员插入时触发 SQLite 故障，全部子任务和批次回滚，原任务保留 | `test/batches.test.mjs` |
| 实际本地 HTTP 签名回流 | 正常签名、篡改、过期、重复、内容冲突、跨租户、错误邮箱、关联回流通过 | `test/api-v02.test.mjs` |
| 不确定发送与恢复 | 不自动重发、暂停批次、保留回执对账；重启保存审批和任务 | `test/batches.test.mjs`、原 `test/runtime.test.mjs` |
| 使用原始 v0.1 ZIP 的跨版本升级 | 真实 schema 1 数据库升级到 2；原运行加载时不变、审批保留、旧待消费事件恢复并完成、0 次发送重派发、审计有效 | `reports/v1-upgrade-check.json` |
| 浏览器及投递脚本语法 | `node --check public/app.js`、`node --check scripts/send-event.mjs` 通过 | 本地执行 |

以上“发送/回复/研究”测试中的业务输出均由**明确标记的测试 fixture**提供。测试启动了实际 Node HTTP 服务和 SQLite，并非只检查静态函数；但没有调用用户的真实 OpenMausBot、邮箱、模型或样品服务。它证明已覆盖情形下的代码行为，不证明生产订单、线索或收入已发生。

## 未完成 / 未验证

1. **GitHub 远程仍未创建、未推送，GitHub Actions 未运行。** 本版交付本地 Git 提交、完整历史 bundle、源码 ZIP 和本人电脑执行的发布脚本。当前工具未提供创建仓库动作，不把本地提交写成远程发布。
2. **完整浏览器 E2E 未通过验收。** Chromium 导航本地服务返回 `ERR_BLOCKED_BY_ADMINISTRATOR`，没有绕过环境策略。记录在 `reports/browser-check.json`。因此不能声称批次按钮、审批表单和移动端交互已在浏览器端完成验证；相关后台 API 已通过本地 HTTP 测试。
3. 未连接真实 Worker、邮箱、网关、Webhook 来源或供应商，没有外发商业邮件、下单或模型费用。HMAC 只认证受信任网关，不代替来信的真实来源验证。
4. npm registry DNS 失败（EAI_AGAIN），新的 `npm install` 未完成，没有生成完整 lockfile或执行依赖漏洞审计。编译使用本环境已有的声明版本工具，运行包无需安装 npm 依赖。记录见 `reports/dependency-install-attempt.txt`。
5. 可选 Temporal 包仍未完成 SDK 构建或真实服务联调；尤其未实现批次子任务的 Temporal 启动/signal bridge。v0.2 使用已测试的内置调度模式；external 模式需要调用方推进每个子运行。
6. Windows、Docker、持续负载、渗透测试、邮件送达率、业务收益和企业生产级 SLA 尚未验证。
7. 每个客户子任务仅自动处理首条有效回复；后续回复入收件箱人工处理。不含自动多轮销售对话、自动报价承诺、邮件服务原生 OAuth 或 CRM。

历史 v0.1 的日志和截图只保留在 `reports/v0.1.0/`，**不能用来证明新版 UI 通过验收**。新增验收记录位于 reports 根目录。

## 安全升级

先停旧服务、完整备份 data/ 和 .env，再复制到新版本目录启动。已有凭证不要重新 init。schema 2 不能由旧程序直接打开，回滚必须恢复旧备份并先与真实网关对账。详见 `docs/upgrade-v0.2.md`。
