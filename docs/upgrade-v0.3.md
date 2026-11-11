# 从 v0.2.0 升级到 v0.3.0

1. 停止旧服务与 Worker，确认数据库没有被写入。
2. **完整备份** `data/`（包含 SQLite WAL/SHM）与 `.env`。Windows 下须先停止服务才复制文件。
3. 将新版解压到**新的目录**，复制旧 `data/` 与 `.env`。禁止覆盖 `auth.local.json`、`capabilities.local.json`、`event-sources.local.json`。
4. 运行 `npm.cmd test` 然后 `npm.cmd start`。已有身份文件时不要 `init`。
5. 首次启动自动执行 schema 2 → 3：新增 `outcomes` 表及唯一证据索引，保留旧运行/审批/事件/批次数据。
6. 核对 `/api/runs`、`/api/approvals`、`/api/events`、`/api/batches`；成果账本初始为空，这是正常状态，**不能把旧运行自动计算为商机**。

schema 3 不能由 v0.2/0.1 程序直接打开。需要回滚时，停止服务、恢复升级前完整数据库和代码，并同业务网关对账，以免重复商业动作。升级代码未自动改变原有发送审批和授权配置。

本地基线回归覆盖 schema 1/2 迁移与审计保留；生产现场及 Windows 实机升级仍需操作人员验收。
