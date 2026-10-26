import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexCommandEntry } from "../components/codex-stream/CodexCommandEntry";
import { codexToolCardExpansion } from "../components/codex-stream/CodexToolCard";
import type { CodexCommandExecutionItem } from "../types";

// ── 命令输出尾部截断（issue #117 T5，spec user story 15）──────────────────────
// 组件接缝：大输出命令卡展开后渲染的是尾部（行数有上限断言）+ 截断提示 +
// 复制全文按钮写剪贴板的是**全量**文本；常规输出不出现截断提示。

afterEach(() => {
  codexToolCardExpansion.clear();
  vi.restoreAllMocks();
});

function makeItem(output: string | null, overrides: Partial<CodexCommandExecutionItem> = {}): CodexCommandExecutionItem {
  return {
    type: "commandExecution",
    id: "cmd-tail",
    command: "npm run build",
    cwd: "/repo",
    status: "completed",
    aggregatedOutput: output,
    exitCode: 0,
    durationMs: 1200,
    ...overrides,
  };
}

function renderEntry(item: CodexCommandExecutionItem) {
  return render(
    <I18nProvider>
      <CodexCommandEntry item={item} revision={3} />
    </I18nProvider>,
  );
}

/** n 行输出，每行 ~120B。 */
function bigOutput(n: number): string {
  const row: string[] = [];
  for (let i = 1; i <= n; i++) row.push(`line-${String(i).padStart(6, "0")}${"x".repeat(100)}`);
  return row.join("\n");
}

describe("CodexCommandEntry output tail truncation", () => {
  it("renders large output as a bounded tail with truncation note and full-copy button", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    const output = bigOutput(20000); // ~2.4MB
    renderEntry(makeItem(output));

    // 完成态默认收起：手动展开
    fireEvent.click(screen.getByRole("button", { name: /npm run build/ }));

    // 截断提示出现（i18n key：codex.output.truncatedTail）
    const note = screen.getByTestId("codex-output-truncated-note");
    expect(note.textContent).toContain("20000");

    // 渲染行数有上限：展开区 pre 的文本行数远小于总行数（≤ 64KB/+余量 ÷ 行长）
    const pre = screen.getByTestId("codex-command-output-pre");
    const renderedLines = (pre.textContent ?? "").split("\n").length;
    expect(renderedLines).toBeLessThan(1000);
    expect(renderedLines).toBeGreaterThan(0);
    // 是尾部：含最后一行，不含第一行
    expect(pre.textContent).toContain("line-020000");
    expect(pre.textContent).not.toContain("line-000001\n");

    // 复制全文按钮：写入剪贴板的是**全量**输出
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(output);
    });
    // 且写入的长度与全量一致（防 \"toast 成功但内容截断\" 的假阳性）
    const written = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written.length).toBe(output.length);
    expect(written.startsWith("line-000001")).toBe(true);
  });

  it("shows no truncation note for normal-size output", () => {
    renderEntry(makeItem("step 1 ok\nstep 2 ok\ndone"));
    fireEvent.click(screen.getByRole("button", { name: /npm run build/ }));

    expect(screen.queryByTestId("codex-output-truncated-note")).toBeNull();
    const pre = screen.getByTestId("codex-command-output-pre");
    expect(pre.textContent).toBe("step 1 ok\nstep 2 ok\ndone");
  });

  it("feeds failure tooltip from the same tail logic (huge failed output → bounded detail)", () => {
    renderEntry(makeItem(bigOutput(20000), { status: "failed", exitCode: 1 }));
    // 失败态 tooltip 触发按钮出现（骨架接管）；详情进入 tooltip 的尾部受同一上限约束
    const trigger = screen.getByTitle("View failure detail");
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    const detail = screen.getByTestId("failure-detail");
    // tooltip 只承载尾部（骨架本身截 2000 字符）——不为全量 2.4MB
    expect((detail.textContent ?? "").length).toBeLessThan(64 * 1024 + 4096);
  });
});
