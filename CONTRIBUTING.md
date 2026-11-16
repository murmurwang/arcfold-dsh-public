# 参与开发

先用 Issue 说明实际场景与预期，再在独立分支修改；提交 Pull Request 时按照“动机、改动、测试、AI 参与”说明。故障、功能和普通任务分别使用仓库提供的模板。

不要在仓库、日志、截图或问题记录中放入密钥、私人对话、用户文件或真实请求内容。测试使用独立目录、合成材料和模拟模型；真实付费模型请求必须先有明确授权，不自动重发结果未知的请求。

多个任务使用各自目录推进，只等待实际消费的前置结果。受管入口支持步骤计划、并行离线检查、提前提交草稿和准备材料；最终组合仍重新检查和独立审阅。插件功能可先交付待发行源码，再由单独任务组装完整发行。字段、恢复方式、并发上限和分阶段启用条件见 [并行开发说明](tools/dev-workflow/parallel-development.md)。这些工程机制不代表某个发行已通过用户验收。

Desktop 专项检查使用 macOS Apple Silicon、Node.js 24.15 和 Python 3.12。先按锁定文件安装依赖并禁用安装脚本，再将 `ARCFOLD_PATCH_TEST_INSTALLATION` 指向该依赖目录、`ARCFOLD_TREE_ENCODING_PYTHON` 指向 Python 可执行文件，运行 `node scripts/test-isolated.mjs test/desktop-adapter.test.mjs test/desktop-configuration.test.mjs test/desktop-setup.test.mjs test/desktop-tree-integration.test.mjs`。脚本只在独立副本装配依赖并运行模拟检查。完整检查还需要项目维护的冻结资源与不公开的历史测试材料；缺少这些材料时，应记录未运行的范围，不能将专项通过称为完整通过。

自动检查工作流是候选配置；实际仓库的运行环境、权限和保护规则需在发布前演练。对无法复现的结果，列出缺少的条件和失败日志，不将跳过或未验证记为通过。

呈现方式参考 [DSH 改动说明模板](https://github.com/deepseek-ai/deepseek-harness/blob/master/.github/pull_request_template.md)及其[故障](https://github.com/deepseek-ai/deepseek-harness/blob/master/.github/ISSUE_TEMPLATE/bug.md)、[功能](https://github.com/deepseek-ai/deepseek-harness/blob/master/.github/ISSUE_TEMPLATE/feature.md)、[任务](https://github.com/deepseek-ai/deepseek-harness/blob/master/.github/ISSUE_TEMPLATE/task.md)模板；Arcfold 按已确定的中文四段结构填写，不要求无法核实的 AI 参与比例。
