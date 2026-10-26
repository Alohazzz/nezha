import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexDiffView, CODEX_DIFF_MAX_ROWS } from "../components/codex-stream/CodexDiffView";
import type { CodexDiffFile } from "../components/codex-stream/codexDiffParse";

// shiki 动态 import 打桩：主包/语言包不得真加载（红线），只统计高亮入口调用次数
// ——「高亮是否收敛」最稳的可观测量（review finding：truncated 每渲染新对象导致
// 高亮 effect 无限循环，调用数会随计时器推进持续增长）。
const { getSingletonHighlighterMock } = vi.hoisted(() => ({
  getSingletonHighlighterMock: vi.fn(),
}));
vi.mock("shiki", () => ({ getSingletonHighlighter: getSingletonHighlighterMock }));

// ── 组件接缝（issue #117 T4）──────────────────────────────────────────────────
// 只断言外部可观察行为：截断 footer + 跳转回调、竞态下不产生过期更新。

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getSingletonHighlighterMock.mockReset();
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

describe("CodexDiffView review regressions", () => {
  it("highlight settles exactly once for a .ts diff (no re-highlight loop)", async () => {
    // 回归（review P0）：truncated 之前是每渲染新建的普通对象且在高亮 effect 依赖
    // 里 → highlight → setState → 新 identity → cleanup → 再 highlight……死循环。
    // 修复后 useMemo 稳定引用：idle 回调只触发一次 shiki 入口调用。
    getSingletonHighlighterMock.mockResolvedValue({
      codeToTokens: () => ({ tokens: [[" "]] }),
    });
    renderDiffView(makeFile(3));

    // 推进空闲兜底（jsdom 无 requestIdleCallback → 50ms setTimeout）+ shiki 微任务
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    const callsAfterSettle = getSingletonHighlighterMock.mock.calls.length;
    expect(callsAfterSettle).toBeGreaterThanOrEqual(1);

    // 再推 further 计时周期：已收敛的视图不得再次触发高亮
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(getSingletonHighlighterMock.mock.calls.length).toBe(callsAfterSettle);
  });

  it("renders plain-phase rows as raw text (no double escaping)", () => {
    // 回归（review P1）：无猜测语言（.unknown 扩展名）时 JSX 文本节点再包一层
    // escapeHtml 会把 `<` 渲染成字面 `&lt;`。React 文本自带转义，直接渲染原文。
    const file = makeFile(2);
    file.path = "src/data.unknown";
    render(
      <I18nProvider>
        <CodexDiffView file={file} maxRows={5} />
      </I18nProvider>,
    );
    const codeRows = document.querySelectorAll(".codex-stream-diff-code");
    expect(codeRows).toHaveLength(2);
    // textContent 含行号槽（add 行新行号 1/2）；内容槽是最后一个 span
    const contentSpan = codeRows[0].lastElementChild;
    expect(contentSpan?.textContent).toBe("line 0");
    expect(codeRows[0].innerHTML).not.toContain("&amp;");
    expect(codeRows[0].innerHTML).not.toContain("&lt;");
  });
});
