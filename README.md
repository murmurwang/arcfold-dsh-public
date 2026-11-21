# Arcfold for DSH Desktop

Arcfold 是 DSH Desktop 上的插件，给长期协作加一棵目标树：每轮对话记在它服务的目标下，助手从协作里学到的理解和做法也挂在对应目标上，下一轮接着用。

当前正式版本是 0.7.0，见 [GitHub Release](https://github.com/murmurwang/arcfold-dsh-public/releases/tag/v0.7.0) 和 npm 上的 `@arcfold/dsh`、`@arcfold/dsh-method-ui`。main 上可能已有还没发行的改动，各版本实际包含什么以 [更新记录](CHANGELOG.md) 为准。

这一版能做的事：

- 输入框上方显示当前目标；每轮对话自动判断归属，用户可以纠正。
- 主助手可以在当轮改目标：改名、拆子目标、加上层目标、转到已有目标，并在回复里说明改了什么。
- 从普通协作中学习：每轮记下少量关于用户和这件事的理解，用户直接说的以后做法记成规则，下一轮起使用；后台会检验已学内容。整理（把内容提到上级目标）在 0.7.0 里很少真正发生，修复还没发行。
- 复用 DSH 自己的模型设置和凭据，主回答和后台处理跟随该轮选的模型。

还没验证的：学习、检验和整理在真实长期使用中是否真的有用；这些只做过离线模拟和开发者本人的少量使用。费用只记录服务商返回的用量，缺失时记为未知。

当前只在 macOS Apple Silicon、DSH 0.2.2-rc.1、Node.js 24.15 上测试。模型配置机制见 [模型配置途径](docs/native-model-configuration.md)，开发和离线检查见 [参与开发](CONTRIBUTING.md)。

本项目采用 MIT 许可证，见 [LICENSE](LICENSE)。第三方组件的版权和许可声明保留在其对应目录。
