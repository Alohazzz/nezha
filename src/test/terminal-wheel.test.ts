import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { attachWheelScroll } from "../components/terminalWheel";

// 背景：Codex 0.16x TUI 运行期开启鼠标上报（DECSET ?1002h/?1006h），xterm 原生
// 转发在真机上不可靠（依赖 renderer 尺寸 / smooth-scroll 状态，可能静默丢弃）。
// 本模块在 capture 阶段接管滚轮：上报开启时合成 SGR 滚轮事件、无上报的经典
// 全屏程序（less/vim）合成方向键、normal buffer 本地 scrollLines。
// 不需要 Shift——普通滚轮直接生效，Shift 保留兼容但行为相同。

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

function wheel(
  el: HTMLElement,
  opts: { deltaY: number; shiftKey?: boolean; deltaMode?: number },
): void {
  el.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: opts.deltaY,
      shiftKey: opts.shiftKey ?? false,
      deltaMode: opts.deltaMode ?? WheelEvent.DOM_DELTA_LINE,
      bubbles: true,
      cancelable: true,
    }),
  );
}

let current: Terminal | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("wheel local takeover", () => {
  it("alt buffer with mouse reporting: plain wheel sends SGR wheel events (no Shift needed)", async () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      // Codex TUI 形态：alt buffer + drag 上报 + SGR 坐标 + DECCKM。
      term.write("\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?1h");
      await tick();
      expect(term.buffer.active.type).toBe("alternate");
      expect(term.modes.mouseTrackingMode).toBe("drag");

      wheel(el, { deltaY: -1 }); // 无修饰键
      wheel(el, { deltaY: 1 });
      // SGR 滚轮：64=up 65=down，坐标取屏幕中心（80x24 → 41;13）
      expect(sent).toEqual(["\x1b[<64;41;13M", "\x1b[<65;41;13M"]);

      // 同事件多行合并为一次 sendInput（修滚动不跟手：每次 sendInput 是一次 IPC）
      sent.length = 0;
      wheel(el, { deltaY: 3 });
      expect(sent).toEqual(["\x1b[<65;41;13M".repeat(3)]);

      // Shift 修饰滚轮行为相同（兼容旧肌肉记忆）
      sent.length = 0;
      wheel(el, { deltaY: -1, shiftKey: true });
      expect(sent).toEqual(["\x1b[<64;41;13M"]);
    } finally {
      dispose();
    }
  });

  it("alt buffer without mouse reporting falls back to arrows, honoring DECCKM", async () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      // 经典全屏程序（less/vim）：DECCKM 开 → ESCO 前缀
      term.write("\x1b[?1049h\x1b[?1h");
      await tick();
      expect(term.modes.applicationCursorKeysMode).toBe(true);
      wheel(el, { deltaY: -1 });
      expect(sent).toEqual(["\x1bOA"]);
    } finally {
      dispose();
    }
  });

  it("alt buffer without mouse reporting and without DECCKM uses CSI arrows", async () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      term.write("\x1b[?1049h");
      await tick();
      wheel(el, { deltaY: 1 });
      expect(sent).toEqual(["\x1b[B"]);
    } finally {
      dispose();
    }
  });

  it("normal buffer: wheel scrolls locally, nothing reflows to stdin", async () => {
    const term = current = mountTerminal();
    // 造出 scrollback：写满屏再换行
    term.write(Array.from({ length: 60 }, (_, i) => `line-${i}\r\n`).join(""));
    await tick();
    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    const sent: string[] = [];
    const el = container();
    const dispose = attachWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      // jsdom 无 renderer，Viewport 未初始化，viewportY 断言不可靠；锁行为分流：
      // normal buffer 不发方向键/SGR 进 stdin，滚动由 term.scrollLines 接管。
      wheel(el, { deltaY: 3 });
      wheel(el, { deltaY: -3 });
      expect(sent).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("pixel-mode wheel accumulates across events before synthesizing input", async () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachWheelScroll(el, () => term, (d) => sent.push(d));
    try {
      term.write("\x1b[?1049h\x1b[?1002h\x1b[?1006h");
      await tick();
      // 触控板：100px ≈ 3 行；50px = 1.5 行 → 立即发 1 条，余 0.5 进 carry
      wheel(el, { deltaY: 50, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
      expect(sent).toEqual(["\x1b[<65;41;13M"]);
      // 微位移 10px = 0.3 行；carry 0.5（上轮余数）+0.3 = 0.8 ≥ 0.5 → 发 1 条
      sent.length = 0;
      wheel(el, { deltaY: 10, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
      expect(sent).toEqual(["\x1b[<65;41;13M"]);
      // 不足阈值的小位移被攒住：重置 carry 后 10px = 0.3 < 0.5 → 不发
      sent.length = 0;
      wheel(el, { deltaY: -50, deltaMode: WheelEvent.DOM_DELTA_PIXEL }); // 反向消耗 carry
      sent.length = 0;
      wheel(el, { deltaY: 10, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
      expect(sent).toEqual([]);
      // 再 40px：carry 0.3+0.4=0.7 ≥ 0.5 → 发 1 条
      wheel(el, { deltaY: 40, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
      expect(sent).toEqual(["\x1b[<65;41;13M"]);
    } finally {
      dispose();
    }
  });

  it("zero-deltaY, ctrl/meta combos, and dispose are inert", () => {
    const term = current = mountTerminal();
    const sent: string[] = [];
    const el = container();
    const dispose = attachWheelScroll(el, () => term, (d) => sent.push(d));
    wheel(el, { deltaY: 0 });
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(sent).toEqual([]);
    dispose();
    wheel(el, { deltaY: 1 });
    expect(sent).toEqual([]);
  });
});
