import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { attachSelectionForce } from "../components/terminalSelectionForce";

// 背景：Codex 0.16x TUI 运行期开启鼠标上报（?1002h），xterm bundle 中
// areMouseEventsActive ? selectionService.disable() : enable() 直接禁掉选区，
// 普通拖选无高亮；非 Mac shouldForceSelection 只看 e.shiftKey，Shift 事件在
// handleMouseDown 的 !_enabled 分支里 stopPropagation 并走本地拖选。
// 本模块在 capture 阶段把左键 mouse 事件重派发为 shiftKey:true 的合成事件。

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

function mouse(
  el: HTMLElement,
  type: string,
  opts: { button?: number; buttons?: number; shiftKey?: boolean } = {},
): MouseEvent {
  const e = new MouseEvent(type, {
    button: opts.button ?? 0,
    buttons: opts.buttons ?? 1,
    shiftKey: opts.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 40,
  });
  el.dispatchEvent(e);
  return e;
}

let current: Terminal | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("selection force-local during mouse reporting", () => {
  it("left mousedown with reporting on: original suppressed, shifted clone dispatched once", async () => {
    const term = current = mountTerminal();
    term.write("\x1b[?1049h\x1b[?1002h\x1b[?1006h");
    await tick();
    expect(term.modes.mouseTrackingMode).toBe("drag");

    const el = container();
    const originalListenerCalls: MouseEvent[] = [];
    // 模拟 xterm 的 mousedown listener（冒泡阶段）
    el.addEventListener("mousedown", (e) => originalListenerCalls.push(e));

    const dispose = attachSelectionForce(el, () => term);
    try {
      mouse(el, "mousedown");
      await tick(10);
      // 原始事件被 stopPropagation 压掉，listener 只看到带 shift 的合成事件
      expect(originalListenerCalls.length).toBe(1);
      expect(originalListenerCalls[0].shiftKey).toBe(true);
      // 无重入：合成事件不再触发第二次重派发（否则 listener 会看到 2+ 次）
    } finally {
      dispose();
    }
  });

  it("no interception when mouse reporting is off (normal drag untouched)", async () => {
    const term = current = mountTerminal();
    const el = container();
    const seen: MouseEvent[] = [];
    el.addEventListener("mousedown", (e) => seen.push(e));
    const dispose = attachSelectionForce(el, () => term);
    try {
      const original = mouse(el, "mousedown");
      await tick(10);
      // 上报未开启：原始事件原样到达，未被替换、未带 shift
      expect(seen).toEqual([original]);
      expect(seen[0].shiftKey).toBe(false);
    } finally {
      dispose();
    }
  });

  it("right button and already-shifted events pass through untouched", async () => {
    const term = current = mountTerminal();
    term.write("\x1b[?1049h\x1b[?1002h");
    await tick();
    const el = container();
    const seen: MouseEvent[] = [];
    el.addEventListener("mousedown", (e) => seen.push(e));
    const dispose = attachSelectionForce(el, () => term);
    try {
      mouse(el, "mousedown", { button: 2, buttons: 2 }); // 右键
      mouse(el, "mousedown", { shiftKey: true }); // 用户本就按着 Shift
      await tick(10);
      expect(seen.length).toBe(2);
      // 右键与原生 Shift 事件都不需要重派发（原生 Shift 事件对象原样传播）
      expect(seen[0].button).toBe(2);
      expect(seen[1].shiftKey).toBe(true);
    } finally {
      dispose();
    }
  });

  it("mousemove without left button held is ignored (no hot-path churn)", async () => {
    const term = current = mountTerminal();
    term.write("\x1b[?1049h\x1b[?1002h");
    await tick();
    const el = container();
    const seen: MouseEvent[] = [];
    el.addEventListener("mousemove", (e) => seen.push(e));
    const dispose = attachSelectionForce(el, () => term);
    try {
      mouse(el, "mousemove", { buttons: 0 }); // 悬停移动
      await tick(10);
      expect(seen.length).toBe(1);
      expect(seen[0].shiftKey).toBe(false);
    } finally {
      dispose();
    }
  });

  it("dispose removes interception", async () => {
    const term = current = mountTerminal();
    term.write("\x1b[?1049h\x1b[?1002h");
    await tick();
    const el = container();
    const seen: MouseEvent[] = [];
    el.addEventListener("mousedown", (e) => seen.push(e));
    const dispose = attachSelectionForce(el, () => term);
    dispose();
    mouse(el, "mousedown");
    await tick(10);
    expect(seen.length).toBe(1);
    expect(seen[0].shiftKey).toBe(false);
  });
});
