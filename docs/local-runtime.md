# 本地安装、启动与恢复

公开命令把一个固定发行安装成独立版本，再使用同一份个人数据启动官方 DSH 网页。模型、工具、权限和会话仍由 DSH 执行；Arcfold 保存协作材料及其来源。当前支持 macOS Apple Silicon、Node 24.15.0、DSH 0.2.2-rc.1、Cordis 4.1.0 和 pnpm 11.28.5。其他平台不能从源码中的平台分支推定已验收。

## 首次安装与初始化

以下 `/ABS/...` 要替换为真实绝对路径。`launcher` 是本次核心归档解开的公开命令目录，不是开发工作树。安装目标必须新建，父目录已存在；每次失败保留目录，不能覆盖重试。

```sh
node /ABS/launcher/bin/arcfold.mjs install \
  --release /ABS/Arcfold/releases/release-A \
  --supply /ABS/Arcfold/releases/release-A/runtime/supply.json \
  --installation /ABS/Arcfold/versions/version-A

node /ABS/launcher/bin/arcfold.mjs init \
  --installation-file /ABS/Arcfold/versions/version-A/installation.json \
  --config /ABS/Arcfold/local.json \
  --data /ABS/Arcfold/personal-data \
  --workspace /ABS/my-work --port 4381 --web-unlimited
```

安装核归档、真实依赖锁、每个包的内容及实际消费关系，再补丁实际消费的两个模型适配器和原生选模入口。它不启动宿主或调用模型。离线安装可加 `--offline-store /ABS/resource/offline-store.json`，必须提供与锁匹配的完整公开供给；不是随便复制一个 node_modules。省略 supply 仅查发行的 `runtime/supply.json`，不猜新锁。

初始化的 `--web-unlimited` 是明确的网页费用授权，不是赠送余额或开发预算。它创建独立的新网页账本与 v2 配置，绝不认领旧开发 ¥150 账本。两路线分别固定官方地址、模型政策和凭据引用；OpenAI 只记 token，DeepSeek 按配置的人民币政策预留和结算。未知结果的预留保留。

默认回答为 `deepseek-official/deepseek-v4-pro/high`。学习仅在初始化时复制这三个值；也可通过完整 `--main-provider/--main-model/--main-reasoning` 或 `--learn-provider/--learn-model/--learn-reasoning` 明确选择。之后主模型与学习默认独立，已启动学习保留自己的完整配置快照。请求输出上限留在部署政策中，不提供网页上限编辑器。

网络默认明确 direct；需要无认证 HTTP CONNECT 代理时加 `--proxy http://127.0.0.1:PORT/`。不继承环境中的代理或 API 密钥。凭据引用固定为 `ARCFOLD_DEEPSEEK_API_KEY`、`ARCFOLD_OPENAI_API_KEY`，配置里不保存值。

## 空凭据先打开网页

```sh
node /ABS/launcher/bin/arcfold.mjs start --config /ABS/Arcfold/local.json
node /ABS/launcher/bin/arcfold.mjs open --config /ABS/Arcfold/local.json
```

没有密钥也可启动并查看设置；相应模型显示不可运行。在原生设置中选择语言，在 Arcfold 模型设置中写入凭据；当前宿主随后从官方凭据服务读取，不要求重启。只显示保存/是否存在，不自动发试探请求，“已填写”不等于 API 身份验证成功。

回答模型用原生交流选择器。已有交流在“轨迹”旁的“Arcfold”页签查看五块协作面板，点“模型与学习”打开动态设置；空白交流直接显示两个紧凑入口，无需先发消息。后台学习在该设置里单独选择提供方、模型与思考强度；主模型改变不会改已有学习。费用分别显示网页 DeepSeek 范围和 OpenAI token/未知数，不混入开发费用，也不把未读到的数据当零。

`open` 将带认证信息的地址直接交给系统浏览器，不打印令牌。直接访问干净地址遇到 401 不能据此断定服务故障；应使用公开 open 入口。系统锁屏、浏览器没有完成打开和页面仍重连都不等于历史已读回，需等实际页面显示。

## 日常工作与关闭

```sh
node /ABS/launcher/bin/arcfold.mjs status --config /ABS/Arcfold/local.json
node /ABS/launcher/bin/arcfold.mjs stop --config /ABS/Arcfold/local.json
node /ABS/launcher/bin/arcfold.mjs restart --config /ABS/Arcfold/local.json
```

启动不会重新安装、重新初始化或覆盖用户配置。首次通过原生工作区服务登记显式 workspace；已有工作区与对话保留各自目录。原生文件权限和审批照常生效。开始正式工作前查看网页实际选中的工作区。

文件工具创建新文件无需先读取，但不会覆盖同名已有文件；修改已有文件须先读取，且写入时版本仍须一致，发生变化就要重新读取。这层保护同时适用于主对话与机会准备；机会准备仍只允许创建新稿，不获得修改已有文件的权限。

主对话可有多步模型与工具。正式答复保存后，一次无工具的学习后台处理冻结材料，下一句无需等待。学习输出按理解、方法、目标、机会独立校验与提交，部分失败保留原输出，不自动重发。

原生执行目标是明确委托的工作，长期目标只是协作材料。只有前者通过真实当前授权才可继续多轮；关闭网页不会停止已委托工作。暂停仍使用原生控件，并查看仍运行的 jobs；暂停不声称杀死所有后台任务。错误、结果未知和重启后不自动续发，需要查看原记录并明确继续。方法继续采用、长期目标恢复追踪均不能扩大执行权限。

`start/stop/restart/open` 可带 `--timeout-ms`（100–600000，默认 60000）。命令超时是没有得到确认，不授权强杀或重发。正式关闭回执 `official-shutdown-returned` 说明官方关闭函数返回，不说明任务都完成；`unconfirmed` 则没有这份证明。每次运行原件保存在数据根的 `runtime/runs/<runId>/`。不要删除锁文件或清空未知记录来让状态变绿。

同一数据根由操作系统锁排他持有。已有运行时的 status/stop/open 使用原启动版本的经核管理代码，不依赖新模型配置可用；因此不要删除仍在运行的旧版本。裸命令目录无需 node_modules：它验证安装后才委托实际 installed core，官方解析就绪后才加载服务依赖。

## 个人数据与崩溃恢复

| 位置 | 内容与保留规则 |
|---|---|
| `versions/<version>/` | 官方宿主、版本 profile、Arcfold 包与 installation.json；每版独立，不移动已安装树 |
| `local.json` | 选用版本、数据根、工作区、端口、政策及凭据引用；不含密钥值 |
| `personal-data/business.sqlite` | 协作业务材料及来源；与费用库分开 |
| `personal-data/native/` | 原生会话、设置及凭据服务数据；不打入发行归档 |
| `personal-data/requests/` | 网页费用库、请求与响应原件；包含隐私，不公开 |
| 工作区 | 用户委托处理的文件；更新程序不覆盖它 |

初始化先取得既有数据锁，再取得请求证据锁。稳定身份绑定本次输入；每次在独立暂存目录建库、关闭并校验。发布前保存意图，精确绑定路径、inode 与字节，再独占链接。失败暂存保留；只补完能由先前意图解释的发布，不接管陌生文件或路径别名。这不是跨两库和配置的三文件原子事务：最终配置发布才表示初始化完成。

相同输入完成后重试仅确认原归属并返回初始化回执，不重置正常使用后的记录，也不是数据健康检查。启动负责当前状态验证。

新 web-only DeepSeek 路径固定为请求目录中的 `deepseek-web.sqlite`。无锁配置预检不恢复原库。真正持有同一证据锁后才封存完整数据库家族，在副本验证，再通过正常 SQLite 连接恢复未变化原件；冷 journal 是否仍存在不是成功判据。旧 limited/mixed 账本行为不改，未知请求不重发。外部程序绕过锁写库不受支持，检测到不明变化会拒绝。

## 导入和只读导出

在实际 Arcfold 主交流中，可先浏览材料而不发送模型消息。导入需选择文件、核预览、明确确认；改范围产生新预览。撤回保留历史原件，原预览只代表当时判断，不能继续作为有效依据。方法面板当前只列待决定项，完整导入详情可检查原试用计数。

旧 3 的公开导出入口如下；先停止旧系统或使用已封存的完整数据库家族工作副本，不直接实验 live 生产库：

```sh
node /ABS/launcher/bin/arcfold.mjs export-legacy \
  --installation-file /ABS/Arcfold/versions/version-A/installation.json \
  --source-db /ABS/old3-copy/store.sqlite \
  --output /ABS/exports/old3-export.jsonl
```

导出以单次只读事务取得一致视图，保留来源身份与缺口；不启动旧 Store，不读密钥或费用账本，不把 audit/config/旧嵌套导入内容整块带出。随后网页按 v2 合同预览该产物，不自动确认。具体输出与范围以导出回执为准。

## 切换和回退兼容版本

```sh
node /ABS/launcher/bin/arcfold.mjs stop --config /ABS/Arcfold/local.json
node /ABS/launcher/bin/arcfold.mjs use-version \
  --config /ABS/Arcfold/local.json \
  --installation-file /ABS/Arcfold/versions/version-B/installation.json
node /ABS/launcher/bin/arcfold.mjs start --config /ABS/Arcfold/local.json
```

切换先检查目标版本真实代码、运行入口、业务格式 1 / 原生格式 4 及所需恢复能力，检查通过才更新安装指针。正在运行时拒绝，不自动启动；个人数据原样保留。只有插件、没有可启动产品入口的旧发行不是回退目标。不用旧数据库覆盖当前库来“回退”，也不声明未来格式降级可用。

## 本次发行要怎样确认

以最终发行清单绑定源提交、两包、固定供给与永久安装位置。各阶段工程检查、模拟请求、网页操作和真实内容效果分别记录，已有失败原件保留。一次真实纠正试验的两答核心核对及方法形成、领取已通过；同聊纠正、表达问题与耗时边界见[README](../README.md#能力与证据边界)，不据此推定长期收益。具体发行的机会准备、桌面与窄屏网页核验结果，以及仍未通过或尚未验证的事项，以随发行提供的交付清单（DELIVERY）为准。公开目录和版本化架构预览的交付要求见[发行说明](release-bundle.md)。

## 模型目录更新

当前目录包含 deepseek-v4-pro、deepseek-flash（V4.1-Flash-1017）、gpt-6-astra 和 gpt-6.1-sol。回答与后台学习从同一部署目录选择，现有选择保持原值，新安装默认保持 DeepSeek Pro/high。GPT 的上下文仍限于固定原生目录的 272000 token，本次不扩为官方宣传的 1050000；保留文字与本地函数工具范围。GPT 两项支持 low/medium/high/xhigh/max，DeepSeek 两项支持 off/low/high/max。

新发行的初始目录只作用于新初始化，现有配置不会自动覆盖。已有安装须先正式停止，在保留配置原件后，仅增加已审核的两项模型及 Astra 的 max 档位，并以新安装的 validateRuntimeConfig 核对后原子替换；保留原 main/learn、费用授权、账本路径、凭据引用、原生补丁和数据，再正式启动。没有重新初始化、自动选中或自动发模型请求。
