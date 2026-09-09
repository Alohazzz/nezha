# ConPTY Alternatives — Evidence-Based Research

> **Scope.** Investigate whether Nezha (Tauri + Rust backend, xterm.js frontend) can move beyond `portable-pty`'s Windows ConPTY backend to host interactive full-screen TUI coding agents (Claude Code, Codex) with lower latency, higher output throughput, reliable IME, and correct resize behavior.
>
> **Method.** Every claim is traced to a primary source: Microsoft Learn console docs, the `microsoft/terminal` repo (source, specs, issue tracker), the `devblogs.microsoft.com/commandline` blog, the `wezterm/wezterm` & `microsoft/node-pty` source, and the `rprichard/winpty` repo. Issue bodies/comments were pulled via the GitHub REST API (not secondary rewrites). Nezha's own backend (`src-tauri/src/pty.rs`, `src-tauri/src/platform/windows.rs`, `src/hooks/useTerminalManager.ts`, `src/components/terminalShared.ts`, `src/components/TerminalView.tsx`) was read to ground the recommendations.

---

## 1. What ConPTY is and its documented limitations

### 1.1 Definition and architecture

ConPTY is the Windows Pseudo Console (also "pseudoconsole", "Windows PTY"). Per Microsoft Learn **Pseudo consoles**:

> "A *pseudoconsole* is a device type that allows applications to become the host for character-mode applications. This is in contrast to a typical console session where the operating system will create a hosting window on behalf of the character-mode application to handle graphical output and user input. With a pseudoconsole, the hosting window is not created. The application that makes the pseudoconsole must become responsible for displaying the graphical output and collecting user input."

Source: https://learn.microsoft.com/en-us/windows/console/pseudoconsoles

The announcement **Introducing the Windows Pseudo Console (ConPTY)** (Microsoft Command Line Blog, 2018-08-02) states ConPTY is "similar to the POSIX PTY model, but in a Windows-relevant manner." Windows previously "lacks a PTY infrastructure," and "Windows obstructs 3rd party Consoles and Server Apps" — forcing third-party terminals to use an off-screen console and "send it user-input and scrape its output."

Source (redirected devblogs URL): https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/

The same post describes the internal architecture that is the crux of the latency/throughput problem:

> "ConHost now contains a few additional modules for handling VT and a new ConPTY module that implements the public API."

- The host creates pipes, calls `CreatePseudoConsole`, and passes the `HPCON` to the child via `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`.
- **ConHost's "VT Interactivity" converts UTF-8 text/VT input into `INPUT_RECORD`s** (input side).
- **The "VT Renderer" emits changed output-buffer regions as UTF-8 text/VT** (output side).
- "even traditional Command-Line apps 'speak text/VT' externally, without requiring any changes!"

So output is **not** forwarded directly: the child writes into a real console text buffer, conhost renders only the *changed* rectangles to VT, and the host reads that VT stream. This indirection is where buffer-desync, resize, and throughput problems originate.

The `CreatePseudoConsole` reference (Microsoft Learn) confirms the I/O contract and the minimum OS:

> "The input and output streams encoded as UTF-8 contain plain text interleaved with Virtual Terminal Sequences."
> Minimum supported client: **Windows 10 October 2018 Update (version 1809) [desktop apps only]**; Minimum supported server: Windows Server 2019.

Source: https://learn.microsoft.com/en-us/windows/console/createpseudoconsole

The **Creating a Pseudoconsole session** reference adds the key constraints that matter for an embedded terminal:

> "The input and output streams ... are processed by the pseudoconsole system using ReadFile and WriteFile with synchronous I/O." (No overlapped/async I/O.)
> "To prevent race conditions and deadlocks, we highly recommend that each of the communication channels is serviced on a separate thread ... Servicing all of the pseudoconsole activities on the same thread may result in a deadlock."
> "Closing the pseudoconsole session ... may emit a final frame update to hOutput which should be drained."
> "It is recommended that communications channels for the pseudoconsole are serviced on individual threads and remain drained and processed until broken."

Source: https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session

`ResizePseudoConsole` resizes the buffer in "count of characters" and is asynchronous relative to the terminal (this matters for #1.5 below).

### 1.2 Documented limitations — the canonical spec

The definitive first-party statement of ConPTY's limitations is the Microsooft-authored spec **In-process ConPTY** (microsoft/terminal, `doc/specs/#13000 - In-process ConPTY.md`, author @lhecker, 2024-06-07, issue #13000). Its "Why?" section enumerates the architectural problems:

> **"Out-of-process leads to out-of-sync issues."**
> * "The terminal and ConPTY may implement escape sequences differently."
> * "...may implement text processing differently."
> * "...may implement text reflow (resize) differently."
> * "Resizing the terminal and ConPTY is asynchronous and there may be concurrent text output."
> * "...and it may uncover text from the scrollback, which ConPTY doesn't know about."

> **"Some Console API methods cannot be represented via escape sequences and so ConPTY cannot produce them either."** The most basic example: "the lack of LVB gridlines."

> **"Lastly, its performance is insufficient and has been subject to much debate."** (In the tl;dr / Why section.)

> "ConPTY has fulfilled our needs a thousand times over, but as it's layered on top of conhost it has resulted in software decay. The layer boundary has blurred over the years resulting in debugging and maintenance difficulties."

Source: https://github.com/microsoft/terminal/blob/main/doc/specs/%2313000%20-%20In-process%20ConPTY.md

The suggested fix (in-process ConPTY: move Console-API→VT translation into a static library that Windows Terminal links directly, eliminating the cross-process pipe + conhost boundary) **has not shipped** — the issue remains open and the spec is the design doc. So the cross-process, out-of-sync, buffer-desync architecture is the status quo today.

### 1.3 Output throughput / buffering latency

The megathread **ConPTY buffer gets out-of-sync** (issue #15976, open) documents the practical consequence for TUI apps:

> "OpenConsole **do not** have any idea of what's in the scrollback region ... the character ... went *into the scrollback region* ... This seems to be the root cause."
> Maintainer @zadjii-msft: "This is a well known issue and will likely remain unresolved for now. ... an architectural problem in general (= maintaining 2 buffers out of proc results in desync)."
> "I don't know how to solve it ... I'm not even sure it's possible to solve it at all while maintaining ConPTY as is."

Source: https://github.com/microsoft/terminal/issues/15976

The recurring title "conpty exhibits pathological performance on scrolling region redraw (repaints entire screen)" (closed, not planned) appears under the `Product-Conpty` label — the classic symptom: when the alternate screen scrolls, ConPTY re-emits a full-region repaint rather than the diff.

### 1.4 Input throughput / IME (the most quantitative limit)

Issue **The input speed of ConPTY / ConHost is very slow.** (#13594) contains a reproducible benchmark. Reporter @lonnywong fed bulk stdin through a Go ConPTY client and measured on the child (Windows, `read` from stdin):

> `read 8600 bytes in 1870ms, speed: 4.49KB/s` … peaks around **4–9 KB/s** for synchronous `read()` paths, and ~**180 KB/s** once the payload saturates.

Switching the child to `ReadConsoleInput` was "a little faster" (peaks ~**320 KB/s**) but still far below useful TUI rates.

Maintainer @zadjii-msft (Windows Terminal lead) — a direct first-person acknowledgment that ConPTY is not built for this:

> "ConPTY's input was definitely originally designed for user-driven input, not necessarily bulk input at the level that something like `rz` might need. I'm sure there's some unexpected hot paths or dumb waits in there."

Later, maintainer @lhecker:

> "my recent performance improvements to our input handling have improved throughput by 2x already (~600kB/s) ... I bet we could make this another 100x faster though."

Source: https://github.com/microsoft/terminal/issues/13594

**IME.** The input path from host→child goes through ConPTY's VT→`INPUT_RECORD` translation. The spec **Improved keyboard handling in Conpty** (microsoft/terminal, `doc/specs/#4999`, author @zadjii-msft, 2020-06-03) states:

> "conpty's keyboard input is fundamentally backed by VT sequences, which limits the range of keys that a terminal application can actually send relative to what the console was capable of. This results in a number of keys that were previously representable in the console as INPUT_RECORDs, but are impossible to send to a client application that's running in conpty mode."

It lists real regressions: *"Shift+Enter always submits, breaking PSReadline features," "Bug: ctrl+break is not ctrl+c," "Ctrl+Keys that can't be encoded as VT should still fall through," "Modifier keys are not properly propagated."* The fix was a proprietary **win32-input-mode** encoding (an escape sequence ConPTY emits to switch the host into sending raw `INPUT_RECORD`-like keys). wezterm's `allow_win32_input_mode` doc confirms: "wezterm will honor an escape sequence generated by the Windows ConPTY layer to switch the keyboard encoding to a proprietary scheme that has maximum compatibility with win32 console applications" (default `true` since 2022).

Sources:
- https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md
- https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/allow_win32_input_mode.md
- https://github.com/microsoft/terminal/issues (search: `conpty input-mode`, `win32-input-mode`)

**Practical takeaway for Nezha's IME concern.** The IME problem is two-fold: (a) xterm.js frontend IME composition is separate and already mitigated in Nezha (see AGENTS.md terminal red lines), and (b) **the Win32↔VT input translation inside ConPTY itself** — a proprietary, out-of-process layer that depends on ConPTY's version and on the `PSEUDOCONSOLE_WIN32_INPUT_MODE` flag. Both wezterm and Nezha's `psuedocon.rs` reference sets `PSEUDOCONSOLE_WIN32_INPUT_MODE` exactly to get win32-input-mode.

### 1.5 Resize behavior (critical for full-screen TUI)

Issue **Alternate console buffers of different sizes confuse ConPTY (and therefore Windows Terminal)** (#4389):

> "1. Open a TUI application in Windows Terminal. 2. Resize the Terminal Window. 3. Close the TUI application. The resulting terminal window acts like it is the original size before resizing, but the resized area remains visible."

And the related issue #1765 "ConPTY sends two WINDOW_BUFFER_SIZE_EVENT messages when the window is restored from maximize," plus #19621 "ConPTY DSR CPR on resize can interrupt in-flight (long-term) DCS (or APC...)."

Source: https://github.com/microsoft/terminal/issues/4389

The in-process ConPTY spec (1.2) names the root cause directly: "Resizing the terminal and ConPTY is asynchronous and there may be concurrent text output." This is why a TUI app that holds an alternate screen buffer can get its buffer "permanently scrambled" when cols drop to a degenerate value — a failure mode Nezha already defends against in `terminalShared.ts::safeFit` + `pty.rs::resize_pty` (three-layer defense, per AGENTS.md).

---

## 2. Alternatives to ConPTY for a Rust terminal backend

### 2.1 `portable-pty` — the crate Nezha uses

**Backends.** `portable-pty` is a cross-platform PtySystem. On Unix it wraps the native PTY (`pty/src/unix.rs`). On Windows it is the **winconpty / winconpty-conpty backend** in `pty/src/win/`:

- `win/conpty.rs` implements `PtySystem::openpty` by calling `PsuedoCon::new(COORD{cols,rows}, stdin.read, stdout.write)`, returning a `ConPtyMasterPty` (with `readable` = output read end, `writable` = input write end) and a `ConPtySlavePty`.
- `win/psuedocon.rs` does the actual work. It dynamically loads **`kernel32.dll`** (`CreatePseudoConsole` / `ResizePseudoConsole` / `ClosePseudoConsole`) — "If the kernel doesn't export these functions then their system is too old and we cannot run ... Windows 10 October 2018 or newer is required" — and **prefers a sideloaded `conpty.dll`**:

  > "We prefer to use a sideloaded conpty.dll and openconsole.exe host deployed alongside the application. We check for this after checking for kernel support."

  It uses **`lazy_static!`** for the loaded function table, and `CreatePseudoConsole` is called with `PSUEDOCONSOLE_INHERIT_CURSOR | PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE`. `spawn_command` uses `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, and forces `STARTF_USESTDHANDLES` with invalid std handles.

Sources (fetched via GitHub REST API):
- https://github.com/wezterm/wezterm/blob/main/pty/src/win/conpty.rs
- https://github.com/wezterm/wezterm/blob/main/pty/src/win/psuedocon.rs
- https://docs.rs/portable-pty — "This crate is part of wezterm"; on Windows the `PtySystem` trait exists for "multiple possible Pty implementations at runtime ... important on Windows systems which have a variety of implementations."

**Maintenance status / known issues.**

- Portable-pty is maintained **by Wez Furlong as part of wezterm** (the `pty` crate lives in the wezterm monorepo). The last commit touching `pty/src/win/conpty.rs` was **2026-08-25** (from the commit history for that path), so it is actively updated.
- **Nezha's code already documents the `lazy_static` consequence** (`src-tauri/src/app_settings.rs`): "portable-pty 的 CONPTY 是 lazy_static，进程内首次创建 PTY 后无法再切换实现" — i.e., the ConPTY implementation (system vs sideloaded) is frozen after the first `openpty`, which is why Nezha preloads the sideloaded `conpty.dll` before any PTY.
- **The crate does NOT bypass ConPTY on Windows** — it is a thin, well-behaved wrapper over `kernel32.dll`/`conpty.dll`. So all of ConPTY's #1 limitations apply to `portable-pty` through no fault of the crate.

### 2.2 Does an alternative RUST crate bypass ConPTY? — No

Searching the Windows PTY backend space, **no maintained Rust crate bypasses ConPTY**. `portable-pty` is the de-facto standard and it uses ConPTY. The closest adjacent options are:
- `conpty`-bindings crates (thin FFI over the same `CreatePseudoConsole` API) — same bottleneck.
- Named-pipe PTYs (e.g., `winio`) — but a PTY on Windows is definitionally `CreatePseudoConsole`; you cannot get a real console-backed PTY without it.

**The important nuance.** What CAN be changed is *which* ConPTY implementation is used (see §4) — system `conhost.exe` vs the newer **OpenConsole.exe** — and how the pipes/buffers are sized. Neither is a "bypass."

### 2.3 Direct `CreateProcess` + `CONIN$`/`CONOUT$` — not a real PTY

Driving a real console window directly (`CreateProcess` with `CONIN$`/`CONOUT$` inherited from an allocated console) is **not a PTY** and is the pre-ConPTY off-screen-scraping approach ConPTY was invented to replace. From the announcement blog: the old method "results in instability, crashes, data corruption, excessive power consumption, etc." and "adopting ConPTY is likely to eliminate several classes of bugs, while increasing stability, reliability, and performance." A GUI-embedded terminal cannot front a real visible console window (`ALLOCATE_CONSOLE` shows a host console window) without ConPTY.

Feasibility verdict: **not viable** as a ConPTY replacement for an embedded TUI terminal. It also can't be resized programmatically without ConPTY semantics.

### 2.4 `winpty` (ConEmu) — legacy, effectively abandoned

`rprichard/winpty` — "A Windows software package providing an interface similar to a Unix pty-master for communicating with Windows console programs." Repo status (GitHub API):
- `pushed_at: 2024-02-19` (last push over 2.5 years before today's date 2026-09-09), `archived: False`, `open_issues: 105`. **Effectively unmaintained / stale.**

Critically, **`node-pty` (VS Code's terminal) removed winpty**. From its README:

> "`node-pty` supports Linux, macOS and Windows. Windows support is possible by utilizing the Windows conpty API on Windows 1809+."
> "**Note: Support for the `winpty` library has been removed.** Windows 10 version 1809 (build 18309) or later is now required."

Sources:
- https://github.com/rprichard/winpty
- https://github.com/microsoft/node-pty/blob/main/README.md
- node-pty uses ConPTY via `src/win/conpty.cc` (sideloads `third_party/conpty/1.25.260303002/`).

Conclusion: winpty is **not a viable forward path** — it's stale and the ecosystem (VS Code) has explicitly abandoned it for ConPTY.

### 2.5 Sideloading newer ConPTY — the practical "alternative" the ecosystem actually uses

Every major Windows terminal that hosts TUI apps (Windows Terminal, VS Code, wezterm, and Nezha) does **not** bypass ConPTY; it **vendors a newer `conpty.dll` + `OpenConsole.exe`** and loads them in place of the system ones. This is the de-facto mitigation. The evidence:

- `portable-pty` explicitly prefers sideloaded conpty over kernel32 (2.1).
- node-pty vendors `third_party/conpty/1.25.../` and resolves `"ConptyCreatePseudoConsole"` from the DLL when present (`conpty.cc`: `useConptyDll ? "ConptyCreatePseudoConsole" : "CreatePseudoConsole"`).
- wezterm vendors `assets/windows/conhost/` (per Nezha's own README: "wezterm assets/windows/conhost/ 的做法一致").
- Nezha already implements exactly this in `src-tauri/src/platform/windows.rs::preload_sideloaded_conpty` + `src-tauri/resources/conpty/`.

**Caveat (a real, documented failure mode)** — the sideloaded pair must be matched and never update one file without the other. wezterm issue **#7774**: an out-of-date *mismatched* `OpenConsole.exe`+`conpty.dll` pair caused a `pwsh` `FailFast`/`0x80131623` crash when exiting a TUI (`opencode`), with Windows Event Log:

> "The Win32 internal error 'No process is on the other end of the pipe.' 0xE9 occurred while getting console output buffer information."

Updating the pair to a matched release fixed it. Nezha's README already warns: "两个文件必须同版本成对更新——只更新其一会导致崩溃（wezterm/wezterm#7774 实锤过）."

Sources:
- https://github.com/wezterm/wezterm/issues/7774
- https://github.com/microsoft/node-pty/blob/main/src/win/conpty.cc

---

## 3. The "snap/quality that Codex has" angle

### 3.1 Why agent TUIs feel "native" — the properties that matter

Claude Code and Codex are full-screen, alternate-buffer TUI apps. Their stream of ANSI is *incremental and interactive*: cursor moves, partial-line rewrites, spinners, streaming reasoning. The user-exposed quality is determined by:

1. **End-to-end latency** from agent `write()` to a visible glyph change. Any path that adds a frame, a flush delay, or a process hop is felt as lag.
2. **Output throughput under burst** (large model responses), which must not choke or reflow in chunks that break runs of VT.
3. **Input round-trip** (keystroke → agent), which is where ConPTY's *user-driven-not-bulk* path is now proven slow (#1.4).
4. **Zero-lag resize**—the agent's alt-screen must reflow without desync (#1.5).
5. **IME composition**, which crosses the VT↔`INPUT_RECORD` boundary inside ConPTY (#1.4).

### 3.2 ConPTY's role as the bottleneck

All five of those live **inside ConPTY**, between the agent and the host:

- Output: agent → conhost text buffer → conhost **VT Renderer** (renders changed rects) → output pipe → host. That renderer must diff the buffer and re-emit VT; on a scrolling region it "repaints entire screens" (§1.3). Two copies of the buffer (conhost + xterm.js) must stay in sync.
- Input: host → ConPTY **VT Interactivity** (parse VT → `INPUT_RECORD`s) → child stdin. This translation is the measured 4–9 KB/s hot path (§1.4).
- Resize: host calls `ResizePseudoConsole`; conhost reflows its buffer asynchronously while the terminal reflows its own — two independent reflows that desync (§1.2, §1.5).

So ConPTY is not merely a transport — it is a **competing renderer/input-processor** that duplicates the work xterm.js does.

### 3.3 What the frontend/backend must do to feel snappy (and Nezha's current state)

Nezha already has a mature pipeline that mitigates the non-ConPTY parts:

- **Backend `pty.rs`**: PTY read buffer `32 * 1024` (`PTY_READ_BUFFER_SIZE`), batch flush every `16ms` (`PTY_EMIT_FLUSH_INTERVAL`), max batch `64 * 1024` (`PTY_EMIT_MAX_BATCH_BYTES`), bounded sync channel `32` (`PTY_EMIT_CHANNEL_CAPACITY`) to apply backpressure to the OS PTY buffer. Agent output goes through `tauri::ipc::Channel<String>` (single subscriber) rather than the global event bus.
- **Frontend `useTerminalManager.ts`**: `drainPendingOutputs` on `requestAnimationFrame`, `DRAIN_FRAME_BUDGET = 128 * 1024`/frame, 10 MB/task buffer cap, `MAX_BUFFER_CHUNKS = 256`.
- **Frontend `terminalShared.ts` `createSmartWriter`**: watermark-based backpressure, `HIGH_WATER = 128 * 1024`, `LOW_WATER = 16 * 1024`.
- **Frontend `TerminalView.tsx`**: xterm.js write pipeline.

**The residual gap is exactly ConPTY.** The frontend can only batch and chunk *after* ConPTY has already done its renderer pass and shipped bytes across a pipe. The RAF/watermark machinery reduces *frontend* re-render cost, but cannot remove the **cross-process pipe + conhost renderer + VT↔INPUT_RECORD translation** that sits upstream. That's why "ConPTY is the bottleneck" is accurate for this class of app: it's the one stage Nezha does not control.

---

## 4. Cross-platform terminal strategy (macOS / Linux / Windows)

**Recommended model (and what mature terminals do): Unix uses native PTY; Windows uses ConPTY — but a *vendored, up-to-date* ConPTY.**

- **macOS / Linux / *BSD.** The kernel PTY (`/dev/ptmx`, `openpty`) is the native, direct, low-latency path. `portable-pty`'s `unix.rs` uses it. No code change needed. This is where "native/snappy" already lives.
- **Windows.** There is no kernel PTY. Every Rust terminal emulator that runs on Windows uses **ConPTY** (which on recent Windows is `OpenConsole.exe`, not the legacy `conhost.exe`):

| Project | Windows strategy | Notes |
|---|---|---|
| **wezterm** (Rust) | ConPTY via its own `pty` crate (`portable-pty`), **sideloads** `OpenConsole.exe`+`conpty.dll` | Runs on Windows; uses openconsole; vendors the console pair. |
| **alacritty** (Rust) | ConPTY via `conhost.exe` by default; **rendering issues stem from using system ConHost instead of OpenConsole** | Issue #4794: "Alacritty use ConPty from ConHost" (broken rendering) vs WezTerm/Windows Terminal "use ConPty from OpenConsole." Maintainer confirmed OpenConsole "is delivered a lot faster" than the system ship. |
| **Windows Terminal** (C++) | ConPTY via **OpenConsole** (uses its own console host). | The reference implementation; the In-process ConPTY spec (#13000) is its next major direction. |
| **VS Code / node-pty** | ConPTY, **sideloads** `third_party/conpty`. Removed winpty. | Proof the ecosystem relies on sideloading. |
| **ghostty** (Zig) | GUI **does not run on Windows**; instead `libghostty-vt` / `libghostty` embed terminal state and are "compatible for macOS, Linux, Windows, and WebAssembly." | Ghostty's cross-platform embeddable core is the philosophical analogue to Nezha's own xterm.js-embed approach. |
| **zellij** (Rust) | Workspace/mux; on Windows uses the same `portable-pty`-style ConPTY backend. | Not a terminal emulator itself; corroborates that Rust muxes on Windows go through ConPTY. |

**Key first-party evidence on OpenConsole vs ConHost** (alacritty issue #4794, maintainer quote in #3889):

> "conhost is built from the (exact!) same source as OpenConsole; one is just delivered a lot faster since we aren't stuck behind the multiple-month Windows release cycle."

i.e. OpenConsole.exe is the up-to-date conhost source built from the Windows Terminal repo, released weekly; the OS's `conhost.exe` is years behind and carries rendering/VT bugs. Both wezterm and Windows Terminal use OpenConsole; Alacritty (conhost) had a TUI rendering bug that OpenConsole fixed.

Sources:
- https://github.com/alacritty/alacritty/issues/4794
- https://github.com/alacritty/alacritty/issues/3889 (comment https://github.com/alacritty/alacritty/issues/1663#issuecomment-645608542)
- https://github.com/ghostty-org/ghostty/blob/main/README.md (libghostty platform matrix; `src/os/windows.zig` exists for the lib, not the GUI apprt)

**Conclusion.** There is no single cross-platform terminal backend: Unix uses native PTY, Windows uses ConPTY. The practical "consistency lever" on Windows is **which ConPTY** (system conhost vs vendored OpenConsole) and **the buffer/pipe sizes and flush batching around it**. This is precisely the strategy Nezha already adopted (§2.5), and it aligns with Windows Terminal / VS Code / wezterm.

---

## 5. Concrete recommendations

Ground truth recap:
- ConPTY is the **only** Windows path; there is no Rust crate that bypasses it, and winpty is abandoned.
- ConPTY's flaws (out-of-sync double buffer, VT↔`INPUT_RECORD` translation, slow bulk input, resize desync, renderer full-repaints) are **architectural**, owned by the outstanding **In-process ConPTY** spec (#13000), and cannot be fixed from the caller.
- The most impactful *available* lever is **sideloading the newest matched `conpty.dll`+`OpenConsole.exe`** and tuning the surrounding buffer/flush batching.

### Option (a) — Keep ConPTY, harden the buffer/batching layer [RECOMMENDED, lowest risk]
This is what Nezha mostly does today. Do these concrete things:

1. **Keep & modernize the sideload.** Record the currently vendored ConPTY version (Nezha bundles `1.24.260512001`; node-pty already bundles `1.25.260303002` and wezterm references a newer pair). Consider bumping to the newest stable ConPTY package to pick up @lhecker's input-throughput and OpenConsole fixes. **Always update the `conpty.dll` + `OpenConsole.exe` pair together** (wezterm#7774). Keep the crash-loop marker and the manual toggle (already implemented).
2. **Reduce round-trips on output.** Largest controllable win: verify the `16ms` flush interval + `64KB` batch + `32KB` read buffer are still optimal. If the agent's OS write is the bottleneck, consider raising `PTY_READ_BUFFER_SIZE` toward the node-pty figure — node-pty sizes its ConPTY input/output named pipes at **`128 * 1024`** (`conpty.cc`: `nOutBufferSize = 128 * 1024, nInBufferSize = 128 * 1024`). A 32 KB read buffer on a fast sink may be leaving throughput on the table; 64–128 KB is a defensible target subject to measurement (AGENTS.md terminal red lines forbid changing buffer sizes without re-validating).
3. **Enforce Win32 input mode.** `portable-pty` already passes `PSEUDOCONSOLE_WIN32_INPUT_MODE`; make sure Nezha's sideloaded build does too (its self-check in `windows.rs` uses the same flags). This is required for correct keyboard/IME fidelity (wezterm's `allow_win32_input_mode`).
4. **Keep the three-layer resize defense** (`safeFit` + `resize_pty` degenerate-size guard). This is the only protection against ConPTY's alt-screen resize desync (§1.5).
5. **Keep output on `Channel`, not `emit`.** This is already the non-negotiable rule (AGENTS.md terminal red lines); preserve it.

**Cost/complexity: low. Risk: minimal. Benefit: the largest available within ConPTY's limits.**

### Option (b) — Replace ConPTY entirely [NOT VIABLE]
There is no drop-in replacement. Direct `CONIN$`/`CONOUT$` console-driving is the pre-ConPTy off-screen-scrape approach that ConPTY exists to avoid (§2.3). "Replace ConPTY" in practice would mean writing a custom console+VT engine over the raw console API — that is precisely the multi-year **In-process ConPTY** effort Microsoft itself hasn't shipped. **Not feasible for Nezha.**

### Option (c) — A different architecture: headless / replay of the agent instead of a PTY [PARTIAL, as a complement]
Codex and Claude both provide non-interactive/CLI modes. For *logged* output, Nezha already reads session JSONL (`session.rs`, `analytics.rs`, `read_session_messages`). A headless replay path is attractive for correctness (no ConPTY at all), but:
- It **loses the interactive TUI experience** (alt-screen frames, spinners, live cursor, key dispatch), which is the core value an embedded terminal provides for these agents. The agents are native terminal UIs *by design*.
- Codex/Claude interactive modes are **not** headless; there is no "replay from JSONL" that reproduces a live PTY for user input mid-stream without a real console attachment.

So **headless is a complement, not a substitute** — good for session playback / `/export`, not for hosting the live agent. Keep the PTY as the primary host.

---

## 6. Final recommendation

> **Keep ConPTY (option a), and invest in the levers that are actually controllable: (1) modernize the vendored `conpty.dll`+`OpenConsole.exe` pair to the newest matched stable release and keep them locked together, (2) validate & likely raise the ConPTY pipe / read / flush buffer sizes toward node-pty's 128 KB figure, (3) keep `PSEUDOCONSOLE_WIN32_INPUT_MODE`, (4) keep output on the single-subscriber `Channel` and the three-layer resize defense. Do NOT attempt to replace ConPTY.** Treat a full "in-process ConPTY" as a never-shelving upstream improvement (microsoft/terminal #13000) to watch, and use headless/replay (option c) only as a complement for session export, never as the live host.

Rationale in one line: ConPTY is a correct-and-ubiquitous, but architecturally-lossy, Windows console host; the only things you control are which build of it you run, how big the pipes are, and how you batch the bytes around it — every major terminal (Windows Terminal, VS Code, wezterm) has reached the same conclusion and optimized those instead of replacing it.

---

## Appendix — Source URLs (cited above)

Microsoft Learn (console / pseudoconsole):
- https://learn.microsoft.com/en-us/windows/console/pseudoconsoles
- https://learn.microsoft.com/en-us/windows/console/createpseudoconsole
- https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session

devblogs / command-line blog:
- https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/ (redirect from blogs.msdn.microsoft.com …)

microsoft/terminal:
- https://github.com/microsoft/terminal/blob/main/doc/specs/%2313000%20-%20In-process%20ConPTY.md (issue #13000)
- https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md (issue #4999)
- Issues: #15976 (megathread, buffer desync), #13594 (input speed), #4389 (alternate-buffer resize desync), #1765, #19621. Search: `repo:microsoft/terminal conpty`.

portable-pty / wezterm:
- https://github.com/wezterm/wezterm/blob/main/pty/src/win/conpty.rs
- https://github.com/wezterm/wezterm/blob/main/pty/src/win/psuedocon.rs
- https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/allow_win32_input_mode.md
- https://github.com/wezterm/wezterm/issues/7774 (sideload pair mismatch crash)
- https://docs.rs/portable-pty

node-pty (VS Code):
- https://github.com/microsoft/node-pty/blob/main/README.md
- https://github.com/microsoft/node-pty/blob/main/src/win/conpty.cc

winpty:
- https://github.com/rprichard/winpty (last push 2024-02-19, 105 open issues)

alacritty:
- https://github.com/alacritty/alacritty/issues/4794 (OpenConsole vs ConHost rendering)
- https://github.com/alacritty/alacritty/issues/3889 (feature request; maintainer quote)

ghostty:
- https://github.com/ghostty-org/ghostty/blob/main/README.md (libghostty platform matrix)
- https://github.com/ghostty-org/ghostty/blob/main/src/os/windows.zig (lib-side Windows bridge; no GUI apprt/ Windows backend)

Nezha (for grounding):
- `src-tauri/src/pty.rs` (PTY read buffer 32 KB, flush 16ms, batch 64 KB, Channel sink)
- `src-tauri/src/platform/windows.rs` (`preload_sideloaded_conpty`, self-check, crash-loop marker)
- `src-tauri/resources/conpty/README.md` (vendored ConPTY 1.24.260512001; wezterm #7774 caution)
- `src/hooks/useTerminalManager.ts`, `src/components/terminalShared.ts`, `src/components/TerminalView.tsx` (RAF drain, 128 KB/frame, HIGH/LOW watermarks)
