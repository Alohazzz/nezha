import type { Terminal } from "@xterm/xterm";

/**
 * 滚轮本地接管——让 Codex 0.16x TUI 运行期间（开启鼠标上报
 * DECSET ?1002h+?1006h）的滚轮滚动**不再依赖 Shift**，普通滚轮即可滚 transcript。
 *
 * 为什么普通滚轮在真机上不可靠（2026-10 实测：Codex 运行中滚轮无效，Shift+滚轮
 * 才有效；切任务回来后现象不变）：xterm 原生转发走 `getMouseReportCoords` →
 * `consumeWheelEvent` 内部链路，依赖 renderer 尺寸 / DPR / smooth-scroll 分帧等
 * 运行时状态；任何一环不满足它就静默丢弃事件（bundle 中 `return 0` → cancel）。
 * 因此本模块在 capture 阶段直接接管滚轮，自己合成与 xterm 相同格式的上报字节
 * 直投 PTY，不依赖 xterm 内部状态。
 *
 * 分流语义：
 * - alt buffer + 鼠标上报开启（Codex 0.16x 运行期的形态）：合成 SGR 滚轮事件
 *   （`ESC[<64;col;rowM` 上滚 / `ESC[<65;col;rowM` 下滚），坐标取屏幕中心
 *   （ratatui 类 TUI 只消费方向）。**不能发方向键**——Codex composer 会把方向键
 *   当上下键切换输入历史（用户实测回归）；
 * - alt buffer + 无鼠标上报（less / vim 等经典全屏程序）：合成方向键，DECCKM
 *   对齐 xterm 内部逻辑（applicationCursorKeysMode ? ESCO A/B : ESC[ A/B）；
 * - normal buffer：term.scrollLines 本地滚视口，鼠标上报完全无关。
 *
 * Shift 修饰键不再有特殊含义：两条 alt buffer 分支对普通与 Shift 滚轮一视同仁
 * （保留 Shift 兼容旧肌肉记忆，行为相同）。无修饰键语义在 normal buffer 下也
 * 未改变——本来就地滚动。
 */

/** 与 xterm consumeWheelEvent 的 DOM_DELTA_PIXEL 常量对齐：100px ≈ 3 行。 */
const PIXELS_PER_LINE = 100 / 3;

function isWheelEventRelevant(e: WheelEvent): boolean {
  return e.deltaY !== 0 && !e.ctrlKey && !e.metaKey;
}

/**
 * 在容器上挂 capture 阶段 wheel 监听。返回 dispose 函数。
 *
 * `sendInput` 是 TerminalView / ShellTerminalPanel 已有的 PTY stdin 通路
 * （guarded forwarder 包裹的 onInput）；本模块只合成输入序列，不写终端画面。
 */
export function attachWheelScroll(
  container: HTMLElement,
  getTerminal: () => Terminal | null,
  sendInput: (data: string) => void,
): () => void {
  // 触控板像素模式的小位移累加器（跨行才合成一次输入）；重置时机为 buffer 切换。
  let pixelCarry = 0;
  let carryBufferType: string | null = null;

  const handleWheel = (e: WheelEvent) => {
    if (!isWheelEventRelevant(e)) return;
    const term = getTerminal();
    if (!term) return;
    // capture 阶段先行处理：xterm 的 alt-buffer 分支会吞掉滚轮（上报时转发给
    // PTY，无 scrollback 时 cancel），必须在它之前 preventDefault + 停止传播。
    e.preventDefault();
    e.stopPropagation();

    const bufferType = term.buffer.active.type;
    if (bufferType !== carryBufferType) {
      pixelCarry = 0;
      carryBufferType = bufferType;
    }

    // 归一为「行数」：像素模式累加，≥0.5 行即发（攒整数会让轻滚迟滞、不跟手），
    // remainder 保留到下一事件；行/页模式直接换算。
    let lines: number;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
      pixelCarry += e.deltaY / PIXELS_PER_LINE;
      const sign = Math.sign(pixelCarry);
      const abs = Math.abs(pixelCarry);
      const whole = Math.floor(abs);
      const frac = abs - whole;
      if (whole > 0) {
        pixelCarry = sign * frac;
        lines = sign * whole;
      } else if (frac >= 0.5) {
        pixelCarry = 0;
        lines = sign;
      } else {
        return;
      }
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      lines = e.deltaY;
    } else {
      lines = e.deltaY * term.rows; // DOM_DELTA_PAGE
    }

    if (bufferType === "alternate") {
      // 同一事件内同方向的多次合并在**一次** sendInput 里发出：每条独立
      // sendInput = 一次 invoke("send_input") IPC 往返，加速滚动时一帧可达
      // 多次，逐条发是「滚动不跟手」的主因。TUI 逐条解析拼接后的序列，语义不变。
      const n = Math.min(Math.abs(lines), 30); // 单事件上限，防狂发
      let payload: string;
      if (term.modes.mouseTrackingMode !== "none") {
        // SGR 滚轮：64=up 65=down，1-based 坐标取屏幕中心。
        const button = lines > 0 ? 65 : 64;
        const col = Math.max(1, Math.min(term.cols, Math.floor(term.cols / 2) + 1));
        const row = Math.max(1, Math.min(term.rows, Math.floor(term.rows / 2) + 1));
        payload = `\x1b[<${button};${col};${row}M`.repeat(n);
      } else {
        // 经典全屏程序：滚轮语义 = 方向键。
        const prefix = term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
        const key = lines > 0 ? "B" : "A";
        payload = `${prefix}${key}`.repeat(n);
      }
      sendInput(payload);
    } else {
      term.scrollLines(lines);
    }
  };

  container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
  return () => {
    container.removeEventListener("wheel", handleWheel, { capture: true });
  };
}
