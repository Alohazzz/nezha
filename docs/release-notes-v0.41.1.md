# Nezha v0.41.1 发版公告

Nezha v0.41.1 正式发布！本版聚焦 Codex structured 模式的输入流畅度：修复回合流式输出期间在输入框打字卡顿、回显延迟、快速输入出现重复字符的问题。

## ⚡ 性能优化

### Codex 结构化流（codex）
- **修复回合流式输出期间打字卡顿与重复字符**（`1f1faf4`）：此前每个流式帧刷新都会更换 entries 数组并触发整个 CodexStreamView 重渲染，未 memo 化的输入框（CodexComposer）随之一起重渲染，与每次按键的受控回显争抢主线程——表现为回显延迟、快速输入时字符重复。本次将 CodexComposer 包裹 `memo`，把 CodexStreamView 中每次渲染新建的 `onSetModel` / `onSetEffort` 内联回调提升为 `useCallback` + ref 读取，并移除 `onChange` 中冗余的 `autoResize()` 调用（`[text]` effect 已覆盖所有文本路径，多余调用使每次按键的强制重排翻倍）。已通过渲染计数回归测试验证：5 个流式帧 = 0 次输入框多余重渲染。

## 📦 下载

| 平台 | 架构 | 安装包 |
|------|------|--------|
| Windows | x64 / ARM64 | `.exe`（NSIS）/ `.msi` |
| macOS | Apple Silicon / Intel | `.dmg` |
| Linux | deb / rpm | `.deb` / `.rpm` |

安装包由 Release workflow 自动构建并附加在本 Release 下。

**Full Changelog**: https://github.com/Alohazzz/nezha/compare/v0.41.0...v0.41.1
