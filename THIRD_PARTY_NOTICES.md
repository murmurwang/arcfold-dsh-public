# 第三方组件说明（待公开审查）

Arcfold 自身贡献采用 [MIT 许可证](LICENSE)。本仓库同时包含或依赖第三方组件，它们的版权与许可不因项目选择 MIT 而改变：

- `src/desktop/vendor/` 包含 DeepSeek 的适配代码及其 [MIT 许可](src/desktop/vendor/LICENSE.deepseek)和[来源说明](src/desktop/vendor/NOTICE.md)。
- `src/tree/tokenizer-resources/` 包含 DeepSeek 的分词资源及其 [MIT 许可](src/tree/tokenizer-resources/LICENSE)、[V4 说明](src/tree/tokenizer-resources/tokenizer-v4-NOTICE.md)和 [V4.1 说明](src/tree/tokenizer-resources/tokenizer-NOTICE.md)。
- 同目录的 `deepseek_recipe` wheel 包内自带 `LICENSE`、`THIRD_PARTY_LICENSES` 和材料清单；其中还包含其他依赖，需一并保留和核查。
- Desktop 核心包内的 `runtime/desktop-python.tar.gz` 保留 [Astral Python Build Standalone](https://github.com/astral-sh/python-build-standalone/releases/tag/20260901) 提供的完整原包。CPython 许可位于包内的 `python/lib/python3.12/LICENSE.txt`，pip 及其随附依赖的许可也在原包内。进一步的发行核查仍按本页下方的范围执行。
- 安装过程中取得的其他依赖以锁定文件和各依赖自身的许可为准；完整依赖许可核查尚未完成。

本页是公开准备的索引，不代表全部第三方授权已经审核完成。
