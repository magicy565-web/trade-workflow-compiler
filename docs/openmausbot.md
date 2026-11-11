# OpenMausBot 接入

## 核对依据

适配器依据公开源码 commit `613ed01fdc2b04860ef63e3dbdcb46d7e6b1666d` 的 MCP 契约编写，而不是猜测私有 HTTP 路由：

- https://github.com/milind-soni/OpenMausBot/blob/613ed01fdc2b04860ef63e3dbdcb46d7e6b1666d/docs/mcp-server.md
- https://github.com/milind-soni/OpenMausBot/blob/613ed01fdc2b04860ef63e3dbdcb46d7e6b1666d/scripts/mcp-server.ts

只使用 `get_system_health`、`list_bots`、`create_task`、`send_bot_message`、`wait_for_conversation`、`get_bot_messages`。启动时检查工具存在及参数契约。真实部署应固定你验收过的 OpenMausBot 版本；后续上游变更需重新跑协议和现场测试。

**本次没有连接用户的真实 OpenMausBot。** 已测试的是实际 stdio 子进程 JSON-RPC 通信与合成协议响应，不是你的 bot 完成了真实业务。

## 本地 Windows 配置

在 `data/capabilities.local.json` 找到 `market.research` 等只读能力，并按实际安装位置添加 binding。结构示例见 `config/openmausbot-binding.example.json`；默认仍关闭。对于已安装桌面版，可使用 `OpenMausBot.exe` 及相邻 `resources/server/mcp-server.js`，设置 `ELECTRON_RUN_AS_NODE=1`。路径必须来自本机真实安装，不能照抄占位符。

由于 Node 启动子进程不走 shell，Windows 不建议把 `.cmd` shim 当成可执行文件。使用真实 `node.exe` 加本地 MCP 脚本路径，或桌面应用 exe 加其内置脚本路径。不要设置 `shell:true` 来拼接未审查命令。

官方 MCP 文档说明了 Settings → Phone 的配对流程。用本人授权的本地会话获得 `OPENMAUSBOT_TOKEN`，同时明确设置 `OPENMAUSBOT_URL` 或 `OMB_PORT`；不要让凭证参与盲目端口探测。TWC 从环境变量白名单传入 MCP 子进程，Registry 本身不存 token。

## 必须实际实施的权限边界

为研究/草稿任务准备单独 bot，移除发送邮件、下单、付款、任意 shell 等危险工具。确认后才将 `readOnlyProfileAttested` 改为 true 并启用能力。这是管理员声明，不是 TWC 已审计全部远端权限。角色提示词只是额外约束，不能代替真实工具授权。

`outreach.send`、`quote.send`、`sample.request` 永远不能映射到通用 bot；Registry 会拒绝。外部商业动作必须走有明确、可校验副作用边界的网关。

## Worker 输入与输出

Worker 收到原始 `enterpriseContext`、`businessRequest`、本步骤 input、capability、固定 outputContract 和 outputSchema。只允许返回：

```json
{
  "requestId": "<收到的requestId原样返回>",
  "contract": "<收到的outputContract原样返回>",
  "data": "<符合outputSchema的JSON对象；这里的字符串仅说明占位>"
}
```

真正的 data 必须是 Schema 要求的对象，不能把“已完成”自然语言当作回执。结果来自错误 requestId、错误契约、无结构化来源或无合法数据时会失败。

首次 `create_task` 只创建空会话，先落盘 task ID 再发送工作。`send_bot_message` 使用固定的 64 位十六进制 send_id；丢失应答时复用同一个 ID。等待阶段只有 job `state: completed` 被接受；`status: settled` 不意味着任务成功。idle、failed、stalled 不会被伪装成完成。

OpenMausBot 内部出现人工输入、配对、权限卡等请求时，TWC 会停止当前任务。它没有批准 OpenMausBot 内部权限的能力；必须由人在原应用处理。本版不实现自动恢复这些内部卡片；修复原因后由人决定重新启动业务运行。

## 配置变更与验收

```sh
npm run doctor
```

doctor 校验进程通信、工具列表、服务身份和 bot ID；不证明业务效果、只读权限或所有来源真实。先使用内部数据及本人控制的收件人验收，不要首次接线就运行真实买家批量开发。

Docker 核心镜像没有打包 OpenMausBot/MCP 可执行文件。选择在宿主机运行 TWC，或者明确安装 MCP 客户端到容器；不能把宿主机 Windows exe 路径当成 Linux 容器路径。
