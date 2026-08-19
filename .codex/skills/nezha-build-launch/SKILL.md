---
name: nezha-build-launch
description: Build and launch the Nezha Tauri desktop app in dev mode with the verified workflow — single-instance conflict preflight, vite cache health, pnpm tauri dev launch, readiness/render verification via WebView2 CDP, and white-screen troubleshooting (504 Outdated Optimize Dep, about:blank, slow first load). Use when the user asks to 编译/构建/启动/运行 Nezha 桌面应用, run tauri dev, or reports a white/blank window in dev.
---

# Nezha 构建启动（dev）

在 `H:\Project\nezha-main` 按已验证流程编译并启动 Tauri 桌面应用，把启动前置检查、缓存排障、就绪验证固化为可重复流程。核心命令是 `pnpm tauri dev`。

## 一键启动（推荐）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .codex/skills/nezha-build-launch/scripts/launch-dev.ps1
```

脚本依次执行：结束冲突的 Nezha 实例 → 启动 dev（隐藏控制台，日志写 `tauri-dev.stdout.log` / `tauri-dev.stderr.log`）→ 等待 vite（1420 端口）与 dev 进程 → 用 WebView2 CDP 验证 React 已挂载（`#root` 有子节点）→ 白屏时自动隔离过期 vite 缓存并重启一次。加 `-ForceFreshCache` 可启动前强制重建缓存；`-RenderTimeoutSec 600` 可覆盖渲染等待上限（默认 360s/轮）。

**快路径（默认）**：dev 已在运行且渲染正常时，脚本直接复用并秒回，不重启。需要强制重新构建/启动时加 `-ForceRestart`。

冷启动慢的根因：全新 vite 实例要按需转换整个依赖图（App.tsx 单文件约 16s+，全图 3-6 分钟）。已在 `vite.config.ts` 配置 `server.warmup.clientFiles` 预转换入口链（main/App/styles/i18n），显著缩短首屏等待；根治方案是把 Shiki/CodeMirror 语言包改成动态 `import()`（见 AGENTS.md 技术债务章节）。脚本会在超时前持续探测，不要提前判白屏。

## 手动流程

### 1. 单实例冲突检查（必须先做）

Nezha 启用 `tauri-plugin-single-instance`，同机只允许一个实例。若安装版（`%LOCALAPPDATA%\NeZha\nezha.exe`）或旧 dev 实例在跑，新 dev 实例会启动即退出（日志停在 `Running target\debug\nezha.exe`，进程列表里没有 dev 进程）。

- 结束冲突实例前先检查其有无运行中的 Agent 子进程：`Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq <pid>`；确认无重要子进程再 `Stop-Process -Id <pid> -Force`。

### 2. vite 缓存健康

症状：白屏 + 日志/控制台出现大量 `504 (Outdated Optimize Dep)`，URL 为 `/node_modules/.vite/deps/*`。

处理：改名隔离（可恢复；`Remove-Item -Recurse` 可能被沙箱策略拦截，优先 rename）：

```powershell
Rename-Item node_modules\.vite .vite-stale-<YYYYMMDD>
Rename-Item node_modules\.vite-temp .vite-temp-stale-<YYYYMMDD>   # 存在才改
```

vite 下次启动会自动重建缓存。旧目录可后续手动删除。

### 3. 启动

pnpm 是 PowerShell shim（`pnpm.ps1`），必须经 `powershell -File <pnpm.ps1>` 启动，`cmd /c pnpm` 找不到命令：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'  # 用于就绪验证，dev 专用
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$HOME\AppData\Roaming\npm\pnpm.ps1",'tauri','dev' -WorkingDirectory 'H:\Project\nezha-main' -WindowStyle Hidden -RedirectStandardOutput tauri-dev.stdout.log -RedirectStandardError tauri-dev.stderr.log
```

### 4. 就绪验证

- 端口与进程：`Get-NetTCPConnection -LocalPort 1420` + `Get-Process nezha | Where-Object Path -like '*src-tauri\target\debug*'`。
- 渲染验证（CDP）：访问 `http://127.0.0.1:9222/json/list` 取 `webSocketDebuggerUrl`，用 `Runtime.evaluate` 检查 `#root` 子节点数 > 0。脚本已内置该探测 + 自动导航 about:blank。
- 冷启动慢是常态：App.tsx 首次按需转换约 16s+，完整依赖图首次加载可能 1-3 分钟；没到时间不要判白屏。vite 只监听 IPv6 `[::1]`，验证时用 `localhost` 或 `[::1]`，`127.0.0.1` 会被拒绝连接。

### 5. 白屏排障决策树

| 现象 | 原因 | 处理 |
|------|------|------|
| CDP 看 href 停在 `about:blank` | 初始导航失败（vite 未就绪 / 单实例冲突） | 确认 vite 已监听 1420 后用 CDP `Page.navigate` 到 `http://localhost:1420/`，或重启 |
| `504 Outdated Optimize Dep` | `node_modules/.vite` 缓存过期/损坏 | 改名隔离缓存 → 重启 |
| 页面已加载但 `#root` 为空 | 仍在按需转换模块（冷启动） | 等待；或 CDP `Page.reload` 后轮询 |
| 日志有 border/borderColor 样式警告 | 存量代码简写冲突，非致命 | 忽略 |

## 构建与测试命令

- `pnpm build`（tsc + vite 打包）；`pnpm lint`；`pnpm test`。
- Rust：在 `src-tauri/` 下 `cargo check` / `cargo test`。注意 `session.rs` 有一个 Windows 路径相关的既有失败（`/tmp` 路径断言），与本次改动无关。
- 前端改动 vite 热更新；Rust 改动需重启 dev。
