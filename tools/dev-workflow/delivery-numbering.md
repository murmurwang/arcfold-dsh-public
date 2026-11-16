# 用一个总号查清一次交付

准备新的交付时，`new` 分配至少三位的总号和第一份决策号。随后使用入口返回的真实编号。以下 `001` 等均为示例，不能手工猜号或当作已有记录。

```text
new → 001、001-D1 → align 001 → start 001 → submit 001
                           ↓
独立反馈 F8 ──来源关联──→ show 001 ←── 001-A1 请求与答复
通用反馈 dev-F3 ────────→    ↑     ←── 001-R1 独立报告
                           ↑
              实际代码、检查、合入、发行、验收记录
```

`show 001` 读取所属材料和实际执行记录，展示范围、当前决策、全部开发执行、外部提案号、发行、反馈、验收与待处理项。`show 001-D1`、`show 001-A1`、`show 001-R1` 和 `show F8` 查看具体材料。`next` 汇总下一步、待答请求、未解决反馈、未归属反馈、dev 反馈、未知写入与未写完的编号登记。只读查询不会请求模型或修改记录。

| 材料 | 编号 | 谁写内容，谁作判断 |
|---|---|---|
| 反馈 | `001-F1`、`F1`、`dev-F1` | 提供者给原话和观察，Agent 登记；分析和分类另留依据 |
| 决策 | `001-D1` | Agent 起草，开发者确认具体正文；确认附在记录上 |
| 请求 | `001-A1` | Agent 说明需要决定、批准或操作的事；开发者答复 |
| 独立报告 | `001-R1` | 入口固定材料，独立审阅模型给结论；实现者不能代写 |

正文和来源保留内容作者；登记动作另记记录者及时间。执行和验收没有额外字母编号。机器回执可以继续按原目录存储，交付索引建立真实关联。

## 登记与决策修订

`new --input request.json` 的输入包含 `title`、`authorization_ref`、`observed_in_version` 和 `scope`。`id` 可作为内部任务别名省略；交付总号始终由入口分配。入口自动把本份公开决策的精确路径加入范围。

```json
{
  "title": "修复工作流进度遗漏反馈",
  "authorization_ref": "开发者反馈 dev-F3，经讨论准备交付",
  "observed_in_version": "dev 源码提交或明确未知原因",
  "scope": ["tools/dev-workflow/"]
}
```

完成入口生成的决策正文后，依次使用 `check 001`、展示全文、`align 001 --text '实际确认原话'`、`start 001`。新建草稿不代表获准开发。已有明确确认按原话登记，无须要求同一件事重复批准。

- 未确认草稿：`revise 001 --input decision.md` 保留当前 D 号。
- 已确认正文改变：同一命令生成下一份 D，保留旧正文和确认，等新确认后再 `start 001`。可重复 `--scope` 指定新决策的完整范围。受影响的旧执行不能再提交、合入或发布。
- 同一决策重新开发：`reopen 001 --reason '实际原因'` 保留旧目录和提案，建立新的执行记录，沿用完全相同正文的确认，再 `start 001`。不会增加 D。
- 暂停、恢复或取消：`delivery-state 001 --status paused|active|cancelled --reason '原因' --text '开发者指示或已确认规则原文'`。取消不等于验收通过。

内部任务别名和目录不是新的面向开发者的编号。多个执行与返工仍归于同一总号。

## 反馈先记，归属后定

```sh
./Arcfold-DSH-Development feedback --text-file observation.txt
./Arcfold-DSH-Development feedback --target dev --subject next --context '查看进度时遗漏反馈' --text-file observation.txt
./Arcfold-DSH-Development feedback --delivery 001 --target dev --text-file observation.txt
```

三条命令分别使用独立 F、dev-F、交付内 F 序列。`--provider` 指定实际提供者，`--source` 保存来源，`--attach` 可重复添加附件。dev 通用反馈可以用 `--related 001` 保存发生场景，仍使用 dev-F。未明确对象时使用独立 F，不猜交付。

dev 反馈保存执行入口的实际提交、工作文件摘要及是否有未提交改动；无法读取则保留未知原因。未提供复现现场时明确说明，不捏造实际运行输出。日常产品包版本只作背景。`new --input request.json --from-feedback dev-F3` 使用 dev 版本作为发生版本，不拿产品包版本替代。

```sh
./Arcfold-DSH-Development feedback-link F8 --delivery 001 --relation source --note '由本次交付处理'
./Arcfold-DSH-Development feedback-link F8 --delivery 002 --relation context --note '发生在另一次交付中'
./Arcfold-DSH-Development classify F8 --target dev --reason '经核对属于工作流输出'
./Arcfold-DSH-Development show dev
```

关联用途为 `source` 处理来源、`context` 发生场景、`acceptance` 验收依据、`reference` 参考。误关联用相同命令加 `--remove`，留下纠正依据。原号、原归属和历史仍可查，按 dev 对象查询包含后来改分类的 F8。

实质更正用 `feedback --corrects F8 --text-file correction.txt`，入口在原序列生成下一条，引用旧反馈；补充附件用 `feedback-attach F8 --attach screenshot.png --source '提供者补充'`。这些操作不会覆盖原话。

`route F8 --to new:001`、`issue:17` 或 `close-loop:001` 只登记去向，反馈仍待处理。暂时只记录用 `--to note --note '原因'`，仍能在未归属或 dev 总览找到。旧反馈确被后续验收解决时，使用 `feedback-resolve F8 --acceptance 本机验收回执.json`；入口要求该回执通过、引用实际反馈并属于同一交付。

暂时只记录后再关联交付或安排 Issue 等处理去向，反馈恢复待处理，原来的只记录原因仍在历史中。已经通过验收解决的反馈不会因补充关联而重新打开。

## 请求与独立审阅

`ask --input request.json` 必须指定 `delivery`（或能解析到交付的 `task`）。决定、授权、操作共用同一 A 序列；审批对象继续使用实际材料摘要、提案累计限额、安装包摘要或文件摘要等原有绑定。

发出后改变内容或对象，另开请求并在输入中写 `supersedes: "001-A1"`。原请求与答复保留，旧答复不会成为新授权。`cancel-ask 001-A1 --reason '原因'` 撤销请求，也不删除答复。操作分步答复用 `answer 001-A3 --step 2 --verdict yes --text '001-A3 的第 2 步好了'`，不另分材料号。

`review --pr N` 在检查通过后预留 R 并给出固定材料摘要和费用估算。相同代码、检查、服务和材料的重复预览使用同一 R；读取既有结果也不换号。新一次独立请求用 `--new-attempt`，旧请求结果和费用必须先核对。材料变化产生新的 R；旧不确定请求不能靠新号绕过。费用请求可在 `references` 列表中引用 R，实际授权仍绑定材料或提案的累计上限。

授权之后再次运行 `review --pr N --approval 001-A2` 使用已预留的 R，**不要在这一步再次添加 `--new-attempt`**。独立报告返回并核对后才形成结论。总号查询同时保留原始报告、执行回执、费用、失败与后续发现。公开报告标题含完整 R；提案与后续问题标题含交付总号，生成的发行说明关联总号与提案号。

查清费用不等于拿到了有效报告。旧响应须通过原送审材料、请求、模型、报告结构和证据位置的校验；有效的未通过报告也属于结果已知。没有有效报告时，Agent 先核对原请求，并在原目录追加 `result-reconciliation.json`，与原有费用核对文件分别保存：

```json
{
  "client_request_id": "原请求的实际编号",
  "outcome": "unavailable",
  "reason": "核对后仍未取得报告的具体原因",
  "evidence": ["本机日志、服务查询或支持回执的实际位置"],
  "at": "实际核对时间",
  "recorded_by": "实际记录者"
}
```

`unavailable` 表示没有取得报告；`invalid_response` 表示取得的响应无法形成有效报告。这两种记录都只确认执行失败，不能填写 pass，也不产生独立审阅结论。结果与费用两边都已核对后，才可在有效授权下准备另一请求；只有费用文件、用量数字或本地通过标签仍不能放行。

跨交付材料参考用 `link 002 001-R1 --relation reference --note '引用已有发现'`。引用不转移旧授权，也不把旧代码的审阅结果用于新代码。

## 上线与实际验收

安装包交付继续通过 `release` 保存构建、发布前验证和实际发布证据，使用 `close-loop 001 --version X --feedback F8 --outcome pass|fail|unconfirmed` 登记实际体验。只有正式上架记录才显示已上线；只有当前执行的真实验收通过才显示已验收。

不发行安装包的 dev 交付，合入后使用 `accept-dev 001 --feedback 001-F1 --outcome pass|fail|unconfirmed`。通过需要反馈记录的实际入口提交与合入提交一致且没有未提交改动；版本未知时保持未确认。不能仅因为已经合入就显示验收通过。

## 旧记录迁移

```sh
./Arcfold-DSH-Development migrate --write migration-plan.json
# 展示并核对交付、决策、旧请求与旧审阅的归属，再登记确认原话。
./Arcfold-DSH-Development migrate --apply migration-plan.json --text '实际核对确认原话'
```

预览只读，拟分配号在应用前仍可能变化。应用时逐项核对旧文件内容和编号状态；变化后须重新预览。旧任务、A4 等文件不改名、不重写；映射给出新完整引用，旧引用仍可用，授权对象完全不变。缺少归属的旧请求留在 `unassigned_asks`，不猜范围。

迁移后的旧请求收到新答复或被撤销时，状态保存在 `ask-updates` 附属文件，原文件内容与修改时间不变。取代关系保存在新请求中；使用旧号或完整号查询和执行时，都读取同一有效状态。附属状态绑定原文件摘要，原文件被外部改动后先停下核对。

迁移先保存操作记录，再写映射。中断后使用同一已核对文件恢复，只续写该次预留的号，不重新分号。旧文件若已变化则停止核对；`next` 保留未确认的迁移与未完成登记。失败或取消的号码不回收。全局 F 接续旧序列，不覆盖旧反馈。

实现位置：`delivery.py` 管编号、决策快照、执行索引、查询、审阅引用和迁移；`delivery_feedback.py` 保存原话与追加历史；`collab.py` 负责请求、确认与进度；`workflow.py` 接通开发、审阅、合入、验收命令。没有新增模型调用或系统提示词。独立审阅仍使用 `desktop_review_request.py` 的原提示词与费用核对。
