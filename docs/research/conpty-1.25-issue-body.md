## What — 更改内容

把 Nezha 随 Windows 安装包侧载的 ConPTY 二进制（`conpty.dll` + `OpenConsole.exe`）从当前 **1.24.260512001** 升级到 **1.25**。需同步更新的文件：

| 路径 | 更改 |
|------|------|
| `src-tauri/resources/conpty/x64/conpty.dll` `x64/OpenConsole.exe` | 替换为 1.25 对应二进制 |
| `src-tauri/resources/conpty/arm64/conpty.dll` `arm64/OpenConsole.exe` | 替换为 1.25 对应二进制 |
| `src-tauri/resources/conpty/README.md` | 更新版本号、microsoft/terminal release tag、nupkg 下载 URL 与三个 SHA256 |

`conpty.dll` 与 `OpenConsole.exe` **必须成对替换**（OpenConsole.exe 是 host，两者要同版本）。

**不改动的部分（已核验）：**
- 无任何 Rust 代码改动。`platform/windows.rs` 的预加载 / 自检 / 崩溃循环逻辑不依赖具体版本号，只验 `CreatePseudoConsole / ResizePseudoConsole / ClosePseudoConsole` 三个导出（1.25 均有）。
- crash-loop 标记自动重试：指纹 = `应用版本 + dll 长度`，新版 dll 长度必变，升级后自动重试一次，无需手动清 `~/.nezha/.conpty-preload-inflight`。
- 前端设置开关「内置 ConPTY (Windows)」及 i18n 文案不变。
- `tauri.windows.conf.json` 的打包 glob `resources/conpty/**/*` 已覆盖新文件，无需改动。

## Why — 动机与原因

痛点：Nezha 在 Windows 上跑全屏 TUI 智能体（Claude Code / Codex）时，部分系统内置 ConPTY 版本会把输出**不送入 scrollback**（`maxBaseY = 0`），表现为终端内容无法滚轮回滚；且老版本 ConPTY 存在输入吞吐、resize 后 buffer 打散、渲染伪影等问题。这正是当初采用「随包侧载新版 `conpty.dll` + `OpenConsole.exe`」的原因（与 Windows Terminal / VS Code / wezterm 同一方案）。

理由：**当前侧载版本 1.24.260512001 相对微软最新 release 已落后**。微软在 1.25 及之后持续修复 ConPTY 的输入吞吐与 OpenConsole host 行为；现有 1.24 已可用，跟进到 1.25 能吸收这些修复。

关于版本选择（见 Scope 末尾），需 maintainer 拍板是否接受预览版，因此将 ConPTY 版本目标作为本提案的可选项，不预设。

## Scope — 影响面

- **涉及模块**：仅 `src-tauri/resources/conpty/`（纯资源二进制）+ 该目录 README。**不触及 Rust 源码**，不改变 PTY 读写管线、批量 flush 策略、resize 防御、事件通道等任何运行时逻辑。
- **平台范围**：仅 Windows（`tauri.windows.conf.json` 资源仅在 Windows 安装包打包；macOS / Linux 包不含这些文件）。macOS / Linux 走原生 PTY，不受影响。
- **是否触及终端性能红线**：
  - 涉及红线中「PTY 输出必须走 `Channel`」「读缓冲 32KB」「批量 flush」「resize 三层防御」「textarea 抑制属性」等 —— **本提案不改动这些常量的值**，只替换 ConPTY 二进制本身。
  - **但**：换版本后需实测确认性能红线不回归（见下方验证计划）。按红线要求，任何「体感提升 / 无回归」都需用 `sample` A/B 对照数据印证，不能只写「测试通过」。
- **破坏面**：属向后兼容的二进制替换。风险点在于新 ConPTY 若与特定系统 build 或 OpenConsole.exe 版本不配合，需靠既有的「预加载自检 + crash-loop 标记 + 前端开关」三层兜底回退系统版。兜底机制仍在，不会造成「首任务无法启动」之外的硬故障。

## 版本选择（需维护者决定）

microsoft/terminal 当前可用版本（经 GitHub release API 核实）：

| 候选 | 版本 | 通道 | 说明 |
|------|------|------|------|
| **A（推荐）** | `1.25.260303002` | 稳定 | node-pty（VS Code 上游）当前实际 vendored 并广泛生产验证的版本；升到 1.25 且不赌预览版 |
| B（激进） | `1.25.260710002-preview` | preview | 最新 release `v1.25.1912.0` 附带；拿到最新 OpenConsole / 输入吞吐修复，但为预览通道 build |
| C（中间态） | `1.25.260512002-preview` | preview | 若不想追最新预览版可作折中 |

> 生产应用 vendored **预览通道**的 console host 是否可接受，属于产品/稳定性决策，**需 maintainer 拍板**。故本提案默认推荐 A（稳定），预留 B/C 作为备选讨论。

## 验证计划（提 PR 前必须执行）

按 AGENTS.md 终端性能红线要求：

1. **滚动回卷验证**：Windows 真机运行全屏 TUI（Claude Code / Codex），滚轮确认输出能进入 scrollback（`maxBaseY` 正常，非 0）。这是当初侧载 ConPTY 的核心目标，升级不能破坏。
2. **resize 稳定性**：TUI 运行中反复拖动窗口改变尺寸，退出后确认 buffer 未被打散（对应 microsoft/terminal #4389 的 resize 失同步问题）。
3. **IME 输入**：切输入法验证中文输入在终端内无丢字/卡顿，确认换版本未破坏 IME 路径。
4. **大规模输出吞吐**：跑 `npm install` 之类产生大量输出的命令，用 `sample <pid> 8 -file x.sample` 抓现场，对比 1.24 与 1.25 的栈上数据，确认无回归。
5. **A/B 对照**：任何「体感提升 / 无回归」的结论需以修复前后 sample 数据对照为依据，不写笼统「测试通过」。

## 补充说明

- 二进制直接 vendor 入库（与 node-pty `third_party/conpty/`、wezterm 做法一致），构建零网络依赖。
- 若决定采用预览版（B/C），issue 讨论记录里需留下「已确认接受预览通道」的明确批复，便于后续追责与回滚。
