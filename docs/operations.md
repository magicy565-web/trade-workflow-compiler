# 本地部署与运维

## 启动、重启和配置

首次 `npm run init` 只生成本地凭证及关闭的能力清单，重复初始化会拒绝覆盖令牌。`npm start` 使用可选 `.env`。PORT 默认 8787，HOST 默认回环。Registry 与 auth 启动时加载，修改配置后重启；不要认为修改文件即可热更新权限。

数据目录默认 `data`，可通过 `TWC_DATA_DIR` 指向独立持久磁盘。SQLite 文件名以实际配置与 `src/server.ts` 为准：`twc.sqlite`。请勿将数据目录放公共网页根目录。

先用 `npm run doctor` 验证实际接入。所有能力被禁用时退出码 2 是预期；编译 blocked 时 CLI 退出码同为 2。程序不自动安装 OpenMausBot、登录邮箱、生成模型凭证或打开公网端口。

## Docker（配置已提供，当前环境未构建验收）

```sh
docker compose build
docker compose run --rm twc node dist/cli.js init
docker compose up -d
docker compose logs twc
```

默认只映射宿主机回环 8787，数据用持久 volume，进程非 root。首次初始化 auth 文件位于 volume 的 `/app/data/auth.local.json`。由管理员在本机容器终端读取并安全分配；不要把令牌贴到共享日志或聊天。

镜像使用 Node 24 Debian slim 标签，未固定镜像 digest；生产部署应构建、审核并固定自己的镜像。镜像不含 OpenMausBot；Windows 本地 exe 路径不能在容器内执行。与其他容器通信需要明确 TLS/网络设计，不应直接解除远端 HTTP 限制。

## 备份

最简单可审计方式：停止服务，等待当前本地进程退出，然后备份整个数据目录及私有配置，确认 SQLite 相关 WAL/SHM 文件一致。恢复时使用同一版本程序和匹配的 Registry/凭证。不要在运行中仅复制主 SQLite 文件而丢失 WAL。

生产备份应使用 SQLite 在线 backup 或安全停止快照方案；本版没有附加自动备份服务。做恢复演练，检查 `/api/audit`，并对所有中断的外部动作与提供方对账。审计链有效不表示原始事实真实。

## 升级

当前只有初始数据库 schema v1，没有 PostgreSQL 迁移脚本或多版本自动迁移。升级前备份并在副本验证。流程定义和运行快照不可变；Registry 变化会使绑定哈希不匹配的流程停止，重新编译、审批后才能恢复新流程。

## 异常处理

| 状态 | 处理 |
|---|---|
| blocked | 补真实企业信息、预算或实际能力绑定，重新编译 |
| WAITING_APPROVAL | 独立 approver 核对内容后决定；不要用管理员绕过 |
| WAITING_EVENT | 检查真实来源、ingest 权限和 correlationId，不要伪造回复推进 |
| FAILED | 查看错误码、权限和来源；修复后按业务状态决定是否新建运行 |
| NEEDS_RECONCILIATION | 去提供方查询原始稳定键/回执，独立人审后提交对账；绝不盲目重发 |
| CANCELLED | 后续本地调度已停止，但远端已经收到的任务须另行检查 |

网关已真实发送但 TWC 未收到回执，是正常必须处理的分布式不确定性，不是可以安全自动重试的普通失败。

## 可选 Temporal

见 `integrations/temporal/README.md`。切换时必须停止 embedded 调度并设 `TWC_SCHEDULER=external`，只给可选 worker 专用 worker token，不给 approver/operator token。该包没有在此次环境安装构建或实服验证；启用前独立验收。

## 容量与安全

推荐一企业一实例，少量受控运行。没有压力测试、SSO、完整限流、数据库加密、跨区域 HA 或 SaaS 级租户资源隔离的验收。公开服务前配置反向代理 TLS、认证限制、访问日志脱敏、磁盘配额、备份监控及秘密轮换。不要让公网直接访问未加固的 Node HTTP 监听。
