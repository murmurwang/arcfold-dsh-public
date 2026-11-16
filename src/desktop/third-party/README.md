# 随包组件许可

本目录随 Arcfold 核心包提供，补足原始 Python 精简包和 DeepSeek 分词 wheel 的许可材料。第三方归档保持原字节；这里的文本不会参与模型调用。

| 材料 | 对应内容 | 来源与范围 |
| --- | --- | --- |
| `python/` | CPython 3.12.14 及底层库 | 同一 20260901、Apple arm64 完整构建中的 19 份原文；保守保留完整版的额外声明 |
| `recipe/` | DeepSeek wheel 的 MIT 许可与原生库声明 | 从原 wheel 原样复制；原件也保留在 wheel 中 |
| `cargo/` | wheel 依赖清单列出的 332 项组件 | 327 份公开源码归档先与 wheel 清单的 SHA-256 核对，再提取许可；另外 5 项 DeepSeek 自有组件使用 wheel 的 MIT 许可 |
| `rust/` | wheel 使用的 Rust 标准库 | 根据原二进制中的编译器提交识别 1.97.1，保留该版本官方发行包的版权和许可说明 |
| `manifest.json` | 每项组件、原路径、来源、摘要与文件对应关系 | 不包含上游清单中的本机构建路径；可按来源重新取得并核对 |

wheel 的依赖清单注明覆盖所有目标平台。因此这里也保留 Windows、UEFI 和构建依赖的声明，不声称 332 项全都实际链接进 macOS 二进制。公开源码归档没有许可文件的条目，从归档记录的上游提交补足；两个 winapi 平台包则核对对应上游目录的包名和 0.4.0 版本，再取原许可。r-efi 使用其提供的 MIT 选项，完整 AUTHORS 原文同时保留。

Python 构建清单提到 `LICENSE.zlib-ng.txt`，但该目标实际链接系统 zlib，完整版也没有这份文件。清单逐项记录系统链接证据，没有把 zlib-ng 写成已随包再分发。原包中的 CPython、pip 及 pip 随附组件许可继续保留。

MPL-2.0 组件 **option-ext 0.2.0** 的未修改源码在 <https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate>，SHA-256 为 `04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d`。其许可全文位于 `cargo/66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172.txt`。其他组件的源码链接与适用许可保留在清单中。

发行构建核对清单的固定摘要、两个原归档的摘要和每份许可文件。这个检查防止已核对材料在打包时丢失或被改动，不替代对新版本、新依赖或许可变化的人工审阅。npm 另外下载的包和宿主提供的 React 不属于本目录再分发的二进制范围。
