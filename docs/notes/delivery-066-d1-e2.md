# 决策：[066-D2] 检验加强生成的提醒谁也看不到

Status: proposed
observed_in_version: 0.7.0；源码基线 2ee8850
fixed_in: pending
user_verified: pending

## 来源

公开源码中可以复核的行为，基线为 2ee8850。

## 问题

当助手读到一项方法却没有做到时，检验可以为该方法加强提醒。原来的示例会在一轮结束时生成一条提醒用户的记录，主助手在下一轮开始工作时读不到这条自查要求。

## 方案

只改检验的 harden，不改钩子机制本身。

1. 检验提示里 harden 的示例改成"user_message 时 add_context"，并写明怎么选：方法进了输入却没做到，用 user_message + add_context，在用户发话时把提醒放到这条消息旁边；只有能用工具或文件条件判断"本轮没做到"时，才用 turn_end + continue；需要用户亲自处理的事才用 remind_user。
2. 写入 harden 时，程序把"turn_end、remind_user"的钩子改成"user_message、add_context"，消息原样保留，记一条诊断。不因此让整次检验作废。
3. 已经存在的 remind_user 钩子不迁移，保持现状，用户可以在方法界面停用。

## 预期效果

- 在该方法适用的目标上，下一条用户消息会带上加强后的提醒，主助手可以在开始这轮工作时使用它。
- 不增加模型调用。每轮多几十个字的输入。

## 考虑过的其他做法

- 让 remind_user 在界面上显示给用户：这些提醒是写给助手的自查，交给用户等于把检查又推回给人，而 Arcfold 要减少的正是这件事。界面显示另作考虑，不在本任务。
- 一律用 turn_end + continue 让助手回头自查：没有条件时每轮都多一次模型调用和等待；没法用工具或文件判断写作类方法有没有做到，不采用为默认。
- 校验时直接拒绝 remind_user：会让整次检验输出作废，连同其中的支持、漏记一起丢掉，不采用。

## 验收标准

- 模型拿到的工具和原版 DSH 一致：未安装 Arcfold 时用 standard 取原版完整工具基准；安装后 arcfold-main 核对 bash、read、write、edit、glob、grep（Arcfold 会关闭 standard）。实际会话 request/header 与模拟服务收到的清单均须核对，缺项判失败。

- 测试：检验输出的 harden 钩子为 turn_end + remind_user，写入后钩子为 user_message + add_context，消息不变，留下诊断。
- 测试：之后在该方法所在节点范围内的一轮用户消息，钩子运行结果为 matched / add_context，提醒文字进入这一轮主助手的输入。
- 测试：不在该节点范围内的轮次，钩子不运行。
- 测试：harden 为 turn_end + continue 且带条件的，原样保存，行为不变。
- 测试：检验提示里 harden 的示例不再是 turn_end + remind_user。

## 风险

- 无条件的 add_context 每轮都加，提醒多了会被忽略。限定在方法所在节点；检验仍会按效果支持、再加强或撤回方法。
- 旧的 remind_user 钩子仍然无效，只有在下一次检验再加强时才会换成新形式。
