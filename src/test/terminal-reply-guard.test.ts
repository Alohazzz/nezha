import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { createSmartWriter } from "../components/terminalShared";
import {
  createGuardedForwarder,
  createTerminalReplyGuard,
  isTerminalQuery,
  isTerminalReply,
  type TerminalReplyGuard,
} from "../components/terminalReplyGuard";

// ── 真实 xterm 6.0.0 实测得到的字节串（issue #81）────────────────────────────
const DA1_QUERY = "\x1b[c";
const DA1_REPLY = "\x1b[?1;2c";
const OSC10_QUERY = "\x1b]10;?\x1b\\";
const OSC10_REPLY = "\x1b]10;rgb:cdcd/d6d6/f4f4\x1b\\";
const OSC11_QUERY = "\x1b]11;?\x1b\\";
const OSC11_REPLY = "\x1b]11;rgb:1a1a/1b1b/1d1d\x1b\\";

/** 用户截图里 composer 内的可见乱码（ESC 被 TUI 文本层丢弃后的残留）。 */
const USER_VISIBLE_GARBAGE = "[?1;2c]10;rgb:cdcd/d6d6/f4f4\\]11;rgb:1a1a/1b1b/1d1d\\";

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

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** 复刻 TerminalView 的回流接线：writer 负责「记录输出里的查询」，forwarder 负责放行。 */
function mountTerminal() {
  installXtermJsdomShims();
  const term = new Terminal({ cols: 80, rows: 24, theme: { foreground: "#cdd6f4", background: "#1a1b1d" } });
  const toStdin: string[] = [];
  const guard: TerminalReplyGuard = createTerminalReplyGuard();
  // 与 TerminalView 相同的组合：createSmartWriter(term, guard) + createGuardedForwarder
  const writer = createSmartWriter(term, guard);
  term.onData(createGuardedForwarder(guard, (d) => toStdin.push(d)));
  const div = document.createElement("div");
  Object.defineProperty(div, "clientWidth", { value: 800 });
  Object.defineProperty(div, "clientHeight", { value: 400 });
  document.body.appendChild(div);
  term.open(div);
  return { term, writer, guard, toStdin };
}

describe("terminalReplyGuard：区分终端自动应答与用户键入", () => {
  it("按形状识别查询与应答（含真实字节串）", () => {
    expect(isTerminalQuery(DA1_QUERY)).toBe(true);
    expect(isTerminalQuery(OSC11_QUERY)).toBe(true);
    expect(isTerminalReply(DA1_REPLY)).toBe(true);
    expect(isTerminalReply(OSC10_REPLY)).toBe(true);
    expect(isTerminalReply(OSC11_REPLY)).toBe(true);
    // 普通键入 / 方向键 / 粘贴文本不能被误判成应答
    expect(isTerminalReply("ls\r")).toBe(false);
    expect(isTerminalReply("\x1b[O")).toBe(false);
    expect(isTerminalReply("ESC[?1;2c")).toBe(false);
  });

  it("窗口内放行应答，窗口过期后丢弃（注入时钟）", () => {
    let t = 1_000;
    const guard = createTerminalReplyGuard(() => t);
    expect(guard.admit(OSC11_REPLY)).toBe(false);

    guard.noteTerminalInput(OSC11_QUERY);
    expect(guard.admit(OSC11_REPLY)).toBe(true);

    t += 10_000; // 超过 REPLY_GRACE_MS
    expect(guard.admit(OSC11_REPLY)).toBe(false);
  });

  it("普通键入任何时刻都放行", () => {
    const guard = createTerminalReplyGuard(() => 0);
    expect(guard.admit("a")).toBe(true);
    expect(guard.admit("\x1b[A")).toBe(true);
    expect(guard.admit("echo hi\r")).toBe(true);
  });

  it("未观测到查询时丢弃 DA1 应答（ConPTY 宿主的查询不经过应用输出）", async () => {
    const { term, toStdin } = mountTerminal();
    term.write(DA1_QUERY);
    await flush();
    expect(toStdin).toEqual([]);
    term.dispose();
  });

  it("实时输出里出现 OSC 11 查询后，其应答仍被放行（不回退 #74 主题修复）", async () => {
    const { term, writer, toStdin } = mountTerminal();
    // Codex 的探测经 PTY 输出流到达 → 由 writer 记录
    writer.write(OSC11_QUERY);
    await flush();
    expect(toStdin).toContain(OSC11_REPLY);
    term.dispose();
  });

  it("回放历史输出（restore 直接 write，不经 writer）不会把旧查询的应答写进 stdin", async () => {
    const { term, toStdin } = mountTerminal();
    // 复刻终端重挂载：initialData 里带着历史的探测序列，直接 term.write
    term.write(DA1_QUERY + OSC10_QUERY + OSC11_QUERY);
    await flush();
    const visible = toStdin.join("").split("\u001b").join("");
    expect(visible).not.toBe(USER_VISIBLE_GARBAGE);
    expect(toStdin).toEqual([]);
    term.dispose();
  });
});
