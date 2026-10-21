# Nezha v0.34.1 发版公告

Nezha v0.34.1 正式发布！本版本为补丁修复：解决任务退出后终端「拖不中选区、滚轮失灵」的残留问题。

## 🐛 问题修复

- **任务退出后清除终端残留的鼠标上报模式**（`d62d1a8`）：在智能体 PTY 里跑过的全屏 TUI、分页器、交互式安装器，可能通过 DECSET 1000/1002/1003 开启鼠标上报后，在一条不发 DECRST 的路径上直接退出。此时 xterm 会继续把每次拖选和滚轮事件转发给已经死掉的 PTY 对端——表现为拖拽划不出选区高亮、滚轮不再本地滚动，只能靠 Shift+拖选 / Shift+滚轮应急。现在任务退出时（从 pending / running / input_required / awaiting_review 进入其他状态），TerminalView 会向渲染端解析器写入 CSI ?1000l ?1002l ?1003l ?1006l，恢复本地选区与滚动。该写入只走 `term.write`：只重置本终端的模式，不进入 PTY 的 stdin 方向，也不会回流到 onData。重置按 `mouseTrackingMode !== "none"` 门控——正常退出的任务不会多写任何字节，恢复一个早已退出的任务也不会触发额外重置。

## 📦 下载

| 平台 | 架构 | 安装包 |
|------|------|--------|
| Windows | x64 / ARM64 | `.exe`（NSIS）/ `.msi` |
| macOS | Apple Silicon / Intel | `.dmg` |
| Linux | deb / rpm | `.deb` / `.rpm` |

安装包由 Release workflow 自动构建并附加在本 Release 下。

**Full Changelog**: https://github.com/Alohazzz/nezha/compare/v0.34.0...v0.34.1
