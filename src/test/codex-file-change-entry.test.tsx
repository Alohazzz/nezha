import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexFileChangeEntry } from "../components/codex-stream/CodexFileChangeEntry";
import { codexToolCardExpansion } from "../components/codex-stream/CodexToolCard";
import type { CodexFileChangeItem } from "../types";

// ── 文件变更卡重构（issue #117 T4）────────────────────────────────────────────
// 单文件 = 一张卡；多文件 = 父卡汇总 + per-file 子卡独立展开（子卡键互不碰撞）。

afterEach(() => {
  codexToolCardExpansion.clear();
});

function makeItem(changes: CodexFileChangeItem["changes"]): CodexFileChangeItem {
  return {
    type: "fileChange",
    id: "fc-multi",
    status: "completed",
    changes,
  };
}

function renderEntry(item: CodexFileChangeItem, onOpenGitChanges?: () => void) {
  return render(
    <I18nProvider>
      <CodexFileChangeEntry item={item} onOpenGitChanges={onOpenGitChanges} />
    </I18nProvider>,
  );
}

const singleFile = makeItem([
  {
    path: "src/one.ts",
    kind: { type: "update", movePath: null },
    diff: "--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1 @@\n-a\n+b",
  },
]);

const multiFile = makeItem([
  {
    path: "src/a.ts",
    kind: { type: "update", movePath: null },
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-aa\n+ab",
  },
  {
    path: "src/b.ts",
    kind: { type: "add" },
    diff: "--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+bb",
  },
]);

describe("CodexFileChangeEntry", () => {
  it("renders a single file as one card with badge and stats in the summary", () => {
    renderEntry(singleFile);
    const header = screen.getByRole("button", { name: /src\/one\.ts/ });
    expect(header).toBeTruthy();
    // 摘要行带 +N/−N 与变更徽标（modified 来自 update kind）
    expect(header.textContent).toContain("+1");
    expect(header.textContent).toContain("−1");
    // 默认收起：diff 内容不可见
    expect(screen.queryByText("b")).toBeNull();
  });

  it("renders multi-file as parent summary plus independent per-file child cards", () => {
    renderEntry(multiFile);
    // 父卡汇总：2 files changed + 总 +2/−1；父卡默认收起 → 子卡不在 DOM
    const parent = screen.getByRole("button", { name: /2 files changed/ });
    expect(parent.textContent).toContain("+2");
    expect(parent.textContent).toContain("−1");
    expect(screen.queryByRole("button", { name: /src\/a\.ts/ })).toBeNull();

    // 展开父卡 → per-file 子卡出现；默认全部收起
    fireEvent.click(parent);
    expect(screen.getByRole("button", { name: /src\/a\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /src\/b\.ts/ })).toBeTruthy();
    expect(screen.queryByText("ab")).toBeNull();
    expect(screen.queryByText("bb")).toBeNull();

    // 只展开 a.ts 子卡：b.ts 内容不出现（独立展开，Map 键不碰撞）
    fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));
    expect(screen.getByText("ab")).toBeTruthy();
    expect(screen.queryByText("bb")).toBeNull();

    // 子卡持久键是 per-file 的：Map 里是 "fc-multi:0:src/a.ts" 这类键
    const keys = [...codexToolCardExpansion.keys()];
    expect(keys.some((k) => k.startsWith("fc-multi:0:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("fc-multi:1:"))).toBe(false);
  });

  it("derives added badge and stats for a structured add change", () => {
    renderEntry(multiFile);
    fireEvent.click(screen.getByRole("button", { name: /2 files changed/ }));
    const addHeader = screen.getByRole("button", { name: /src\/b\.ts/ });
    expect(addHeader.textContent).toContain("+1");
    expect(addHeader.textContent).toContain("added");
  });
});

// ── 结构化改版：文件变更卡与思考卡交互一致 ────────────────────────────────────
// 编辑期间（inProgress）不再自动弹开卡体，摘要行跑马灯跟播最新一行变更；
// 完整 diff 留在手动展开区。

describe("CodexFileChangeEntry streaming marquee", () => {
  function renderRunning(item: CodexFileChangeItem) {
    return render(
      <I18nProvider>
        <CodexFileChangeEntry item={{ ...item, status: "inProgress" }} />
      </I18nProvider>,
    );
  }

  it("stays collapsed while streaming and marquee-scrolls the latest diff line", () => {
    renderRunning(singleFile);
    // 卡体不自动展开：diff 内容不可见
    expect(screen.queryByText("b")).toBeNull();
    // 摘要行承载最新一行变更（+ 前缀）
    const live = screen.getByTestId("codex-filechange-live-line");
    expect(live.textContent).toBe("+b");
    expect(live.getAttribute("data-live")).toBe("true");
  });

  it("multi-file parent streams the latest change across files while collapsed", () => {
    renderRunning(multiFile);
    // 子卡不出现（父卡保持收起）
    expect(screen.queryByRole("button", { name: /src\/a\.ts/ })).toBeNull();
    // 最新变更是最后一个文件的最后一行
    expect(screen.getByTestId("codex-filechange-live-line").textContent).toBe("+bb");
  });

  it("falls back to the static path once completed", () => {
    renderEntry(singleFile);
    expect(screen.queryByTestId("codex-filechange-live-line")).toBeNull();
    expect(screen.getByText("src/one.ts")).toBeTruthy();
    expect(screen.queryByText("b")).toBeNull();
  });

  it("does not stream an empty line when the diff has no parsed rows yet", () => {
    // 流式累积初期：diff 文本还没有 hunk 行 → 跑马灯挂载但内容为空
    renderRunning(makeItem([{ path: "", kind: { type: "update", movePath: null }, diff: "" }]));
    expect(screen.getByTestId("codex-filechange-live-line").textContent).toBe("");
  });
});
