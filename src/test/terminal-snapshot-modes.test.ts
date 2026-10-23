import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { afterEach, describe, expect, it } from "vitest";

// 决定性实验：任务切换恢复链路（serialize → 新实例 write）是否保住鼠标上报模式。
// 用户实测：Codex 运行中切走再切回，Shift+滚轮变成方向键（打输入历史），
// 说明恢复后的终端 mouseTrackingMode === none —— 模式在快照链路某处丢失。

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

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let current: Terminal | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

describe("task-switch snapshot preserves mouse reporting mode", () => {
  it("serialize + write into fresh instance restores ?1002h/?1006h and alt buffer", async () => {
    const termA = mountTerminal();
    current = termA;
    termA.write("hello codex\r\n");
    await tick();
    // Codex TUI 形态：alt buffer + drag 上报 + SGR 坐标 + DECCKM + bracketed paste
    termA.write("\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?1h\x1b[?2004h");
    await tick();

    const serializeAddon = new SerializeAddon();
    termA.loadAddon(serializeAddon);
    const snapshot = serializeAddon.serialize();

    const termB = mountTerminal();
    current = termB;
    termB.write(snapshot);
    await tick();

    expect(termB.buffer.active.type).toBe("alternate");
    expect(termB.modes.mouseTrackingMode).toBe("drag");
    expect(termB.modes.applicationCursorKeysMode).toBe(true);
    expect(termB.modes.bracketedPasteMode).toBe(true);
    termA.dispose();
  });

  it("plain PTY byte-stream replay also restores the modes (fallback path)", async () => {
    // 无快照时回退 initialData = 原始 PTY 字节重放，DECSET 会再次经过解析器
    const termB = mountTerminal();
    current = termB;
    termB.write("\x1b[?1049h\x1b[?1002h\x1b[?1006h");
    await tick();
    expect(termB.buffer.active.type).toBe("alternate");
    expect(termB.modes.mouseTrackingMode).toBe("drag");
  });
});
