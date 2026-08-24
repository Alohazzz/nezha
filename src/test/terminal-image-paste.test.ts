import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachSmartCopy, type TerminalKeyOptions } from "../components/terminalCopyHelper";
import type { Terminal } from "@xterm/xterm";

type KeyHandler = (e: KeyboardEvent) => boolean | undefined;

function makeFakeTerminal() {
  const paste = vi.fn();
  const hasSelection = vi.fn(() => false);
  let handler: KeyHandler | null = null;
  const term = {
    paste,
    hasSelection,
    attachCustomKeyEventHandler: (fn: KeyHandler) => {
      handler = fn;
    },
  } as unknown as Terminal;
  return {
    term,
    paste,
    handler: () => handler,
  };
}

function ctrlVKeydown(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "v",
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
  });
}

async function flushClipboard(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("attachSmartCopy Ctrl+V 图片粘贴", () => {
  let clipboardMock: {
    readText: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    clipboardMock = {
      readText: vi.fn(),
      read: vi.fn(),
    };
    Object.defineProperty(navigator, "clipboard", {
      value: clipboardMock,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("剪贴板只有图片（无文本）时：读取图片 → 交给 onPasteImage 保存 → 把返回路径粘贴进终端", async () => {
    const { term, paste, handler } = makeFakeTerminal();
    const onPasteImage = vi.fn().mockResolvedValue("C:/proj/.nezha/attachments/t1/pasted.png");
    const options: TerminalKeyOptions = { onPasteImage };

    clipboardMock.readText.mockResolvedValue("");
    clipboardMock.read.mockResolvedValue([
      {
        types: ["image/png"],
        getType: vi.fn().mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
      },
    ]);

    attachSmartCopy(term, options);
    handler()?.(ctrlVKeydown());
    await vi.waitFor(() => expect(onPasteImage).toHaveBeenCalledTimes(1));
    expect(onPasteImage.mock.calls[0][0]).toMatch(/^data:image\/png;base64,/);
    expect(paste).toHaveBeenCalledWith("C:/proj/.nezha/attachments/t1/pasted.png");
  });

  it("剪贴板有文本时保持原行为：只粘贴文本，不触发图片保存", async () => {
    const { term, paste, handler } = makeFakeTerminal();
    const onPasteImage = vi.fn();

    clipboardMock.readText.mockResolvedValue("hello world");

    attachSmartCopy(term, { onPasteImage });
    handler()?.(ctrlVKeydown());
    await flushClipboard();

    expect(paste).toHaveBeenCalledWith("hello world");
    expect(onPasteImage).not.toHaveBeenCalled();
  });

  it("剪贴板读不到图片时静默跳过（不崩溃）", async () => {
    const { term, paste, handler } = makeFakeTerminal();
    const onPasteImage = vi.fn();

    clipboardMock.readText.mockResolvedValue("");
    clipboardMock.read.mockResolvedValue([]);

    attachSmartCopy(term, { onPasteImage });
    handler()?.(ctrlVKeydown());
    await flushClipboard();

    expect(paste).not.toHaveBeenCalled();
    expect(onPasteImage).not.toHaveBeenCalled();
  });
});
