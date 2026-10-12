# Nezha v0.30.0 发版公告

Nezha v0.30.0 正式发布！本版本包含两大重点：**任务列表分组支持折叠**（折叠状态按项目持久化），以及**云效议题提交自动携带 closed 关键字**（提交即自动标记开发完成）。另修复 Windows 上 npm 安装的 codex headless 调用全部 spawn 失败的问题。

## 🚀 新特性

### 任务面板（task）

- **任务列表分组可折叠**（`0b80177`）：任务列表的分组头（attention / main / worktree / plan）现在可以点击折叠，带旋转箭头与右对齐的数量徽标。折叠状态按项目持久化在 localStorage（惰性清理过期键）；搜索时强制展开所有分组；点击被折叠分组内的任务会自动展开所在分组将其显出。任务多的项目现在可以把不关心的分组收起来，列表一眼见底。

### 云效集成（yunxiao）

- **提交信息自动追加 closed 关键字**（`d07cb4d`）：云效按提交信息中的 closed 关键字自动把议题标记为开发完成。现在议题关联提交（`git_commit` 兜底、冲突解决提交、UI 提交预览、执行提示词协作约束）都会在缺 closed 时自动补上 `#议题号 closed`；提交信息已含 closed 的只补议题号，不会重复追加。提交提示文案同步更新，明确说明会自动关闭议题。修复流程走到「提交即完成」，不再需要手动去云效改状态。

## 🐛 问题修复

- **Windows 上 codex headless 调用 spawn 失败**（`eadd60b`）：Windows 上 npm 安装的 codex 是 `.cmd` 垫片，Rust 对批处理脚本的 BatBadBut 防护会拒绝含双引号的参数（batch file arguments are invalid），导致任务命名、云效回写、合并审查等所有 headless 调用全部 spawn 失败。现在配置参数不再经 shell 传双引号，直接使用 TOML 字符串裸值，已实测 codex 0.161.0 接受 `approval_policy=never` 与 `model_reasoning_effort=low`。

## 📝 文档

- 无文档变更。

## 📦 下载

| 平台 | 架构 | 安装包 |
|------|------|--------|
| Windows | x64 / ARM64 | `.exe`（NSIS）/ `.msi` |
| macOS | Apple Silicon / Intel | `.dmg` |
| Linux | deb / rpm | `.deb` / `.rpm` |

安装包由 Release workflow 自动构建并附加在本 Release 下。

**Full Changelog**: https://github.com/Alohazzz/nezha/compare/v0.29.2...v0.30.0
