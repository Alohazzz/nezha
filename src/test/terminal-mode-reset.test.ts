import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTerminalMouseModeReset,
} from "../components/terminalModeReset";

// xterm 对应关系（DECSET + SGR 扩展坐标）：
//   ?1000h → vt200（按下/释放上报） ?1002h → drag ?1003h → any（任意移动上报）
// 用户实测（v0.34.0）：运行中的程序写入 ?1003h 后异常退出未发 ?1003l，
// 终端从此把拖选与滚轮全部转发给已死的 PTY 程序——拖动无选区、滚轮无响应；
// Shift 拖动（shouldForceSelection 非 Mac 分支）仍可强制本地选区。
function installXtermJsdomShims() {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        media: "",
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string) {
    if (id === "2d") {
      return {
        measureText: () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
        canvas: this,
        font: "12px monospace",
      } as unknown as CanvasRenderingContext2D;
    }
    return original.call(this, id as "2d");
  } as typeof HTMLCanvasElement.prototype.getContext;
}

function mountTerminal() {
  installXtermJsdomShims();
  const term = new Terminal({ cols: 80, rows: 24 });
  document.body.appendChild(term.element ?? document.createElement("div"));
  return term;
}

let current: Terminal | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("terminal mouse mode reset", () => {
  it("reset sequence clears every mouse tracking protocol", async () => {
    for (const [enable, expected] of [
      ["\x1b[?1000h", "vt200"],
      ["\x1b[?1002h", "drag"],
      ["\x1b[?1003h", "any"],
    ] as const) {
      const term = current = mountTerminal();
      term.write(enable);
      await tick();
      expect(term.modes.mouseTrackingMode).toBe(expected);

      applyTerminalMouseModeReset(term);
      await tick();
      expect(term.modes.mouseTrackingMode).toBe("none");
      term.dispose();
      current = null;
    }
  });

  it("reset is a no-op for an idle terminal and never reflows to onData", async () => {
    const term = current = mountTerminal();
    const seen: string[] = [];
    term.onData((d) => seen.push(d));
    // 空闲终端不写任何字节
    applyTerminalMouseModeReset(term);
    await tick();
    // 关闭序列走渲染端解析，不得回流到 onData（那是发往 PTY 程序的方向）
    expect(seen).toEqual([]);

    term.write("\x1b[?1000h");
    await tick();
    expect(term.modes.mouseTrackingMode).toBe("vt200");
    applyTerminalMouseModeReset(term);
    await tick();
    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(seen).toEqual([]);
  });

  it("reset sequence does not touch bracketed paste or cursor keys", async () => {
    const term = current = mountTerminal();
    term.write("\x1b[?2004h\x1b[?1h");
    await tick();
    applyTerminalMouseModeReset(term);
    await tick();
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(term.modes.applicationCursorKeysMode).toBe(true);
  });
});
