# v0.1.0 实际验收记录

日期：2026-11-11。环境：Linux x64、Node.js 22.16.0、TypeScript 5.8.3。本文记录已执行的检查，不把代码存在、协议模拟或待接线能力当成生产验证。

## 已完成检查

| 检查 | 实际结果 | 证据 |
|---|---|---|
| TypeScript 类型检查与构建 | 通过 | `reports/check.txt` |
| 核心测试 | 80 项通过；0 失败、0 跳过 | `reports/tests.tap` |
| 无 node_modules 的干净分发副本 | 同样 80 项通过 | `reports/clean-distribution-tests.tap` |
| 原生 HTTP 与 SQLite | 实际启动服务、初始化独立随机角色令牌、运行状态持久化、认证与接口流程检查通过 | `test/api.test.mjs`、`test/runtime.test.mjs`、`reports/verification.json` |
| 未接线状态 | 编译 blocked；12 项能力全部 not ready；不自动执行 | `reports/verification.json` |
| 中断/重复/审批保护 | 重启恢复、事件去重、角色检查、内容哈希、拒绝审批不发送、不明外部动作不重发 | `test/runtime.test.mjs` |
| OpenMausBot 协议 | 实际子进程 stdio JSON-RPC、工具参数、send_id、完成状态及结果身份检查通过；服务端为明确标记的合成 fixture | `test/adapters.test.mjs`、`test/fixtures/mcp-server.mjs` |
| HTTP 网关协议 | 实际本地 HTTP 通信，认证、HMAC、稳定键、回执校验；网关为测试 fixture | `test/adapters.test.mjs` |
| 可选模型解析协议 | 严格输出、原文证据和禁用工具测试通过；没有调用真实付费模型 | `test/adapters.test.mjs` |
| 静态界面 | Chromium 渲染真实 HTML/CSS，桌面与 390px 移动视图正常；移动端无水平溢出 | `reports/ui-check.json`、界面 PNG |
| 干净副本启动 | 不安装 npm 依赖，初始化、健康检查、登录身份、实际 blocked 编译、SQLite 文件及 SIGTERM 正常退出均通过 | `reports/verification.json` |
| 脚本语法 | 浏览器 JS、GitHub 发布脚本通过 Node 语法检查 | 本地执行 `node --check` |

核心测试覆盖三个完整状态机闭环，但业务 Worker 和外部服务输出来自合成 fixture。它验证实现的状态与安全逻辑，不证明真实买家、邮件、询价、样品或订单已经发生。

另补充两项业务约束测试：每个 Worker 接收原始企业资料与需求；v1 拒绝多收件人草稿，避免只等待第一条回复而丢弃其他客户生命周期。

## 未完成或未验证

- GitHub **远程仓库未创建、未推送，GitHub Actions 未运行**。当前连接只开放读取；交付的是独立源码、本地 Git 历史及在本人电脑执行的发布脚本。
- 未连接用户的真实 OpenMausBot、模型账号、邮件账号或样品网关，没有发生外部商业发送或费用。
- 可选 Temporal 包未安装依赖、未与 SDK 完成构建、未连接真实 Temporal 服务。源代码单独交付，不计入核心通过项。
- Docker 构建和容器启动没有执行；Windows 没有现场运行验证。提供的启动命令与配置不能当成这些平台已经通过验收。
- 完整浏览器交互 E2E 未完成：浏览器策略对 localhost 返回 `ERR_BLOCKED_BY_ADMINISTRATOR`，没有尝试绕过。仅进行了静态渲染；HTTP 生命周期由原生 Node 测试验证。
- npm registry 在此环境不可达；没有执行新依赖安装、漏洞审计或生成完整 lockfile。核心用已构建产物在无 node_modules 的干净目录实测可运行。
- 没有压力测试、渗透测试、法律合规认证、收益验证或企业生产级可用性保证。

## 与原先设想的区别

此版是严格三模板编译核心，不是无边界通用业务自动生成器。默认存储 SQLite，而非 PostgreSQL；校验使用受限 JSON Schema 实现，而非 Zod；Temporal 是可选、未现场验收的调度包。没有复制或 fork OpenMausBot Runtime，没有用静态提示词假装实现持久化执行。

先验收真实只读 Worker，再接受控发送/样品网关及真实事件回流。所有必要绑定默认关闭，不能为了演示效果绕过缺失能力检查。
