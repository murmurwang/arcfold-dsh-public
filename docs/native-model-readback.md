# 原生选模后的页面读回

用户在 Arcfold 会话的原生菜单选择模型时，仍由 DSH 校验并保存。曾在原地更新后出现：服务端记录已是新模型，页面共享状态仍停在旧模型。这里补充一次成功操作后的只读同步，不替换原生选模，不修改宿主应用文件。

## 实际调用链

1. DSH 的 `ModelDirectory.select` 调用 `remote.session.selectModel`；原生服务校验后调用 `agent.model.select`，追加 `model/selection`，并按原规则保存默认设置。
2. 原生目录把可观察状态从 `selecting`（保存中，带 `pending`）改为 `ready`（保存成功，清掉 `pending`）。失败会进入 `error`，连接切换会清掉未完成选择。本适配只观察这些原生状态。
3. `packages/method-ui/src/tree-client.mjs` 在 Arcfold 视图绑定会话时登记观察；`native-model-readback.mjs::watchNativeModelReadback` 在上述成功变化后，仅调用一次 `remote.session.projections({ sessionId })`，读取服务端从记录生成的当前页面状态。
4. 只接受 `sequenced` 结果：包含真实记录顺序编号和完整状态。通过原生 `sessions.handleControlFrame` 交回页面，沿用 DSH 的 `SessionManager` 与 `ProjectionValueStore`。它们只接受比现有记录更新的值，已有新推送不会被旧读回覆盖；模型目录继续从原生共享状态渲染按钮。
5. 后续选择、连接代次改变、会话绑定被替换或界面卸载，会使之前的读回失效。失败只留下固定诊断码 `NATIVE_MODEL_READBACK_FAILED`，不输出服务端原始错误，不凭点击值修改显示，不重试保存或读回。

`installNativeModelReadback` 等原生服务可用后才连接观察；更新导致服务重新创建时，清理旧观察并绑定新的会话对象。只处理已经生成 Arcfold 视图的普通会话，不处理独立子助手地址。不发模型请求，不更改凭据、默认设置、工具权限或回答中选模限制，不重新连接整个页面。

读取 `owner.remote.session` 时，依赖声明须同时包含 `remote` 和 `remote.session`。后者是会话服务，前者是访问它的原生通信入口；原生插件访问检查分别核对二者。漏声明前者会在绑定时抛错，连带中断目标面板的渲染。

## 证据边界

本地测试运行安装依赖中的原生 `ModelDirectory`、原生会话状态接收方法及顺序比较代码，模拟保存和读取的传输及可观察存储。它能复现保存成功而没有推送时的旧显示，并检查补读、迟到结果及清理。它不代替原版桌面窗口升级、下一条实际请求、刷新和重启验收。

服务接线测试由独立插件提供原生服务，并由声明了连接依赖的消费插件安装监听。这样会执行与真实窗口相同的服务访问限制；把所有服务直接放在根环境会让未声明服务也可访问，不能覆盖这次故障。

尚未确认原地更新后持续推送没有更新该页面的更底层原因。本改动只保证观察到原生成功操作后补读权威状态，不宣称修复了宿主全部推送。
