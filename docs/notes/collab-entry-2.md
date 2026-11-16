# Agent Note: 协作入口第一批：进度、请求单、对齐确认和反馈登记

Status: proposed
observed_in_version: 0.4.1
fixed_in: pending
user_verified: pending

## Source

开发者在 2026-11-15 的对话中要求按本机设计文档 research/delivery-collaboration-design.md（不在仓库内）实现第一批，并确认授权在 Codex 对话中给出、由 Agent 按原话登记。下面的事实来自本仓库入口代码和本机状态目录中的现有记录。本任务取代 collab-entry-1：那份决策在 start 时已冻结，这里只把个人称呼改为「开发者」，内容不变。

## Problem

开发者和 Agent 推进 D1–D6 时，要用到的进度和人工关口都不在入口里。

- `status` 只列出 task.json，而 phase 到 open 后就不再更新。0.4.1 的三个任务都显示 open：其中两个已被 PR #4 取代，另一个已合入、发布，并收到了更新失败的反馈。
- 需要开发者批准、决定或亲手操作的事，只存在于对话和手写文件里。`review --reported-estimate` 只核对材料编号，不记录开发者是否同意。PR #4 的估算文件写 0.02 美元，手写的费用报告写 0.26 美元，实际扣费 0.2032038 美元。
- 决策记录只要由 Agent 填完就能 start，没有开发者读过并同意的记录。0.4.1 的三份决策都是英文。
- 开发者的体验反馈没有登记入口。close-loop 只接受文字，不区分通过、未通过和未确认。
- 结果未知的远端写入散落在各自的记录里，例如 Issue #7 的结果评论停在 unknown。

## Proposal

在 tools/dev-workflow 中新增 collab.py，并接入 workflow.py。

- `next`：只读命令。根据现有记录推算每个任务所处的环节（D2–D6）、下一步做什么、等谁。同时汇总以下内容：日常版本（读取 DSH 桌面资料目录中两份 Arcfold 包的 package.json）、未答请求单、未处理反馈、结果未知的写入、已退场的任务。加 `--remote` 时，另外核对 main、提案，以及入口代码所在的提交。加 `--write FILE` 时，把结果写入该文件的标记段。
- 请求单：`ask --input FILE` 登记授权单、决定单或操作单，其中授权单绑定被批准对象的摘要。`answer A编号 --verdict yes|no|other --text 原话 [--step N]` 按原话登记开发者的回复。`asks` 列出全部请求单。
- 对齐确认：`align 任务 --text 原话` 绑定决策当前的 sha256。缺少与当前决策相符的对齐确认，或本任务有未答的决定单时，`start` 拒绝。本任务有未答的决定单时，`merge` 拒绝。
- `review --approval A编号` 取代 `--reported-estimate`。授权单必须已同意，并且满足以下任一条件：绑定了本次材料编号；或者绑定了此 PR 的累计金额上限，且已实际花费加本次估算不超过上限。
- `feedback --text-file FILE [--attach PATH]` 登记反馈，并带上当时的日常版本。`route F编号 --to 去向` 记录反馈的去向。`new --from-feedback F编号` 预填来源和发生版本，并自动记下去向。
- `close-loop` 新增必填参数 `--outcome pass|fail|unconfirmed`，也可以用 `--feedback F编号` 代替观察文件。
- `retire 任务 --reason 文字 [--replaced-by 任务]`。
- 决策模板改为中文章节。解析时同时接受现有的英文章节，旧任务的 check 和 close-loop 不受影响。

不新增依赖，不改动发行路径，也不改动现有的检查。

## Expected outcome

新开的 Agent 会话只要运行 `next`，就能知道每个任务停在哪、下一步谁做什么，不必再读 LOG.md。开发者的每次授权、决定和对齐都留有原话记录，并绑定到具体对象，对象变了，旧授权就不能再用。每条反馈都有去向，D6 只有记为 pass 才算闭环。

## Alternatives considered

- 补全 task.json 的 phase 状态机：需要改动每个写入点，并迁移已有记录。改为从现有记录推算，就不需要迁移。
- 让开发者在终端自己运行 answer：多一步操作，而且同一个系统账户下也不能证明是本人操作。开发者选择在对话中给出。
- 做一个网页看板：需要常驻服务。本地 JSON 加 Markdown 标记段已经够用。
- 继续手写 README、USER-STEPS 和费用报告：会和记录对不上，现状已经出现这种情况。

## Acceptance criteria

- 对现有 0.4.1 状态目录离线运行 `next` 时，arcfold-041-proof 显示在 D6 且未闭环，Issue #7 的结果评论列为结果未知的写入。整个过程不联网，也不写文件。
- 缺少对齐确认、对齐后决策又被修改、或本任务有未答的决定单时，`start` 拒绝，并且不访问 GitHub。
- 授权单未答、被拒绝、绑定的是另一份材料、或累计金额超出上限时，`review --approval` 拒绝，并且不发送审阅请求。
- 对已经答过的请求单或不存在的请求单，`answer` 拒绝登记。
- `feedback` 记下日常版本，资料目录不存在时记为 unknown。没有记下去向的反馈会出现在 `next` 的输出中。
- `close-loop` 缺少 `--outcome` 时拒绝。旧观察缺少结论时，`next` 把它当作 unconfirmed。
- 英文章节的旧决策仍能通过 `check`。新模板生成中文章节，填写后能通过 `check`。
- 全部工作流检查在本机 Python 3.9 和 CI 上都通过。

## Risks

- 请求单和对齐确认都是同一账户可以改写的本机文件，只能防止误用和遗漏，挡不住有人绕过入口。
- `next` 的环节推算依赖现有记录的文件名和 phase 值。以后改动写入点时，推算规则要同步更新。
- 灵眸的估算按公开起步价计算，PR #4 低估了约 10 倍。累计上限按实际扣费核对，但单次估算可能偏低。
- 截图可能含私人内容，只存在本机，不进入审阅材料，也不上传 GitHub。
- 第二批（建 Issue、npm 发布）不在本任务范围内。
