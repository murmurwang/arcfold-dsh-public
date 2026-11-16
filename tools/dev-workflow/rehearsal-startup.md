# 测试账户自动启动

开发者批准固定测试材料后，主账户把请求放入共享交接目录。普通账户的后台程序在已登录的图形会话中领取请求，调用原版 DSH 测试入口，核对进程、资料目录和可读取的真实页面，再写回就绪记录。主账户据此继续测试，无需每次找 Finder 目录、保留终端或手写窗口已打开。

首次仍须登录普通账户配置后台程序；退出登录、重启或系统要求验证时仍须完成系统登录。后台图形能力和切回主账户后的真实窗口操作须另外实测。离线检查、窗口就绪与发行验收通过是三种不同结果。

## 首次设置

在已合入且核对过的开发入口运行：

```sh
Arcfold-DSH-Development rehearsal-service prepare --output /absolute/staging-directory
```

此步只生成安装计划及固定脚本，不修改测试账户。计划绑定普通账户 `arcfold-test` 的用户编号、固定 Python/Node 程序内容、后台脚本、测试控制脚本，以及指定共享交接目录。用 `ask` 创建绑定 `enable-plan.json` 内容摘要的授权单，展示实际安装位置与后果，按用户原话 `answer`。

```sh
Arcfold-DSH-Development rehearsal-service enable --plan /absolute/enable-plan.json --approval A编号
```

此步把批准的固定材料放到主账户拥有的共享目录。首次由开发者切入测试账户，运行返回的 `Configure-Test.command`。它核对账户非管理员、内容摘要和运行程序，再安装该账户的登录后台程序（macOS 的 LaunchAgent）。只在 `gui/用户编号` 图形会话登记，不保存密码，不启用自动登录。重新运行相同安装不重复登记；内容不同的安装项被拒绝。

主账户拥有请求目录；测试账户拥有回执目录，各自只允许所有者写入。测试资料和完整日志放在测试账户的私人目录；共享回执只包含本次测试状态和合成验收证据。本机文件是内容与步骤核对，不是身份认证。此机制防止误用其他材料，不能阻止同一账户蓄意改写自己的文件。

## 每次测试

先通过已有 `rehearsal/prepare.py` 制备固定材料。后台只接受安装时登记的原版测试控制脚本；不会执行临时改写的 `Start-Test.command` 或 PR 提供的任意命令。历史测试包若使用临时适配脚本，需由原任务重新核对并制备，不能直接接管。

```sh
Arcfold-DSH-Development rehearsal prepare --kit /absolute/test-kit --output /absolute/session.json --expires-at 时间及其时区
```

计划列出准确源码、旧版和新版、四份产品包及依赖归档、测试脚本摘要、账户、后台版本、到期时间。固定范围为：最多 4 次窗口启动、16 个步骤、零真实模型请求。后续步骤只允许 `launch`、`restored`、`finish`、`git`、`git-section`，分别对应原有窗口启动、失败更新后恢复检查、重启读回验收、Git 来源窗口和版本区块检查。

用 `ask` 绑定计划文件，用户批准并用 `answer` 登记后：

```sh
Arcfold-DSH-Development rehearsal enqueue --plan /absolute/session.json --approval A编号
Arcfold-DSH-Development rehearsal status --job 返回的任务编号
Arcfold-DSH-Development rehearsal step --job 返回的任务编号 --step restored
```

请求在所有材料复制完后才公布；重复提交同一计划返回原任务。另一个批准也不能把同一测试包作为新任务重复启动。确实需要关闭后再打开时，核对上一动作的回执，再对原任务发出 `launch`。

测试后台重新核对计划、期限、所有者、权限和摘要。真正打开窗口仍走 `rehearsal/run.mjs → desktop.mjs → launch()`，保留原有应用签名、固定应用归档、普通账户、私人资料和本机模拟服务检查。新的 `rehearsal_probe.mjs` 只读取进程表和本机窗口：要求进程用户、资料目录、调试端口所有者一致，页面地址为原版 DSH，页面已完成或正在完成加载且有可读取内容。回执保存内容摘要，不抄出页面全文。

## 状态与恢复

| 状态 | 实际含义 |
|---|---|
| `waiting_session` | 未收到有效后台回报，或回报超过 90 秒；需要核对测试账户登录与后台状态 |
| `starting` / `checking` | 已持久记录本次动作，正在启动或执行固定检查 |
| `ready` | 已核对真实进程和可读页面；不等于安装、对话、更新或发行验收通过 |
| `window_closed` | 上一测试入口已退出，可以按同一计划继续 |
| `waiting_window_exit` | 另一测试窗口或尚未核清的动作占用执行位置，不再启动 |
| `checked` | 该固定检查退出成功，附原始证据及摘要；检查自身的未知或失败字段原样保留 |
| `unknown` | 启动或检查结果未确认；保存尝试、进程和私人日志，不自动重做 |
| `request_rejected` | 账户、授权期限、材料或交接格式不符，停止该任务，需核对原记录 |
| `cancelled` | 停止未开始的后续动作；已有窗口保留 |

后台崩溃后，只能通过记录中的同一进程和真实窗口恢复 `ready`，不会再发一次启动。未记录进程的崩溃、已结束但结果不明的检查，以及被拒绝的请求都保持停止，需人工核对原测试日志与证据；此版本不提供强制跳过未知状态的命令。端口已占用时原测试入口拒绝启动，不杀死未知进程。

`finish` 等检查只导出规定的合成证据文件。真实验收仍由 `release.py` 按源码、安装包摘要和逐项回执核对。当前版本没有自动点击安装、更新按钮或替代体验判断。

## 暂停、取消与移除

```sh
Arcfold-DSH-Development rehearsal-service pause
Arcfold-DSH-Development rehearsal-service unpause
Arcfold-DSH-Development rehearsal cancel --job 任务编号
Arcfold-DSH-Development rehearsal-service prepare-remove --output /absolute/remove-plan.json
# 用 ask/answer 批准绑定的移除计划后：
Arcfold-DSH-Development rehearsal-service remove --plan /absolute/remove-plan.json --approval A编号
```

后台在材料核对后、调用固定程序前再次读取停止标记。已开始的动作不会强行终止；跨账户取消不构成与操作系统启动的原子事务。移除只停止新动作，并在现有窗口退出且没有未知动作后由测试账户删除自己的登录项，保留资料、日志和证据。

## 验证边界

`python3 -B -m unittest discover -s tools/dev-workflow -v` 使用临时目录和合成批准，检查固定材料、权限、篡改、重复排队、崩溃恢复、暂停取消、心跳过期和证据原样转交；进程启动被模拟，不配置真实用户。Node 检查验证进程匹配条件。

真实跨账户目录权限、首次安装、已登录但不在前台的窗口、退出登录、重启及卸载行为须在批准具体计划后验收；未运行之前记为 unconfirmed。此实现不为现有测试窗口补写 pass。
