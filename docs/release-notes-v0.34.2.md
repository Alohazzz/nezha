# Nezha v0.34.2 发版公告

Nezha v0.34.2 正式发布！本版本为补丁修复：解决 Codex 任务运行期间终端「Shift+滚轮失灵」的问题，并升级依赖修复两处 Rust 安全公告。

## 🐛 问题修复

- **Codex 任务运行期间恢复 Shift+滚轮本地滚动**（`dfdaec0`）：Codex 0.16x 的 TUI 在任务运行期间就会开启鼠标上报（DECSET ?1000h/?1002h/?1006h），xterm 会把滚轮事件转发给 PTY 对端而不是本地滚动——表现为任务运行中终端「滚不动」。v0.34.1 的退出时重置只覆盖任务结束后的残留状态，本次处理的是运行中的场景：Shift+滚轮现在由终端容器在捕获阶段拦截——备选缓冲区（全屏 TUI）下合成方向键发给 TUI 让它自己滚动（遵循 DECCKM 应用光标模式，与 xterm 自身合成行为一致），普通缓冲区下直接本地滚动。普通滚轮行为不变，仍走 xterm 原生分发。

## 🔒 依赖安全升级

- **rustls-webpki 0.103.16 / webpki-root-certs 1.0.10**（`69e498b`）：修复 cargo audit 报出的两处安全公告——RUSTSEC-2026-0382（证书校验可能接受已不信任的中间证书）与 RUSTSEC-2026-0383（内置根证书信任已不信任的 emSign 中间证书）。仅 lockfile 补丁升级，无 API 变化。

## 📦 下载

| 平台 | 架构 | 安装包 |
|------|------|--------|
| Windows | x64 / ARM64 | `.exe`（NSIS）/ `.msi` |
| macOS | Apple Silicon / Intel | `.dmg` |
| Linux | deb / rpm | `.deb` / `.rpm` |

安装包由 Release workflow 自动构建并附加在本 Release 下。

**Full Changelog**: https://github.com/Alohazzz/nezha/compare/v0.34.1...v0.34.2
