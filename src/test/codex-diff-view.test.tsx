import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexDiffView, CODEX_DIFF_MAX_ROWS } from "../components/codex-stream/CodexDiffView";
import type { CodexDiffFile } from "../components/codex-stream/codexDiffParse";

// ── 组件接缝（issue #117 T4）──────────────────────────────────────────────────
// 只断言外部可观察行为：截断 footer + 跳转回调、竞态下不产生过期更新。

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeFile(addedRows: number): CodexDiffFile {
  const rows = Array.from({ length: addedRows }, (_, i) => ({
    type: "add" as const,
    content: `line ${i}`,
    newLine: i + 1,
  }));
  return {
    path: "src/big.ts",
    oldPath: null,
    newPath: "src/big.ts",
    changeKind: "added",
    hunks: [
      { header: "@@ -0,0 +1,N @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: addedRows, rows },
    ],
    additions: addedRows,
    deletions: 0,
  };
}

function renderDiffView(file: CodexDiffFile, onOpenFullDiff?: () => void) {
  return render(
    <I18nProvider>
      <CodexDiffView file={file} maxRows={5} onOpenFullDiff={onOpenFullDiff} />
    </I18nProvider>,
  );
}

describe("CodexDiffView truncation", () => {
  it("shows the truncated footer and fires the jump callback", () => {
    const onOpenFullDiff = vi.fn();
    renderDiffView(makeFile(10), onOpenFullDiff);

    const footer = screen.getByTestId("codex-diff-truncated");
    expect(footer).toBeTruthy();
    // 省略量：10 - 5 行护栏
    expect(footer.textContent).toContain("5");

    fireEvent.click(screen.getByTestId("codex-diff-jump"));
    expect(onOpenFullDiff).toHaveBeenCalledTimes(1);
  });

  it("renders rows beyond the footer limit only once and keeps rendered rows exact", () => {
    const file = makeFile(10);
    renderDiffView(file);
    // 护栏 5 行 + footer；无跳转回调时 footer 仍显示提示但不渲染按钮
    expect(document.querySelectorAll(".codex-stream-diff-row[data-type='add']")).toHaveLength(5);
    expect(screen.getByTestId("codex-diff-truncated")).toBeTruthy();
    expect(screen.queryByTestId("codex-diff-jump")).toBeNull();
  });

  it("keeps the production guard at 2000 rows", () => {
    expect(CODEX_DIFF_MAX_ROWS).toBe(2000);
  });
});

describe("CodexDiffView race safety", () => {
  it("does not update after unmount while the idle highlight is pending", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderDiffView(makeFile(3));
    // 不 flush idle 回调（jsdom 无 requestIdleCallback → setTimeout(50) 仍挂起），
    // 直接卸载：高亮 promise 即便随后 resolve 也不得触碰已卸载组件
    unmount();

    // 放行所有挂起的定时器，让被取消的 idle 回调与（若未被取消的）shiki 链跑完
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        resolve();
      }, 120);
    });
  });
});
