# 第三方组件说明

Arcfold 自身贡献采用 [MIT 许可证](LICENSE)。本仓库同时包含或依赖第三方组件，它们的版权与许可不因项目选择 MIT 而改变：

- `src/desktop/vendor/` 包含 DeepSeek 的适配代码及其 [MIT 许可](src/desktop/vendor/LICENSE.deepseek)和[来源说明](src/desktop/vendor/NOTICE.md)。
- `src/tree/tokenizer-resources/` 包含 DeepSeek 的分词资源及其 [MIT 许可](src/tree/tokenizer-resources/LICENSE)、[V4 说明](src/tree/tokenizer-resources/tokenizer-v4-NOTICE.md)和 [V4.1 说明](src/tree/tokenizer-resources/tokenizer-NOTICE.md)。
- 同目录的 `deepseek_recipe` 0.2.0 wheel 保留原包中的 MIT 许可、OpenCV 等原生库声明和依赖清单。核心包的 `src/desktop/third-party/` 另外保留该清单中 332 项依赖的许可材料及 Rust 标准库声明，逐项来源、摘要和许可选择见 `manifest.json`。
- Desktop 核心包内的 `runtime/desktop-python.tar.gz` 是 [Astral Python Build Standalone 20260901](https://github.com/astral-sh/python-build-standalone/releases/tag/20260901) 的 CPython 3.12.14 Apple arm64 精简安装原包。CPython、pip 及其随附依赖的许可仍在原包中；完整版提供的底层库许可另存于 `src/desktop/third-party/python/`。
- 上述两个归档未作修改。分词器中的 MPL-2.0 组件 option-ext 0.2.0 的未修改源码可从 [原版本源码归档](https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate) 取得；摘要与许可全文见核心包的第三方清单。
- npm 安装时另行取得的依赖保留各自的版权与许可，以锁定文件和上游包为准。它们未合并到 Arcfold 的两个发行归档中，不能把本次随包组件核查理解为全部 npm 依赖的法律审查。
- 界面包由宿主提供 React，没有把 React 实现代码打入 `lib/client.js`。本说明由两份发行包共同保留；上面列出的 Python、wheel 和补充材料只在核心包中。

工程核查范围与复核入口见仓库的 `docs/release-license-notices.md`；随包可读索引见核心包的 `src/desktop/third-party/README.md`。第三方许可不被 Arcfold 的 MIT 许可替代。
