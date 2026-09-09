# 侧载 ConPTY（Windows）

此目录存放随 Windows 安装包分发的新版 ConPTY 二进制，目录结构：

```
resources/conpty/
├── README.md
├── LICENSE      # microsoft/terminal 的 MIT 许可证(随安装包分发,再分发合规要求)
├── NOTICE.md    # microsoft/terminal 的第三方声明(同上)
├── x64/    { conpty.dll, OpenConsole.exe }
└── arm64/  { conpty.dll, OpenConsole.exe }
```

## 为什么需要

部分 Windows build 的系统内置 ConPTY 不会把全屏 TUI（Claude Code / Codex）的
输出送入 scrollback，表现为终端滚轮无法回滚（`maxBaseY = 0`）。Windows Terminal /
VS Code / wezterm 均采用同一方案：随应用侧载新版 `conpty.dll` + `OpenConsole.exe`，
统一所有用户的运行时行为，不依赖系统 ConPTY 版本。

## 工作原理

1. 应用启动时（`lib.rs` 的 `setup`）在**后台线程**以完整路径预加载
   `conpty.dll`（`platform/windows.rs::spawn_conpty_preload`），并真实创建
   一次 PseudoConsole 自检（验 Create/Resize/ClosePseudoConsole 三个导出——
   与 portable-pty 要求的符号集一致，任一缺失它会整库回退）；预加载
   50-150ms，不能阻塞窗口首帧，`pty.rs` 在首次 `openpty` 前通过
   `wait_conpty_preload()` 屏障等待完成，保证「预加载先于首个 PTY」的时序；
2. portable-pty 创建 PTY 时执行 `LoadLibrary("conpty.dll")`，Windows loader 会
   复用进程内已加载的同名模块，从而命中侧载版；`conpty.dll` 从自身所在目录拉起
   `OpenConsole.exe` 作为 host，两者必须成对同版本存在；
3. 回退层次：
   - 资源缺失 / LoadLibrary 失败 → 模块不入表，portable-pty 自动回退系统版；
   - 自检失败（导出缺失、`CreatePseudoConsole` 失败——含 OpenConsole.exe 拉不
     起来的情况）→ `FreeLibrary` 卸载，同样回退系统版。注意自检是冒烟测试，
     使用与 portable-pty 相同的 flags 走一次真实 host 拉起，但**不能证明**后续
     会话稳定（host 起来后再崩的场景拦不住，此类问题由下面两层兜底）；
   - 预加载/自检挂死 → crash-loop 标记（`~/.nezha/.conpty-preload-inflight`，
     内容为「应用版本 + dll 长度」指纹）：下次启动检测到残留标记且指纹一致即
     跳过侧载，最多损失一次「首个任务无法启动」的会话。应用升级（dll 随包更新，
     指纹必变）或用户切换设置开关会清除标记、自动重试；
   - 手动兜底 → 设置「通用 → 内置 ConPTY」开关，或 `~/.nezha/settings.json`
     设 `"use_sideloaded_conpty": false`，重启后生效。

## 二进制来源（vendor 入库）

二进制**直接提交在本目录**（与 node-pty `third_party/conpty/`、wezterm
`assets/windows/conhost/` 的做法一致），构建零网络依赖。通过
`tauri.windows.conf.json` 的 `bundle.resources` 打入 Windows 安装包；
macOS / Linux 包不含这些资源。

当前版本：**1.25.260303002-preview**（microsoft/terminal release `v1.25.622.0`）

```
来源: https://github.com/microsoft/terminal/releases/download/v1.25.622.0/Microsoft.Windows.Console.ConPTY.1.25.260303002-preview.nupkg
nupkg SHA256: 3ae991dd31652bfe90521332c3e3f075ff6a906f706d8fd4f692d8bc67b6969d

3319b484b80bb53d1f4d0a9eb0ea60fd0f61da69db7280ca43b84215f19245ff  x64/conpty.dll
7f68c840226505004215c0b82d4e502c24b5bc3f4b93c4baaaa19bd679c0def8  x64/OpenConsole.exe
b3a9f975c51d5b9b96d290bf784e990e3f85203b063c21614457353f566266ff  arm64/conpty.dll
7fa560be0c9b6c81db5d1b855a4a6e0f3ee5a2ea75d36eebb3ae44443b8d4866  arm64/OpenConsole.exe
```

## 升级二进制（手工步骤）

1. **定位官方 nupkg**：到 <https://github.com/microsoft/terminal/releases> 的
   assets 里找 `Microsoft.Windows.Console.ConPTY.<version>.nupkg`（注意 release
   tag 与包版本号不是一一对应，按 asset 文件名找；1.25.x 带 `-preview` 后缀的
   是预览版，选稳定线）。下载后记录 SHA256：`shasum -a 256 <文件>`（macOS）或
   `Get-FileHash <文件>`（Windows）。
2. **解包**：nupkg 就是 zip，改后缀或直接 `unzip`。包内两套目录各放一半文件：

   | 文件 | 包内路径 |
   |------|----------|
   | `conpty.dll` | `runtimes/win-<arch>/native/conpty.dll` |
   | `OpenConsole.exe` | `build/native/runtimes/<arch>/OpenConsole.exe` |

3. **成对覆盖**：把 x64 / arm64 两套 dll+exe 复制进本目录对应子目录。
   ⚠️ **两个文件必须同版本成对更新**——只更新其一会导致崩溃（wezterm/wezterm#7774
   实锤过：pwsh 退出时 FailFast 0x80131623）。
4. **验签（Windows 上执行）**：对四个文件逐个跑
   `Get-AuthenticodeSignature <文件>`，要求 `Status` 为 `Valid` 且签名者为
   Microsoft Corporation。这些二进制会在应用启动时被加载执行，验签不可省。
5. **刷新合规文件**：从对应 tag 下载并覆盖本目录的 LICENSE 与 NOTICE.md：
   `https://raw.githubusercontent.com/microsoft/terminal/<tag>/LICENSE`（NOTICE.md 同理）。
6. **更新记录**：改写本文件上方的版本号、来源 URL、nupkg 与四个文件的 SHA256，
   连同二进制、许可证文件一起提交。

## 验证是否命中侧载

- 后端日志：命中时输出 `[conpty] 已启用侧载 ConPTY: <path>`；
- 打包产物无控制台时，可在任务运行中打开任务管理器查看 host 进程：命中侧载时为
  安装目录下的 `OpenConsole.exe`，回退系统版时为 `C:\Windows\System32` 下的
  conhost（也可用 `tasklist /m conpty.dll` 查询）。

## 许可与更新

`conpty.dll` / `OpenConsole.exe` 来自
[microsoft/terminal](https://github.com/microsoft/terminal) Release 资产
`Microsoft.Windows.Console.ConPTY.<version>.nupkg`（MIT License）。完整许可证
文本见本目录 [LICENSE](./LICENSE)，第三方声明见 [NOTICE.md](./NOTICE.md)——
两个文件会随本目录一起打入 Windows 安装包，满足 MIT 再分发的署名要求
（nezha 本体为 GPLv3，MIT 与之兼容）。
升级时两个文件必须成对更新到同一版本，只更新其一可能导致崩溃
（参考 [wezterm/wezterm#7774](https://github.com/wezterm/wezterm/issues/7774)）。
