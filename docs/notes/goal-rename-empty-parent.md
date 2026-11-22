# 决策：[064-D1] 主助手改目标名时带了空的上级字段，改名被拒绝

Status: proposed
observed_in_version: 0.7.0 + main@21f8624（日常叠加）
fixed_in: pending
user_verified: pending

## 来源

开发者反馈 F50（2026-11-22T11:53:02+00:00 登记）

## 问题

日常 DSH 的产品定位对话（会话 session-634d2b46，第 9 到 12 轮，模型 gpt-6-astra (lmu-gpt)）。用户几次认可了新的说法，主助手想把当前目标"厘清 Arcfold 在多样化 agent 生态中的产品定位与生态位"改名，前后调用了 11 次 arcfold_revise_goal，op 都是 rename。

每次调用都带了 `parentId: ""`，每次都返回 `parentId is only for move`。主助手在第 11 轮回复里说"这次去掉 parentId 再试"，实际发出的参数里还是带着空的 parentId；连续重复后被框架提示"重复了同样的调用"。目标名到现在没有改，目标树里这几轮没有任何改名记录。开发者重启过日常 DSH，问题照旧。

原因在 `src/tree/tools.mjs:62`：op 不是 move 时，只要参数里有 parentId 字段就拒绝，不看内容是不是空的；`src/tree/tree.mjs:143` 有同样的检查。这条检查是 PR #61（交付 051）加 move 时引入的，随 0.7.0 + main@21f8624 进了日常。工具定义里 parentId 是选填，但这个模型每次都把它填成空字符串，看到报错也没有去掉。所以用这个模型时，rename、create_child、add_parent、switch 都会因为这个字段失败。

这和 PR #58 修过的"switch 带空 name 被拒绝"是同一类问题。

## 方案

`arcfold_revise_goal` 收到 parentId 时，先看内容：

1. parentId 是空字符串或只有空白：当作没填，从参数里去掉，后面的检查和写入都按没填处理。
2. op 不是 move 且 parentId 有实际内容：仍然拒绝，报错改成"parentId 只用于 move，其他操作不填 parentId"。
3. op 是 move 时不变：parentId 必须是有效的上级目标，空的照样报错。

tree.mjs 里的同样检查保持不动，因为去掉空字段后不会再收到。工具说明和其他操作的生效时间、范围检查、版本检查都不变。

## 预期效果

同样的调用（rename 带空 parentId）直接改名成功，下一步就用新名字，回复里说明改成了什么。真的给非 move 操作填了上级时，模型从报错里知道要去掉这个字段。

## 考虑过的其他做法

- 只改提示词让模型别填 parentId。放弃原因：这次模型自己说了要去掉，发出去的参数还是带着，只靠提示不可靠。
- 把 move 拆成单独的工具，其他操作不再有 parentId 参数。放弃原因：工具清单要变，改动和验收面都更大；问题只是校验太严。
- 所有选填字段的空字符串都统一当作没填。放弃原因：name 的空值已在 #58 按操作分别处理过，统一改会碰到 rename 这类必填名字的判断，超出这次的问题。

## 验收标准

- 模型拿到的工具和原版 DSH 一致：未安装 Arcfold 时用 standard 取原版完整工具基准；安装后 arcfold-main 核对 bash、read、write、edit、glob、grep（Arcfold 会关闭 standard）。实际会话 request/header 与模拟服务收到的清单均须核对，缺项判失败。

- rename 带 `parentId: ""` 或只有空白时改名成功，当步生效，目标树记下这次改名。有测试。
- create_child、add_parent、switch 带空 parentId 时照常成功。有测试。
- 非 move 操作带有内容的 parentId 仍被拒绝，报错写明不填 parentId。有测试。
- move 带空 parentId 仍被拒绝；move 原有测试、035、038、045、051、059 原有的修改目标测试全部通过。
- 日常观察（不作为发布条件，单独记录）：在新的日常叠加里，让主助手改一次目标名，看是否一次就改成、下一轮显示新名字。

## 风险

- 空白判断只针对 parentId；模型如果以后在别的选填字段上填空值，还会遇到同类报错，要另外处理。
- 合入后要重新做日常叠加，开发者才能在日常里看到效果；在那之前日常里的改名仍会失败。
