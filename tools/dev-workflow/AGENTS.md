# Arcfold DSH 交付入口

测试账户后台启动使用 [固定材料与真实窗口回报入口](rehearsal-startup.md)。先准备具体安装或测试计划，再绑定授权；就绪回执不代替发行验收，首次系统登录仍由开发者完成。

开工先运行 `next`。它只读本机记录，列出每个任务所处的环节、下一步和等谁，并汇总日常版本、未答的请求单、结果未知的写入、未处理的反馈和已退场的任务。`--remote` 另查 GitHub 上的 main、提案、检查和入口代码所在提交。`--write FILE` 把结果写入文件中的 `arcfold-next` 标记段。

1. 通过 `new --input FILE` 登记问题、发生版本和改动范围；来自开发者反馈时加 `--from-feedback F编号`，来源和发生版本自动预填。在返回的决策中用中文写真实场景、方案、预期、备选、验收和风险，一份决策只写一个问题。用 `check ID` 核对。把决策全文给开发者看，按开发者的意见修改，开发者确认后用 `align ID --text 原话` 登记。`start ID` 只接受与当前决策内容一致的对齐确认，本任务有未答的决定单时也会拒绝；通过后从当前 GitHub main 开独立工作目录。当前用户安装、资料、配置和凭据属于用户自己的环境。
2. 在独立目录提交改动，再用 `submit ID` 推送并创建提案。版本变更同时提交两份包的版本、锁文件、更新说明和依赖核对。若 main 已前进，用 `rebase ID` 重新组合，再提交检查。每次写远端后核对实际结果。结果未知时保留本机尝试记录，先查询远端和服务用量。
3. `review --pr N` 先查 GitHub 自动检查、代码中的已登记决策、范围、发行元数据和密钥扫描，再准备审阅材料和费用。材料附上当前提交的 GitHub 作业和实际测试结果。仅更新锁文件版本时，附完整差异和逐项比较。核对需要送出的源码，用 `ask` 开审阅费用授权单，写明估算和密钥剩余额度。授权单绑定本次材料编号（`binds.packet`），或绑定此提案的累计金额上限（`binds.pr` 和 `binds.cap_usd`）。开发者同意后用 `review --pr N --approval A编号`。专用密钥由操作者通过 `ARCFOLD_REVIEW_API_KEY` 提供，审阅进程从一条新请求开始。摘要把两侧提交、核对证据和回执关联起来。独立结论有放行、阻塞和后续问题。作者身份字段只记录贡献者。
4. `merge --pr N` 复核代码、检查和独立审阅，本任务有未答的决定单时拒绝。使用 GitHub squash 合入，再核验 main 的文件树和基线。新任务基于合入后的 main。
5. `release --version X` 从已合入源码两次构建并核对同批包，保存 npm dry-run 和许可，建立 Git 标签与 GitHub 发行草稿。隔离账户验证安装、发消息、更新、失败恢复和重启读回后，用 `--finalize --isolated-receipt FILE` 完成 GitHub 发行。首次公开仓库和真实 npm 发布按用户明确授权执行。
6. `export --output DIR` 生成当前 main 的无历史导出及逐文件检查清单。为用户核对可能的个人资料、凭据、真实数据和许可，再请用户批准创建公开仓库。公开后 main 要求最近的自动检查成功并与 main 同步。
7. 开发者更新并提供观察后，先用 `feedback` 登记，再用 `close-loop ID --version X --outcome pass|fail|unconfirmed --feedback F编号`（或 `--observation-file FILE`）核对 npm 上的两份包并关联观察。验收只描述实际发生的情况，只有 pass 算闭环。

npm 正式发布还需核对安装包之外的公开发布信息，见 [发布隐私核对](npm-publication-privacy.md)。

需要开发者处理的事都用请求单。`ask --input FILE` 读取 `kind`、`title`、`body`，以及可选的 `task`、`binds`、`options`、`steps`。`approve` 授权单必须绑定对象：`packet`、`pr` 加 `cap_usd`、`packages`（包名到 sha256）、`files`（绝对路径到 sha256，登记时核对内容）、`version` 或 `commit`。`decide` 决定单写清场景、各选项的实际后果、建议和只需决定什么。`act` 操作单逐条写步骤和做完要回报什么。每张单附上可以照抄的回复。`answer A编号 --verdict yes|no|other --text 原话 [--step N]` 按原话登记回复；授权单的 other 只记录，不算同意；已答的单不能再答，情况变了就另开一张。`asks` 列出未答的请求单，`--all` 包括已答的。

`feedback --text-file FILE [--attach PATH]` 登记开发者的观察，自动记下当时的日常版本，附件只留在本机。`route F编号 --to close-loop:任务|new:任务|issue:编号|note [--note 说明]` 记下去向，只记录不处理时要写明原因。`retire ID --reason 文字 [--replaced-by ID]` 标记被取代或放弃的任务。日常 DSH 资料目录默认是 `~/.dsh/profiles/desktop`，可用 `ARCFOLD_DAILY_PROFILE` 指定，入口只读取其中两份 Arcfold 包的版本。

`--repo OWNER/REPOSITORY` 或 `ARCFOLD_REPOSITORY` 指定仓库。`ARCFOLD_AGENT_ID` 可声明其他 Agent 的贡献标识，入口也支持当前 Codex 会话或操作系统账号。代码和回执流程适用于走该入口的协作者。分支权限由所连接的 GitHub 仓库配置。请求单、对齐确认和反馈都是同一账户可写的本机文件，用来防止误用过期授权和遗漏步骤，不是系统级身份认证。

审阅使用当前 HTTPS 连接设置，支持通过 HTTP 代理建立到 OpenAI 的加密隧道。先建立并验证连接，再传送审阅材料。连接建立前的失败记录为未送出。发送结果未知时，从 OpenAI 用量页或支持渠道核对。在原尝试目录保存 `billing-reconciliation.json`，记录 `client_request_id`、`outcome`（`no_usage` 或 `usage_confirmed`）和 `evidence`，才继续同一提案的新审阅。授权单按累计金额上限批准时，`usage_confirmed` 还要写 `actual_cost_usd`；任何一次旧请求的花费无法确定，`review --approval` 都会拒绝。

用户选择通过灵眸转发时，两次 `review` 命令都带 `--provider lmuai`。候选、服务和模型一起绑定到审阅材料。先通过灵眸只读接口核对 GPT-6.1 Terra 可用性和专用密钥最多 3.50 美元的总额度。公开起步价用于估算，可能明显低于实际扣费；密钥额度用于约束发起，独立回执附实际扣除额度。审阅材料会经过灵眸。送出前说明提交范围和服务处理边界。
