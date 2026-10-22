import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { attachShiftWheelScroll } from "../components/terminalShiftWheel";

// 背景：Codex 0.16x TUI 运行期开启鼠标上报（DECSET ?1000h/?1002h/?1006h）后，
// xterm 把滚轮转发给 PTY；且 alt buffer 分支对 Shift 滚轮 cancel 吞掉（死区）。
// 本模块在 capture 阶段拦截 Shift+wheel：alt buffer 合成方向键发 PTY stdin，
// normal buffer 本地 scrollLines。xterm 6.0.0 bundle 实证见 terminalShiftWheel.ts。

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

const container = () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
};

function wheel(el: HTMLElement, opts: { deltaY: number; shiftKey?: boolean }): void {
  el.dispatchEvent(
    new WheelEvent("wheel", { deltaY: opts.deltaY, shiftKey: opts.shiftKey ?? false, bubbles: true, cancelable: true }),
  );
}

let current: Terminal | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("shift+wheel forced local handling", () => {
  it("alt buffer: shift+wheel sends arrow keys to stdin, honoring DECCKM", async () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachShiftWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      // Codex TUI 形态：进 alt buffer + 开鼠标上报 + application cursor keys
      term.write("\x1b[?1049h\x1b[?1002h\x1b[?1h");
      await tick();
      expect(term.buffer.active.type).toBe("alternate");
      expect(term.modes.applicationCursorKeysMode).toBe(true);

      wheel(el, { deltaY: -120, shiftKey: true });
      wheel(el, { deltaY: 120, shiftKey: true });
      expect(sent).toEqual(["\x1bOA", "\x1bOB"]);
    } finally {
      dispose();
    }
  });

  it("alt buffer without DECCKM uses CSI arrows", async () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachShiftWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      term.write("\x1b[?1049h");
      await tick();
      wheel(el, { deltaY: 120, shiftKey: true });
      expect(sent).toEqual(["\x1b[B"]);
    } finally {
      dispose();
    }
  });

  it("normal buffer: shift+wheel scrolls locally, nothing reflows to stdin", async () => {
    const term = current = mountTerminal();
    // 造出 scrollback：写满屏再换行
    term.write(Array.from({ length: 60 }, (_, i) => `line-${i}\r\n`).join(""));
    await tick();
    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    const sent: string[] = [];
    const el = container();
    const dispose = attachShiftWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      // jsdom 无 renderer，Viewport 未初始化（scrollLines 走 core 路径，viewportY
      // 表现与真机不同），这里只锁行为分流：normal buffer 不发方向键进 stdin。
      // 滚动本身在真机由 term.scrollLines 接管（WebGL renderer 下 Viewport 生效）。
      wheel(el, { deltaY: 120, shiftKey: true });
      wheel(el, { deltaY: -120, shiftKey: true });
      expect(sent).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("plain wheel (no shift) is untouched — xterm native dispatch keeps working", () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachShiftWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      const seen: string[] = [];
      term.onData((d) => seen.push(d));
      wheel(el, { deltaY: 120 });
      // 本模块不拦截、不发送；xterm 自身（jsdom 无 renderer）不产生输入
      expect(sent).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("zero-deltaY and dispose behavior", () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachShiftWheelScroll(el, () => term, (d) => sent.push(d));
    wheel(el, { deltaY: 0, shiftKey: true });
    expect(sent).toEqual([]);
    dispose();
    wheel(el, { deltaY: 120, shiftKey: true });
    expect(sent).toEqual([]);
  });
});
