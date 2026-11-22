# 决策：[060-D2] 后台环节把只供程序核对的字段也发给模型

Status: proposed
observed_in_version: 0.7.0 + main@8b432a6（测试版）
fixed_in: pending
user_verified: pending

## 来源

Agent 查看测试版目标树记录里的后台调用用量时发现。数据是测试版的两份目标树记录：2026-11-19 至 11-20 的预览备份（277 次模型调用），和当前测试版记录（11-21 至 11-22，15 次）。Murphy 原话：draft 2345

## 问题

<!-- 谁在什么场景遇到什么，实际发生了什么，证据在哪里。一份决策只写一个问题。 -->
归属、学习、检验、整理、改进这些后台环节调用模型时，程序把整份任务输入原样转成 JSON，当作一条用户消息发给模型（`src/tree/model-owner.mjs:233`，`canonicalJson(job.input)`）。这份输入同时是程序核对模型输出用的冻结记录，里面有很多模型读不到用处的东西：

- 每条原文在 `content` 和 `text` 里各放一遍，正文发了两次（`src/tree/experience.mjs:54`）。
- 每条原文带 `ref`（会话号、序号、消息号、sha256）、再一份 `sha256`、`nativeType`。
- 背景段（归属的 `context`，学习、整理、检验的 `constraints`）每段带 `sourceRefs`，把这段背景依据的所有原文引用都列出来。例子：预览备份里最大的一次归属，`context` 共 4 段，第一段（全局概貌）正文 992 字，它的 `sourceRefs` 有 19,242 字。
- 检验的 `exposures` 每条带 `contextKey`、`renderedHash`、`invocationId`、`modelSessionId`、时间戳和修订号；学习的 `changeReceipts` 每条带 `id`、`receiptId`、时间戳和 `sourceRefs`。

模型输出只引用原文 id、条目 id 和版本、节点 id 这几类编号（`src/tree/prompts.mjs` 里的 `x-reference`），提示词里也没有提到上面这些字段。它们只给程序核对用。

### 实际数据

- 两份记录里所有后台消息中，64 位十六进制编号占了 17.5% 的字符。
- 原文这一项，正文重复（`content` 和 `text` 各一份）占原文字符的 34%，`ref`、`sha256` 等记账字段占 22%。
- 字符和 token 大致成正比。实际记录：一次整理的消息 320,537 字符，计 94,480 输入 token；一次学习的消息 82,549 字符，计 32,835 输入 token。

## 方案

1. 新增 `src/tree/model-view.mjs`，从冻结输入生成发给模型的版本。规则：
   - 原文只留 `id`、`role`、`origin`、`text`、`at`；工具结果加 `toolCallId`、`isError`；已省略的长工具输出只留字数。去掉 `content`、`ref`、`sha256`、`nativeType`。`text` 是程序把 `content` 拼成的完整文字，工具调用在里面是它的 JSON，信息不少。
   - 背景段（`context`、`constraints`）只留 `key`、`nodeId`、`text`。
   - `exposures` 只留 `id`、`nodeIds`、`itemVersions`、`visibleItemVersions`、`role`。
   - `changeReceipts` 只留 `commandType`、`entityIds`、`beforeVersions`、`afterVersions`。
   - 检验 `effects` 里的原文按第一条处理；`signals` 去掉 `eventId` 和时间戳。
   - 其余字段原样保留。
2. 程序在保存这条消息前会核对它是不是宿主按输入生成的那一条（`src/tree/jobs.mjs` 的 `bindMessage`，原来要求正文等于整份输入）。改成要求正文等于第 1 条生成的版本。
3. 只改发给模型的消息。程序核对输出（结构、引用、版本、来源、范围）仍用完整的冻结输入 `job.input`，规则一条不改。
4. 已经存了消息（`job.nativeMessage`）的任务照旧用原来的消息，恢复和重放核对不受影响；只有之后新准备的任务用新格式。
5. 不改提示词、输出格式，也不改哪些原文和条目进入输入。

## 预期效果

按两份记录里的实际任务重新生成消息，后台输入字符合计从 725 万降到 445 万，少约 39%：

- 归属少 51%（主要是背景段的 `sourceRefs`）
- 学习少 42%
- 整理少 44%
- 检验少 29%

模型读到的正文、编号和版本都还在，输出和核对结果应与原来一样。学习的输入长度估算也按这条消息算，学习会话达到长度上限的时间会推后。

## 考虑过的其他做法

<!-- 只写真实考虑过的做法和放弃的原因。 -->
- 把 64 位编号换成 s1、s2 这样的短编号，读回输出时再换回来：还能省输出 token、减少抄错，但所有引用的回读和报错都要跟着改，改动面大。先做本条，看效果后再单独评估。
- 直接从原文投影（`experience.mjs` 的 `project()`）删掉 `text`：程序里学习的长输出省略、历史读取等多处在用 `text`，删了会改内部行为，不采用。
- 留 `content`、去掉 `text`（D1 的写法）：开发时发现模拟服务的测试脚本按 `text` 读发给模型的原文（`test/tree-e2e.test.mjs`、`test/tree-cross-session-native.test.mjs`），这样要连带改不在范围里的测试。两种写法按实际记录重算都是少 39%，改为留 `text`。
- 保存消息时的核对放宽成新旧两种格式都接受：新任务只会生成新格式，接受旧格式没有用处，反而让核对变松，不采用。
- 只去掉原文的 `text` 重复：归属最大的一块是背景段的 `sourceRefs`，只删重复正文对归属几乎没用。

## 验收标准

- 模型拿到的工具和原版 DSH 一致：未安装 Arcfold 时用 standard 取原版完整工具基准；安装后 arcfold-main 核对 bash、read、write、edit、glob、grep（Arcfold 会关闭 standard）。实际会话 request/header 与模拟服务收到的清单均须核对，缺项判失败。

<!-- 写明产品行为的通过条件。发布前只进行一次完整自动隔离验收，不另列审阅前开发预检。人工界面与对话观察单独记录，不作为发布条件；代码审阅只判断阻塞 findings。 -->
- 测试：分别用完整的归属、学习、整理、检验输入生成模型消息。原文里没有 `content`、`ref`、`sha256`、`nativeType`，背景段里没有 `sourceRefs`，消息里没有 `contextKey`、`renderedHash`；原文正文（`text`）、所有原文 id、条目 id 和版本、节点 id 都在。
- 测试：模型输出引用消息里的原文 id、条目 id、节点 id，核对照旧通过；引用输入之外的编号照旧报 OUTPUT_REFERENCE。
- 测试：已存消息的任务恢复时照旧用旧消息，能认出原来那次提交，不重发。
- 测试：同一份输入两次生成的消息逐字相同。
- 测试：新任务保存消息时，正文是整份输入的会被拒绝（MESSAGE_CONFLICT），正文是新格式的才能保存。
- 原生测试：一次学习和一次归属经 DSH 实际发出的请求里，用户消息是精简后的版本，系统提示与原来相同。

## 风险

- 可能有模型其实借助了某个被删的字段，比如按 `ref` 里的序号判断先后。`at` 保留，原文本身也按发生顺序排列；但模型的判断有没有变差，单测看不出来。上线前用测试版已有的回放对比几次学习和归属的结果，变差就退回到只删重复正文。
- 新旧两种消息格式会同时存在一段时间（已存消息的旧任务、之后的新任务），恢复和重放都要按已存消息为准，测试要覆盖到。
- 这条只让每次发得更少，学习会话本身越来越长的问题不在本条处理。
