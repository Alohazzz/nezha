import type { Terminal } from "@xterm/xterm";

/**
 * 关闭鼠标上报（DECPrivateMode 1000/1002/1003）与 SGR 扩展坐标（1006）的序列。
 *
 * Why：运行中的程序（agent 内嵌 TUI、pager、交互式安装器等）向 PTY 写入
 * `ESC[?1000h`/`?1002h`/`?1003h` 后，若在异常路径退出而未发对应的 `l` 关闭
 * 序列，xterm 的鼠标上报协议会**残留**在开启态——此后所有拖选与滚轮事件被
 * 转发给 PTY 对端而非本地处理，程序已不在读时表现为「拖动无选区、滚轮无
 * 响应」（Shift 拖动仍可强制本地选区，xterm `shouldForceSelection` 的
 * 非 Mac 分支）。
 *
 * 方向说明：这些序列写入的是**前端 xterm 解析器**（渲染端状态机），不是
 * PTY stdin——重置的是本终端的模式，与 agent 无关，也不会回流到 onData。
 */
export const MOUSE_REPORTING_DISABLE_SEQUENCE =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";

/**
 * 任务退出（done / failed / cancelled / interrupted）后调用：清掉运行期
 * 程序可能残留的鼠标上报模式，恢复本地拖选与滚轮滚动。
 *
 * 只在检测到上报协议确实开启时才写入，避免正常任务每次结束都多一段无谓的
 * 解析。写入走 term.write（渲染端解析），不经过 SmartWriter / replyGuard——
 * 关闭序列不会触发 xterm 自动应答，无需查询窗口。
 */
export function applyTerminalMouseModeReset(term: Terminal): void {
  if (term.modes.mouseTrackingMode === "none") return;
  term.write(MOUSE_REPORTING_DISABLE_SEQUENCE);
}
