# 决策：[055-D1] 公开 README 还写着候选 0.5.4，与已发布的 0.7.0 不符

Status: proposed
observed_in_version: 0.7.0
fixed_in: pending
user_verified: pending

## 来源

Murphy 原话：可以 按你的建议来

## 问题

有人打开公开仓库首页，第一段看到的是「开发候选」「候选 0.5.4」「尚未完成公开发布及真实模型连接验收」。实际上 0.6.0 和 0.7.0 已经在 GitHub 和 npm 正式发布（v0.7.0 发布于 2026-11-21 14:08 UTC+8）。README 也没写这个插件现在能做什么，只写了模型配置的细节。证据：main 上的 README.md（截至 bb7d44f）、GitHub Release v0.7.0、npm `@arcfold/dsh@0.7.0`。

## 方案

只改 README.md，并按惯例附 `changes/readme-current-release.md`（README 会随 npm 包发出）。新 README 全文：

```markdown
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
```

旧 README 里 0.4.x 升级、费用记录和计数环境的几句移走不再写；升级注意已在 CHANGELOG 各版本里。

## 预期效果

第一次打开仓库的人能在半分钟内知道：这是什么、现在是哪一版、能做什么、哪些还没验证。表述不超过已有证据。

## 考虑过的其他做法

- 只把「0.5.4」改成「0.7.0」：最省事，但第一段仍然只讲模型配置，看的人还是不知道插件做什么。
- 等下一次发行时在发行提交里一起改：发行提交只允许改版本文件和 CHANGELOG，README 不能放进去，所以还是要单独一个功能交付。

## 验收标准

- 模型拿到的工具和原版 DSH 一致：未安装 Arcfold 时用 standard 取原版完整工具基准；安装后 arcfold-main 核对 bash、read、write、edit、glob、grep（Arcfold 会关闭 standard）。实际会话 request/header 与模拟服务收到的清单均须核对，缺项判失败。
- README 全文与本决策「方案」一致；文中链接都能打开；没有「候选」「尚未完成公开发布」这类过时说法。
- 只改 README.md 和更新说明，CI 通过。

## 风险

- 「能做的事」写的是 CHANGELOG 里已发布的功能，不代表效果已经被验证；所以单列「还没验证的」一段。
- main 之后的 050、051、053、054 还没发行，README 不写这几项，等它们发行时再更新。
- 安装步骤没有写进 README：桌面插件页的实际安装路径我没有在本次核对过，写错比不写更糟。
