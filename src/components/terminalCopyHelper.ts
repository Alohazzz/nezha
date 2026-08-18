import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { APP_PLATFORM } from "../platform";
import { APP_SETTINGS_CHANGED_EVENT } from "./app-settings/types";

/** Threshold below which we use the fast synchronous path. */
const FAST_PATH_MAX_LINES = 200;
const FAST_PATH_MAX_BYTES = 128 * 1024; // 128 KB

/** How many lines to process per chunk before yielding. */
const LINES_PER_CHUNK = 128;

type SelectionPosition = [column: number, row: number];

interface XtermSelectionService {
  selectionStart?: SelectionPosition | null;
  selectionEnd?: SelectionPosition | null;
}

type TerminalWithSelectionService = Terminal & {
  _core?: {
    _selectionService?: XtermSelectionService;
  };
};

function getSelectionService(terminal: Terminal): XtermSelectionService | undefined {
  return (terminal as TerminalWithSelectionService)._core?._selectionService;
}

/** Yield to the main thread so rendering / PTY writes can proceed. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Read the selected text from the xterm buffer line-by-line in async chunks.
 * This avoids the single long-task that `terminal.getSelection()` produces
 * when thousands of lines are selected.
 */
async function readSelectionChunked(terminal: Terminal): Promise<string> {
  const sel = getSelectionService(terminal);
  if (!sel) {
    // Fallback: internal API unavailable
    return terminal.getSelection();
  }

  const selectionStart = sel.selectionStart;
  const selectionEnd = sel.selectionEnd;
  if (!selectionStart || !selectionEnd) {
    return terminal.getSelection();
  }

  // Normalise: ensure start is before end
  let startRow = selectionStart[1];
  let startCol = selectionStart[0];
  let endRow = selectionEnd[1];
  let endCol = selectionEnd[0];

  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    [startRow, endRow] = [endRow, startRow];
    [startCol, endCol] = [endCol, startCol];
  }

  const buffer = terminal.buffer.active;
  const chunks: string[] = [];
  let linesInChunk = 0;

  for (let y = startRow; y <= endRow; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;

    const isSingleLine = startRow === endRow;
    const isFirstLine = y === startRow;
    const isLastLine = y === endRow;

    let trimStart = 0;
    let trimEnd = terminal.cols;

    if (isSingleLine) {
      trimStart = startCol;
      trimEnd = endCol;
    } else if (isFirstLine) {
      trimStart = startCol;
    } else if (isLastLine) {
      trimEnd = endCol;
    }

    const text = line.translateToString(!isLastLine || isSingleLine, trimStart, trimEnd);
    chunks.push(text);

    // Add newline between lines, but not after wrapped lines or the last line
    if (!isLastLine && !line.isWrapped) {
      // The next line being wrapped means it's a continuation — don't add \n
      const nextLine = buffer.getLine(y + 1);
      if (!nextLine || !nextLine.isWrapped) {
        chunks.push("\n");
      }
    }

    linesInChunk++;
    if (linesInChunk >= LINES_PER_CHUNK) {
      linesInChunk = 0;
      await yieldToMain();
    }
  }

  return chunks.join("");
}

/**
 * Smart copy: fast path for small selections, chunked async path for large ones.
 * Returns true if the copy was handled, false if the caller should fall through
 * to default behaviour (e.g. Ctrl-C sending SIGINT when nothing is selected).
 */
export async function smartCopy(terminal: Terminal): Promise<boolean> {
  if (!terminal.hasSelection()) return false;

  const sel = getSelectionService(terminal);
  let lineCount = 0;
  if (sel?.selectionStart && sel?.selectionEnd) {
    lineCount = Math.abs(sel.selectionEnd[1] - sel.selectionStart[1]) + 1;
  }

  let text: string;

  if (lineCount <= FAST_PATH_MAX_LINES) {
    // Fast path: synchronous — small enough to not matter
    text = terminal.getSelection();
    if (text.length > FAST_PATH_MAX_BYTES) {
      // Oops, still large (very wide lines). Fall through to chunked.
      text = await readSelectionChunked(terminal);
    }
  } else {
    // Chunked path: yield between batches of lines
    text = await readSelectionChunked(terminal);
  }

  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for older WebView or permission denial
    const prevFocus = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    // textarea.select() 抢走了焦点，归还给原持有者（终端 textarea 或别处输入框）。
    if (prevFocus instanceof HTMLElement && prevFocus.isConnected) {
      prevFocus.focus({ preventScroll: true });
    }
  }

  return true;
}

// --- copy-on-select 应用级开关：懒启动的模块级单例,跟随设置弹窗的 CHANGED 事件刷新。
// 默认 false(加载失败也回落 false),与后端 default 一致——功能宁可迟开不可误开。
let copyOnSelectEnabled = false;
let copyOnSelectWatcherStarted = false;

function refreshCopyOnSelectSetting() {
  invoke<{ terminal_copy_on_select?: unknown }>("load_app_settings")
    .then((settings) => {
      copyOnSelectEnabled = settings.terminal_copy_on_select === true;
    })
    .catch(() => {
      copyOnSelectEnabled = false;
    });
}

function ensureCopyOnSelectWatcher() {
  if (copyOnSelectWatcherStarted) return;
  copyOnSelectWatcherStarted = true;
  refreshCopyOnSelectSetting();
  window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refreshCopyOnSelectSetting);
}

/**
 * 框选松手后自动复制选区（copy-on-select）。
 *
 * 触发点必须是 pointerup 一次性动作，绝不能挂在 onSelectionChange 上：
 * 拖选过程中 selection change 连续触发，大选区反复 getSelection() 会产生
 * 长任务（smartCopy 的分块读取正是为规避它而存在）。
 */
export function attachCopyOnSelect(terminal: Terminal, container: HTMLElement): () => void {
  ensureCopyOnSelectWatcher();

  let selecting = false;
  let copyInProgress = false;

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    selecting = true;
  };

  const completeSelection = () => {
    // document 级监听：必须先确认拖选起点在终端容器内，否则会响应页面
    // 其他区域的选择手势（与 attachMacWebKitTerminalGuard 同款守卫）。
    if (!selecting) return;
    selecting = false;
    if (!copyOnSelectEnabled || copyInProgress || !terminal.hasSelection()) return;
    copyInProgress = true;
    smartCopy(terminal).finally(() => {
      copyInProgress = false;
    });
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    completeSelection();
  };

  container.addEventListener("pointerdown", handlePointerDown);
  document.addEventListener("pointerup", handlePointerUp);
  document.addEventListener("pointercancel", completeSelection);

  return () => {
    container.removeEventListener("pointerdown", handlePointerDown);
    document.removeEventListener("pointerup", handlePointerUp);
    document.removeEventListener("pointercancel", completeSelection);
  };
}

export interface TerminalKeyOptions {
  /** Whether a key event matches the configured "insert newline" combo. */
  matchesNewline?: (e: KeyboardEvent) => boolean;
  /** Called (instead of the default submit) when that combo is pressed. */
  onNewline?: () => void;
}

/**
 * Attach the smart copy handler to a terminal instance. Optionally also
 * intercepts the configured "insert newline" combo. xterm allows a single
 * custom key event handler, so both behaviours share this one.
 * Returns a dispose function.
 */
export function attachSmartCopy(
  terminal: Terminal,
  keyOptions?: TerminalKeyOptions,
): () => void {
  let copyInProgress = false;

  const handleCustomKeyEvent = (e: KeyboardEvent) => {
    // Insert-newline shortcut (e.g. Shift/Alt + Enter): emit our own sequence
    // instead of letting xterm send a bare CR, which the agent treats as submit.
    if (
      e.type === "keydown" &&
      keyOptions?.onNewline &&
      keyOptions.matchesNewline?.(e)
    ) {
      e.preventDefault();
      keyOptions.onNewline();
      return false;
    }

    // Windows / Linux WebView 下 Ctrl+V 不会触发 xterm textarea 的 paste 事件，
    // 需要手动读剪贴板并通过 term.paste() 注入。macOS WKWebView 走 Cmd+V 原生路径。
    if (
      e.type === "keydown" &&
      APP_PLATFORM !== "macos" &&
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      (e.key === "v" || e.key === "V")
    ) {
      e.preventDefault();
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) terminal.paste(text);
        })
        .catch(() => {});
      return false;
    }

    const isCopy =
      (e.metaKey || e.ctrlKey) && e.key === "c" && e.type === "keydown";

    if (!isCopy) return true; // Let xterm handle other keys
    if (!terminal.hasSelection()) return true; // No selection → send SIGINT as normal

    if (copyInProgress) {
      e.preventDefault();
      return false;
    }

    // Prevent default and handle copy ourselves
    e.preventDefault();
    copyInProgress = true;

    smartCopy(terminal).finally(() => {
      copyInProgress = false;
    });

    return false; // Don't let xterm process this key
  };

  terminal.attachCustomKeyEventHandler(handleCustomKeyEvent);

  return () => {
    terminal.attachCustomKeyEventHandler(() => true);
  };
}
