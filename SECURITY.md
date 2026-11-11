# 安全边界

本版本不是经过第三方安全审计的企业生产认证软件。建议先在本机、受控网络和真实的内部测试收件人上验收。

## 默认拒绝

能力默认 disabled；不存在的能力、缺少输入、绑定改变、角色不符、审批缺失或过期都会阻止执行。模型不能注册新工具、改审批、调用任意脚本。外部动作不能由通用 OpenMausBot Worker 执行，必须走专用网关。

## 人与密钥

本地 `auth.local.json` 里的角色身份来自服务器配置，不来自 API 请求正文。不同 token 关联不同角色和 userId。创建流程/启动运行的人不能自己批准对应操作。真实双人审批需要两个独立人员、独立账户和独立令牌保管；本机初始化文件集中保存所有 token，仅便于首次管理员分配，不构成物理隔离。

数据库管理员、本地配置管理员和主机管理员属于可信边界：他们能修改 Registry、读取/更换凭证或数据库。审计哈希链能发现未重算的修改，不是防止整库管理员重写历史的密码学不可篡改账本。

不要提交 `.env`、`data/`、`*.local.json`、token、真实客户原文或生产 SQLite。Windows chmod 并不能代替 NTFS ACL，请自行限制 `data/` 访问。备份中含客户资料、审批内容和本地凭证，应加密保存并隔离授权。

## Worker 与网络

`readOnlyProfileAttested` 是管理员完成权限隔离后的显式声明，不是程序自动审计通过。必须在 OpenMausBot 移除 shell、发送、支付、下单等与研究无关的权限。提示词“不要发送”不能替代权限控制。

只从本地管理员配置启动 stdio MCP 命令，绝不能把用户输入拼接成 shell 或可执行路径。API 不允许上传和运行命令。HTTP 外部服务要求 HTTPS；只有回环地址允许 HTTP。应用不会跟随网关重定向。私有网络远端部署需 TLS 或在明确审核后自行调整代码；不要禁用校验凑通。

API 默认绑定回环，不提供 CORS 或 cookie 身份。需要公网访问时必须配置 HTTPS 反向代理、`TWC_PUBLIC_ORIGIN`、速率限制、日志脱敏及访问控制。本版没有成熟 SSO、令牌过期刷新、帐号锁定、接口配额、分页大数据优化或完整渗透测试。

## 商业风险与来源

对外内容审批绑定完整 payload SHA256；修改收件人、正文、报价条款都会失效。对账须来自真实提供方回执，而不是模型自述。邮件退订/拒收应由认证接入层立即写入 suppression，再进行分类处理；不要等 LLM 判断后才阻断外发。

来源文本、网页、模型输出都是不可信业务数据。结构化校验只能拒绝错误形状，不能证明来源、价格、认证或采购意图真实。收件人合法性、商业承诺、隐私/反垃圾邮件规则由部署者审核。本软件不提供保证收益或法律合规认证。

## 资源与预算

核心请求/响应有体积限制，流程有节点、时间、次数和预算限制。但本版未提供全站限流、磁盘配额或远端模型硬限费；需在反向代理、操作系统和模型账号层配置。本地调度被停止不等于已经发出的远端操作被撤销。

## 报告问题

不要在公开 issue 上传凭证、生产数据库或真实客户邮件。首次公开发布前由仓库所有者设置适当的私密安全反馈渠道；仓库不虚构安全邮箱。

## v0.2 event and batch boundaries

The HMAC ingress authenticates the configured gateway, not the sender of an email. The gateway must verify provider authenticity and normalize actual inbound records. Never give the ingress secret to an LLM or include it in message content. Identical provider event IDs must be retried without editing content. Recipient matching is deliberately strict; aliases/forwarders require human review rather than automatic bypass.

Batch selection is not message approval. Each recipient retains four-eyes content approval. All child runs share the already-approved original budget and deadline. Pausing/cancelling does not undo remote operations. A result-unknown operation pauses the batch for reconciliation. Restore-from-backup can replay work absent from the backup: reconcile with providers before restarting.

## v0.3 成果证据与审核

业务成果由人登记，不由模型在任务完成时自动生成。系统验证回执或已消费事件属于当前运行，并要求独立身份审核。`human_reviewed` **不是**第三方独立鉴定、订单法律效力证明、回款确认或财务对账。外部 HTTPS 证据链接只保存引用，不由后台自动抓取，以避免 SSRF；审核者需在企业可信环境中核对文档原件、客户身份和财务事实。

统计按 `tenant` 隔离，避免同一类型、同一证据重复计数。管理数据库的人仍可修改记录并重算普通哈希，账本与档案不是不可篡改或公证系统。外部链接、邮件正文和验收档案可能含商业秘密，只向授权企业人员提供；不要把它们提交到公开仓库。订单金额按 USD 美分整数存储，声明为“人工审核订单标称金额”，不得向客户解释为实收收入。
