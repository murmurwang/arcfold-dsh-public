# 批准后自动执行独立审阅

普通使用顺序是：一次安装与密钥设置 → Agent 准备固定材料并开费用授权单 → 开发者在聊天批准 → Agent 登记答复并排队 → 后台核对、发送、对账与回报。每次一份材料、最多一次实际发送。安装与付费调用分别授权。

## 安装前先准备可核对的材料

在当前登记入口的同一源码版本运行：

```sh
./Arcfold-DSH-Development review-service prepare --output INSTALL_MATERIALS
```

只编译和准备材料，不访问钥匙串、不安装后台程序、不发起模型请求。返回的 install-plan.json 列出源码文件摘要、固定 Python、原生密钥程序、安装位置、用户后台启动配置及实际后果。按其绝对路径与内容摘要开 files 授权单；收到原话后登记 answer，再运行：

```sh
./Arcfold-DSH-Development review-service install --plan INSTALL_PLAN --approval A编号
```

安装程序再次核对计划和文件，打开本机安全输入窗口。密钥保存于非同步的 macOS 钥匙串项，可信读取程序是固定的原生可执行文件，不是通用解释器。它只启动经过摘要核对的审阅进程，不提供读取密钥到标准输出的命令。后台无法弹出钥匙串验证时返回“等待解锁”；用户在本机处理后恢复任务。

本机授权文件不是对同账户恶意程序的认证机制。原生 helper 的 ACL 使用 macOS 仍可用的兼容接口，编译器会给出弃用提示；真实钥匙串授权和重新登录后的行为须单独实测，编译通过不代表这些体验已验收。

## 一次审阅的授权

`review --pr N --provider lmuai` 准备材料。仍然使用原独立审阅提示词、一次工具禁用的模型请求、结构化证据与费用核对。

后台授权在原有 binds.packet 之外，增加 execution 对象，字段均须显式填写：

| 字段 | 含义 |
| --- | --- |
| version | 执行规则版本，当前为 1 |
| provider、model | lmuai、gpt-6.1-terra |
| key_id | 配置完成后生成的密钥指纹；不含原文 |
| max_requests | 当前只能为 1 |
| expires_at | 含时区的发送授权截止时间 |
| max_cost_usd | 开发者本次批准承担的最大金额 |
| cost_bound_usd | 根据已核对依据计算的费用上界，不能取费用估算 |
| bound_evidence | 已通过 binds.files 绑定的计费依据文件绝对路径 |
| publish | 是否允许向同一提案写评论、为报告后续项建立 Issue |

计费依据须注明服务、模型、source、valid_until、verified_by_operator。支持两种格式：

- provider_request_cap：提供 maximum_request_usd，且 covers_inflight 为 true，表示服务方保证覆盖在途请求的上限。
- verified_tariff：提供覆盖全部计费项目的实际 input_usd_per_million、output_usd_per_million、fixed_usd，covers_all_charges 为 true；input_token_ceiling 至少覆盖当前请求上下文上限，output_token_ceiling 至少覆盖最大输出。程序重新计算费用上界。

这份记录是操作者核对实际账号计费依据后的声明，不是程序对服务方的独立担保。**不能把公开起步价、历史大小折算或未经证实的密钥总额度抄成已核对上界。** 无依据时停止后台发送，保留旧人工路径等待明确费用授权。

```sh
./Arcfold-DSH-Development answer A编号 --verdict yes --text '开发者原话'
./Arcfold-DSH-Development review --pr N --provider lmuai --approval A编号 --enqueue
./Arcfold-DSH-Development review-queue status
```

answer 只记录，enqueue 只持久化待执行任务。安装好的用户后台程序每 30 秒处理一次队列；没有合法授权不会发送。固定材料、服务、模型、密钥、执行文件、计费依据或有效期不符均停止。旧的“自己在终端输入密钥”授权没有 execution 条件，不能用于后台模式。

## 状态与恢复

同一密钥在不同提案间串行执行，发送前保存占用与尝试。明确未发送的重启恢复需再次核对条件，最多三次；已开始发送的任务不自动重发。自动恢复不增加模型调用。

- 缺少密钥权限：在本机解锁后使用 review-queue resume --job ID。
- 回复已返回但费用未确认：只查账单，最多自动核对三轮；无法确认时开操作单。
- 发出后断线：保留费用占用并阻止同密钥后续任务。resume 只做只读用量观察，不再次发送。
- 无原始回复时，经服务记录核对后，在原尝试目录登记 billing-reconciliation.json，包含原 client_request_id、outcome、evidence；usage_confirmed 还须填写 actual_cost_usd。reconcile --job ID 对照只读观察结算，不把旧授权重新变成一次发送机会。
- 已有报告但 GitHub 写入不明：只查原评论或 Issue；不重复模型请求。撤回公开授权后只核对既有写入，不创建新对象。
- 代码或检查在审阅中变化：保留原回复和扣费，旧报告不代表当前代码通过。

```sh
./Arcfold-DSH-Development review-queue pause
./Arcfold-DSH-Development review-queue unpause
./Arcfold-DSH-Development review-queue cancel --job ID
./Arcfold-DSH-Development review-queue resume --job ID
./Arcfold-DSH-Development review-queue reconcile --job ID
./Arcfold-DSH-Development revoke-approval A编号 --text '开发者撤回原话'
```

pause 阻止后续发送，cancel 只用于尚未发送的任务；已经发送的请求仍可能计费。撤回不删除原批准和证据。next 的 review_queue 与任务环节读取同一队列记录。

卸载先用 review-service prepare-remove --output FILE 准备对象和影响，再以绑定该计划的授权执行 review-service remove --plan FILE --approval A编号。仍有占用未结算时拒绝卸载；原审阅证据保留。

## 实现与验证入口

- review_policy.py：显式授权、费用依据、实时余额、撤回与共用密钥检查。
- review_queue.py：持久化任务、一次发送、预算占用、对账与恢复。
- review_service.py、review_daemon.py：可审阅安装计划、固定运行版本和后台入口。
- ReviewKeychain.swift、review_native_worker.py：本机输入及密钥读取，仅向固定子进程传递。
- desktop_review_request.py、Workflow.review_result()：沿用模型请求与结果解析；公开写回受显式授权控制。
- test_review_automation.py：合成服务测试，不访问真实密钥或模型。

