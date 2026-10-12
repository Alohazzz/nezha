# Nezha v0.31.0 发版公告

Nezha v0.31.0 正式发布！本版本两大重点：**方案预览弹窗支持 HTML 富文本预览**（讨论 agent 渲染的 preview.html 直接展示，缺失时回落 Markdown），以及**云效写回「修改文件」按 .csproj 工程级归并**（.NET 解决方案下不再把多个工程合并成一个名字）。

## 🚀 新特性

### 方案预览（plan）

- **方案预览弹窗支持 HTML 富文本**（`f38a867`）：方案预览弹窗正文现在优先展示讨论 agent 随 plan.md 同批渲染的 preview.html——排版、代码块、表格以富文本呈现，而非 Markdown 平铺。预览内容严格保证与将被切片执行的方案文本一致：以文件修改时间判定新鲜度（html 不旧于 md 才采用），缺失、过期或读取失败一律自动回落到 Markdown 展示。弹窗同步放大到更大的默认尺寸，阅读长方案更舒适；复制回复按钮的提示词 fallback 在弹窗内可用。

## 🐛 问题修复

- **云效写回「修改文件」按工程级归并**（`ae18433`）：云效回写的「修改文件」字段此前把改动路径折叠到仓库一级目录，.NET 解决方案下多个工程的产物（如 `Hsp.Win/obj/Debug/x.dll`、`HspSQL/...`）全部归并成同一个名字，名实不符。现在沿路径向上归并到最近含 .csproj 的工程目录这一级（obj 产物归属所在工程），非工程文件回退一级目录，回写的文件列表能准确反映各工程的真实改动。同时修复中文路径被 git 转成八进制转义后名字带前导引号的问题，以及截断提示计数不准的问题。

## 📝 文档

- 无文档变更。

## 📦 下载

| 平台 | 架构 | 安装包 |
|------|------|--------|
| Windows | x64 / ARM64 | `.exe`（NSIS）/ `.msi` |
| macOS | Apple Silicon / Intel | `.dmg` |
| Linux | deb / rpm | `.deb` / `.rpm` |

安装包由 Release workflow 自动构建并附加在本 Release 下。

**Full Changelog**: https://github.com/Alohazzz/nezha/compare/v0.30.0...v0.31.0
