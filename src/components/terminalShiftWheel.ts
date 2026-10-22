import type { Terminal } from "@xterm/xterm";

/**
 * Shift+滚轮强制本地处理——修复 Codex 0.16x TUI 运行期间开启鼠标上报
 * （DECSET ?1000h/?1002h/?1006h）后，滚轮被转发给 PTY 对端、本地无法滚动的问题。
 *
 * xterm 6.0.0 bundle 实证（本次修角的依据，勿凭记忆改动）：
 * 1. `consumeWheelEvent` 开头 `if (0===deltaY || e.shiftKey) return 0`——Shift 滚轮
 *    本来就被排除出鼠标上报；
 * 2. 但 alt buffer（全屏 TUI）分支在 consumeWheelEvent 返回 0 后直接
 *    `cancel(t, true)` 吞掉事件——既不上报、也不滚动、也不发方向键，形成死区；
 * 3. 非 Mac `shouldForceSelection` 返回 `e.shiftKey`，Shift+拖选本来就通，
 *    缺的只是 Shift+滚轮。
 *
 * 因此在 capture 阶段（先于 xterm 的 wheel listener）拦截 Shift+wheel：
 * - alt buffer：合成方向键发往 PTY stdin（TUI 自己滚动它的滚动区），DECCKM
 *   对齐 xterm 内部逻辑（applicationCursorKeysMode ? ESCO A/B : ESC[ A/B）。
 *   走 onInput 与用户键入同路；方向键不是终端应答，replyGuard 必然放行；
 * - normal buffer：term.scrollLines 本地滚视口，Codex 的鼠标上报完全无关。
 *
 * 仅 Shift+wheel 被拦截；无修饰键的滚轮保持 xterm 原生分发（鼠标上报开启时
 * 转发给 TUI 是预期行为，Codex 用它做自身滚动）。
 */

/** 每次 wheel 事件滚动的行数。绕过了 xterm 的像素平滑分帧，取终端惯例值。 */
const SCROLL_LINES_PER_EVENT = 3;

function isShiftWheel(e: WheelEvent): boolean {
  return e.shiftKey && e.deltaY !== 0;
}

/**
 * 在容器上挂 capture 阶段 wheel 监听。返回 dispose 函数。
 *
 * `sendInput` 是 TerminalView / ShellTerminalPanel 已有的 PTY stdin 通路
 * （guarded forwarder 包裹的 onInput）；本模块只合成方向键，不会写入终端画面。
 */
export function attachShiftWheelScroll(
  container: HTMLElement,
  getTerminal: () => Terminal | null,
  sendInput: (data: string) => void,
): () => void {
  const handleWheel = (e: WheelEvent) => {
    if (!isShiftWheel(e)) return;
    const term = getTerminal();
    if (!term) return;
    // capture 阶段先行处理：xterm 的 alt-buffer 分支会吞掉 Shift wheel（见上），
    // 必须在它之前 preventDefault + 停止传播。
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? SCROLL_LINES_PER_EVENT : -SCROLL_LINES_PER_EVENT;
    if (term.buffer.active.type === "alternate") {
      // 全屏 TUI：滚轮语义 = 方向键。DECCKM 决定 ESCO / ESC[ 前缀，
      // 与 xterm 内部（bundle 中 hasScrollback 分支）的合成逻辑一致。
      const prefix = term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
      const key = e.deltaY > 0 ? "B" : "A";
      sendInput(`${prefix}${key}`);
    } else {
      term.scrollLines(delta);
    }
  };

  container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
  return () => {
    container.removeEventListener("wheel", handleWheel, { capture: true });
  };
}
