# Trade Workflow Compiler · 外贸业务流程编译器

**v0.3.0 — 独立、自托管、默认拒绝未授权外部动作的业务编译与成果证据核心。**

把企业自然语言需求和明确提供的企业资料编译成有版本、有数据契约、有审批节点、可持久化执行的流程。复用 OpenMausBot 执行研究和起草任务；把邮件发送、报价提交、样品申请等商业动作交给受控业务网关。

这不是一个已接好所有渠道的外贸成品 SaaS。仓库实现的是可运行的编译器、业务控制层和接入协议；不附带真实企业资料、买家名单、模型凭证、发送账号或供应商接口。所有业务能力默认关闭，缺少真实绑定时会返回 `blocked`，而不是生成虚假的成功结果。

## 已实现

| 模块 | 当前行为 |
|---|---|
| 需求编译 | 中文/英文规则选择，三套固定流程；可选模型语义选择，模型不能扩张工具权限 |
| 流程协议 | 严格 WorkflowSpec v1，五类节点，不可变版本，契约和绑定哈希固定 |
| 静态校验 | 不存在的能力、环路、不可达节点、依赖缺失、审批绕过、预算超限均被拦截 |
| 企业上下文 | 每个 Worker 收到原始企业资料和经营需求，不能只依赖上一步模型转述 |
| 审批 | 流程发布与具体外部动作分别审批；不同身份；动作授权绑定完整内容哈希与有效期 |
| 执行 | SQLite WAL 持久化、节点状态、事件收件箱、重试、限额、取消、异常动作人工对账 |
| 批次 | 多买家进入 BATCH_READY、显式选择、独立审批、共享预算、暂停/恢复/取消 |
| 回流 | HMAC 事件入口、回执唯一关联、邮箱归属校验、隔离收件箱、分页和重检 |
| 接入 | OpenMausBot 标准 stdio MCP 适配器、受控 HTTP Gateway 适配器 |
| 界面 | 中文业务工作台：需求编译、流程预览、发布、启动、审批、运行及证据查看 |
| 运维 | 独立角色令牌、审计链、拒收名单、健康检查、doctor、Docker 配置、CI 配置 |
| **成果账本（v0.3）** | 人工登记真实证据指针、执行归属校验、去重、独立审核、分类统计、逐运行验收档案与 SHA-256 摘要；不将任务成功写成真实成交 |
| 可选调度 | `integrations/temporal` 独立调度包；没有在本次环境完成 SDK 编译或真实服务联调 |

三个业务闭环：

```text
海外买家开发：市场研究 → 发现买家 → 筛选 → 起草 → 人审 → 单一收件人发送 → 等待首条回复 → 分类
询盘报价：整理真实询盘 → 起草报价 → 人审 → 发送 → 等待首条回复 → 分类
样品跟进：生成样品申请 → 人审 → 提交申请 → 等待一次业务反馈 → 汇总
```

**每个子运行仍只允许一个外发收件人。** v0.2 支持从一次研究结果创建逐客户独立运行，批次共用原授权预算；不把“批量发送后只处理第一条回复”伪装成完整客户管理。询盘到报价不会自动生成价格依据，必须向 `context.facts` 提供真实询盘、可用价格规则和企业承诺限制。

## v0.3 成果证据账本

新增 `GET/POST /api/outcomes`、`GET /api/outcomes/summary`、`POST /api/outcomes/:id/decision`、`GET /api/runs/:id/dossier` 等接口。外发回执必须来自本运行已完成的受控动作，买家回复必须来自本运行已经消费的业务事件，订单记录需要人工提交实际商业文档的 HTTPS 指针。

**所有商业成果初始都是 `pending`；只有不同角色的审核者核对后才显示 `human_reviewed`，并且这依然不等于已回款、已结算或第三方核验成功。** 同一证据引用不能为同一类型成果重复计数；验收档案包含运行记录、审批、已消费事件和成果清单，附内容 SHA-256 用于离线完整性对照，但不带可信时间戳或数字签名。详见 [成果账本](docs/outcome-ledger.md) 和 [v0.3 升级说明](docs/upgrade-v0.3.md)。

## v0.2 已有能力与升级

[客户开发批次](docs/batch-execution.md) · [业务事件回流](docs/event-ingress.md) · [旧版升级步骤](docs/upgrade-v0.2.md) · [v0.2 历史验收](docs/verification-v0.2.md)

复用上一版三个流程，不另造 runtime。多客户研究完成后必须手动选择，所有外发仍逐条审批。真实 Worker、邮件渠道和供应商系统未在本次环境联调。

**已有 v0.1 用户先停止服务、备份完整 data/ 与 .env，再升级；不要重新 init 或直接覆盖数据库。**

## 直接运行：不用先安装 npm 依赖

已包含实际构建并测试过的 `dist/`。核心运行时只有 Node 自带模块，不依赖外部 npm 包。需要 **Node.js 22.16.0 或更新版本**；Node 22 可能显示 SQLite experimental warning。

Windows PowerShell：

```powershell
cd Y:\works\trade-workflow-compiler
node --version
npm.cmd run init
npm.cmd start
```

Linux/macOS：

```sh
cd trade-workflow-compiler
node --version
npm run init
npm start
```

浏览器打开 `http://127.0.0.1:8787`。初始化会创建：

```text
data/auth.local.json          六种角色的独立随机令牌，绝不能提交
data/capabilities.local.json  默认禁用的真实能力绑定配置
data/event-sources.local.json  新的签名事件源；默认为空，未启用
data/twc.sqlite              第一次启动服务时创建的业务状态库
```

打开本机 `data/auth.local.json`，将对应角色令牌填入工作台登录框。令牌只保留在当前页面内存，不写入浏览器本地存储。

开发测试可以分别登录 operator 和 approver 检查权限；真实运营必须让不同人员保管各自令牌。把两个令牌交给同一个人，不构成真正的双人审批。

首次编译出现 `CAPABILITY_UNAVAILABLE` 是预期的安全结果。填写真实企业资料、预算并绑定真实工具后才可能发布。不要为了看到绿色状态随意开启能力。

## 接入真实 Worker

1. 管理员在 OpenMausBot 中配置**只读研究/起草 Worker**，移除其邮件发送、任意 shell 和其他商业动作权限；获取真实 bot ID 和配对凭证。
2. 根据 [OpenMausBot 接入文档](docs/openmausbot.md) 修改本地能力绑定。密钥放本地 `.env`；不要写入 Registry、工作流或 Git。
3. 外部动作使用 [业务网关协议](docs/gateway-contract.md)，接入自己真实的邮件或样品服务。没有网关时不能发送。
4. 运行 `npm run doctor`，再编译新版本，由独立 approver 发布，然后由 operator 启动。

已有流程固定了能力配置哈希。修改 bot ID、网关、版本或预算策略后，旧流程会停止执行；需要重新编译和审批，而不是悄悄更换执行方。

## 开发和测试

```sh
npm install --ignore-scripts
npm run check
npm run export:schema
```

顶层仅开发依赖 TypeScript 5.8.3、@types/node 22.19.7。没有生成依赖 lockfile：本次环境不能连接 npm registry。核心预编译运行不需要安装依赖；不能据此声称整个开发供应链已锁定或经过依赖审计。

单独验证已构建版本：

```sh
node scripts/test.mjs
```

测试中包含明确标记的合成 fixture，只存在于 `test/`。生产入口没有模拟成功路径。测试通过不等于 OpenMausBot、邮箱或供应商已经接通。详细结果和未验证项见 [验收记录](docs/verification.md)。

## GitHub 发布（用户已经创建远程空仓库）

仓库地址：`https://github.com/magicy565-web/trade-workflow-compiler`。由用户创建的仓库为 **public**，不要把真实企业档案、客户回复、凭证或本地数据库加入 Git。

在已用 `gh auth login` 登录账号的 Windows PowerShell 中，解压本发布包后运行：

```powershell
npm.cmd run check
node scripts/publish-github.mjs --existing
```

该脚本会验证账号和远端存在性，**只接受空仓库**，执行非强推的 `git push -u origin main`，拒绝覆盖远端已有提交。如远端已经存在内容，需要人工检查和正常合并，不能用 `--force` 覆盖。发布成功后，以 GitHub 的实际 `main` 提交为准。

## 设计边界

实现与最初建议的取舍：**核心用严格 JSON Schema 子集校验器，不是 Zod；默认持久化用 SQLite，不是 PostgreSQL；Temporal 是独立可选调度包，不是已验收的默认执行后端。** 原因是保证此版本可独立运行、可检查，不把无法安装或未接通的组件算作完成。

本版不包含任意自然语言生成程序、可视化拖拽编辑器、自动查价、邮件账号 OAuth、CRM、支付、自动训练、全局供应商数据库、PostgreSQL 适配或多企业 SaaS 隔离。建议一企业一实例，配套独立 Worker 和凭证。数据库的 tenant 检查不等于整个远端 Agent 环境的隔离。

预算是以 USD 微元记录的**调度授权上限**（1 USD = 1,000,000 micros），不是远端模型或供应商的结算硬上限。模型解析单独调用的费用不计入流程运行预算。来源记录是证据线索，不是事实真实性认证。详见 [安全说明](SECURITY.md) 与 [架构](docs/architecture.md)。

## 目录

```text
src/compiler/       模板、需求解析、WorkflowSpec、静态校验
src/runtime/        状态解释执行器
src/adapters/       OpenMausBot MCP / HTTP 网关
src/store.ts        SQLite 状态、审批、迁移和审计
src/batches.ts      单次研究拆分为逐客户运行与共享预算
src/events.ts       回执归属、事件收件箱、HMAC 签名验证
src/api.ts          角色隔离 API
public/             中文工作台
config/             不含秘密、默认关闭的配置样例
schemas/            导出的 JSON Schema
integrations/       可选 Temporal 调度包
scripts/            本机 GitHub 发布脚本
test/               单元与集成测试；合成数据仅用于测试
docs/               接入、协议、运维、验收边界
reports/            当前实际验收记录；v0.1.0/ 仅为历史证据
```

MIT 许可。有关外部工具的权限、许可和账号政策由其服务提供方及部署者负责。
