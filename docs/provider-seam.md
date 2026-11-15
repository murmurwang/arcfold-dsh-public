# DeepSeek Messages：每次调用独立的发送入口

当官方适配器准备发送一轮模型请求时，先向应用取得这一轮专用的发送器。应用可在准备图片、读取认证或上传之前拒绝不支持的输入；正文仍由官方代码序列化，返回的流仍由官方代码解释。补丁不参与对话循环，也不拥有预算、重试或费用结算。

该接口已纳入接受的计费组件，并经过离线补丁检查与本地模拟网页运行验证。下文保留实现及源码开发验证方法；每次新安装仍须核对实际加载的包，既有验证不替代新安装和真实模型效果验收。

## 固定来源与最小变化

固定 npm 包 `@deepseek-ai/dsh-llm-deepseek@0.2.2-rc.1`，对应官方发布提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。只读参考来自旧隔离宿主的发布包；旧宿主及研究源码不改。

- `lib/index.js` 对应源码 `packages/llm/llm-deepseek/src/adapter.ts:91` 的 `request()`：第一个取消检查之后，图片准备之前，调用一次同步 `createTransport(options)`。返回值须是含 `send` 函数的对象；抛错、Promise、缺字段均拒绝，没有后备网络通道。
- 原 Messages `fetch` 改为本次对象的 `send`。现有循环若再次走到发送点，仍是同一对象；其第二次发送由应用发送器拒绝。本补丁自身不替应用计次。
- 没有 `createTransport` 时，使用 `(url, init) => fetch(url, init)`，保留正确绑定和现有默认行为。未修改 Files API、模型目录请求、序列化、SSE 解析、翻译、终止、认证错误映射或其他 `fetch`。
- `lib/types/types.d.ts` 声明可选接口；`lib/types/host.d.ts` 扩展注册函数的 `Pick`。官方 `registerDeepSeekProvider` 在源码 `host.ts:54` 已通过 `...dependencies` 原样转交参数，不需要增加服务名或修改其运行逻辑。

```ts
createTransport?: (options: GenerateOptions<string>) => {
  send(url: string, init: RequestInit): Promise<Response>
}
```

`options` 是这一轮适配器实际收到的完整输入，不是最终网络正文；高层 LLM 服务可能已做文件或图片转换，所以应用还必须在转换之前守住其支持范围。最终网络字节在 `send` 的 `init.body`，认证头只在内存传递，不写入审计。`init.signal` 是官方本轮取消/空闲超时控制合成后的信号，不得换掉。回调是同步的：先检查输入并建立局部身份；预留、原件保存、发送及结算由异步 `send` 完成。

## 自有 Cordis provider 的接法

root 的薄插件注入自有发送服务、LLM 注册和官方凭据服务。使用官方 `registerDeepSeekProvider(ctx, route, dependencies)`，在依赖中显式传 `createTransport: options => 自有服务.createTransport(options)`；连接与凭据仍通过 `options` / `resolveAuth(connection)` 接入现有公开合同。这样不用复制官方 API-key 插件、serializer 或 translator，也不用修改全局 fetch。

应用启动必须同时核对两个事实：只读 `inspectDeepSeekPatch(packageDir)` 返回 `state === 'patched'`；实际已导入的 `registerDeepSeekProvider.transportSeam` 为 `deepseek-messages-create-transport-v1`。标识通过 `Object.defineProperty` 固定在函数上，不可写、不可重新定义，类型声明使用同名 namespace 的 const。若进程先加载原版、随后仅修改磁盘，ESM 缓存仍持有无标识的旧函数，必须拒绝计费注册，不能只凭磁盘哈希放行；新进程或重新加载模块后仍须双重检查。再注册必须含发送器的 provider。原生未计费路由应在 Arcfold profile 中禁用；不能因为官方默认 callback 可省略，就把应用缺失的计费服务当成合法省略。若部署使用 npm 打包，root 需把该检查脚本和固定 patches 清单纳入自己的 `package.json.files`；本任务不修改 package 或预算/发送实现。

此 seam 只覆盖 Messages 请求。首版应用须在回调中拒绝真实图片/文件/文档等会触发其它网络路径的块，同时在最终 wire 阻断服务端工具、文件引用与未知扩展字段。不能把普通文本中出现“图片”二字当成附件。模型目录是否开放由 provider 的受信配置决定，补丁不将该流量伪装成 Messages 计费。

## 可复现离线安装

`patches/deepseek-0.2.2-rc.1-transport.json` 是唯一可执行补丁清单：完整 before/after SHA-256 与唯一字符串替换。`.patch` 是供人审阅的同一差异。脚本不运行 npm、不联网、不自动寻找目标，也没有默认旧宿主路径。

```sh
# PACKAGE_DIR 必须来自 root 新建的隔离安装；先只读检查。
node scripts/patch-deepseek-transport.mjs --package-dir "$PACKAGE_DIR"
# RECEIPT_DIR 必须是全新目录，其父目录已存在。
node scripts/patch-deepseek-transport.mjs --package-dir "$PACKAGE_DIR" \
  --apply --receipt-dir "$RECEIPT_DIR"
```

`inspectDeepSeekPatch(packageDir)` 验版本与全部三文件字节，只有全部 original 或全部 patched 两种状态合法。`applyDeepSeekPatch({packageDir,receiptDir})` 在任何替换前计算全部结果，独占创建回执目录，备份原字节，再复核全部输入并逐文件原子替换，最后核全部 after 哈希。已补版本可以再次核验并保存新的无改动回执；旧回执不可覆盖。未知或混合状态立即拒绝，不猜测升级路径。多文件写入不是跨文件事务：中途失败保存已替换列表与原件，不自动重跑或回滚，应在新安装重做。root 不应同时让其它写入者修改目标包。

| 发布文件 | 原 SHA-256 | 补后 SHA-256 |
| --- | --- | --- |
| lib/index.js | 955dc7bc7ca6c857ff4a7e373b87c143b96a4c43fc80325b67dc0982600dcc75 | fc27ceacbed59c8d32100f3aa41cf79e1acab403ac0bc12b0e7f807a6274c752 |
| lib/types/types.d.ts | 8949419d7ed87dd227132dc331909c3e234ee2aebe72ca9c57569fa426ee062d | a3a7284f64c5467e4bc359b9e79050f190c389c6807e6f30c75f475d9ab95c7a |
| lib/types/host.d.ts | c80712e47c5909c85d1e1736c84fa5da698f3493201b7870b4a02dc1e801a4ef | 7b8cf687eacc9045b1ac840c08f6cdbc018e140725c1785cffdcb4c54632b7ea |

## 待 root 统一执行的检查

```sh
node --check scripts/patch-deepseek-transport.mjs
node --check test/provider-patch.test.mjs
ARCFOLD_PATCH_TEST_INSTALLATION="$NEW_INSTALLATION" node --test test/provider-patch.test.mjs
```

环境变量必须指向 root 冻结、包含固定官方完整依赖的只读安装根目录。缺少该资源直接失败，不跳过算通过。测试在 `os.tmpdir()`（受管执行的私有 TMPDIR）内独占创建 `provider-patch-test-*`，所有包副本、补丁回执与匿名 ID 均在该临时目录中保留，绝不写入源安装。临时证据根的 `node_modules` 仅链接冻结依赖供读取；每份目标包位于更近的独立 `node_modules/@deepseek-ai/dsh-llm-deepseek`，所以补丁只作用于副本，不覆盖链接目标。root 需把完整冻结安装列入只读 dependency_paths，并保留私有 TMPDIR 到验收完成。仅绑定 `127.0.0.1` 假服务器，使用固定假凭据，不启动宿主/Agent，不请求模型。

六项测试覆盖：准确安装/备份/幂等/旧回执及未知版本拒绝；同进程旧模块缓存不可因磁盘补丁而冒充已加载新接口；原始发布包与补丁默认路径实际请求及官方译码相等；回调拒绝/非法返回发生在图片、认证和网络之前；直接与 prepared 并发调用各自持有一个独立发送器，最终扩展正文/信号不丢失；真实 Cordis LLM 服务及公开注册函数透传发送器。使用公开注册时所需匿名 ID 保存于测试自己的 DSH_HOME。测试产物保留，不能将本补丁检查代替预算/流中断/本机 421 等发送实现反例、类型构建或正式 profile 的安装与卸载验收。
