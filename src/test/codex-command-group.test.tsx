import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexStreamView } from "../components/codex-stream/CodexStreamView";
import { codexToolCardExpansion } from "../components/codex-stream/CodexToolCard";
import type { CodexStreamEntry } from "../hooks/codexStreamMerge";
import type { CodexCommandExecutionItem } from "../types";

// ── 聚合组渲染（密集度改版，对标 ZCode executeGroup）────────────────────────
// 接缝：CodexStreamView 拿一串 commandExecution 条目，渲染出**单条**「终端」摘要行，
// 而不是逐条铺开；组行运行中不自动展开，完成后显示命令数与失败数。

function cmd(
  id: string,
  overrides: Partial<CodexCommandExecutionItem> = {},
): Extract<CodexStreamEntry, { kind: "commandExecution" }> {
  return {
    kind: "commandExecution",
    revision: 0,
    item: {
      type: "commandExecution",
      id,
      command: `bash -lc "echo ${id}"`,
      cwd: "/repo",
      status: "completed",
      aggregatedOutput: `out-${id}`,
      exitCode: 0,
      durationMs: 1200,
      ...overrides,
    },
  };
}

function renderStream(entries: CodexStreamEntry[]) {
  return render(
    <I18nProvider>
      <CodexStreamView
        entries={entries}
        usage={null}
        approval={null}
        onApprovalResolved={() => {}}
        running={false}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  codexToolCardExpansion.clear();
});

describe("command group rendering", () => {
  it("collapses consecutive commands into one terminal summary row", () => {
    renderStream([cmd("c1"), cmd("c2"), cmd("c3")]);

    // 只有一条摘要行（组壳），不再逐条铺开
    const categoryCells = screen.getAllByText("Terminal");
    expect(categoryCells).toHaveLength(1);
    // 阶段文案显示命令条数；最后一条命令作为摘要正文
    expect(screen.getByText("3 commands")).toBeTruthy();
    expect(screen.getByText("echo c3")).toBeTruthy();
    // 未展开：逐条命令的输出都不可见
    expect(screen.queryByText("out-c1")).toBeNull();
  });

  it("counts failures in the collapsed group summary", () => {
    renderStream([
      cmd("c1"),
      cmd("c2", { status: "failed", exitCode: 1, aggregatedOutput: "boom" }),
    ]);
    expect(screen.getByText("1 failed")).toBeTruthy();
  });

  it("does not auto-expand a running group but shows the command in flight", () => {
    renderStream([
      cmd("c1"),
      cmd("c2", { status: "inProgress", exitCode: null, durationMs: null }),
    ]);
    // 运行中：阶段词「Running」+ 在跑的这条命令
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("echo c2")).toBeTruthy();
    // 组保持收起（明细不铺开）
    expect(screen.queryByText("out-c1")).toBeNull();
  });

  it("reveals per-command rows without duplicating icon or category when expanded", () => {
    renderStream([cmd("c1"), cmd("c2")]);

    fireEvent.click(screen.getByRole("button", { name: /2 commands/ }));
    // 展开后仍只有一个类别词（组壳），子行是紧凑形态
    expect(screen.getAllByText("Terminal")).toHaveLength(1);
    // 子行摘要露出两条命令；输出仍各自收起（组展开 ≠ 子卡展开）
    expect(screen.getByText("echo c1")).toBeTruthy();
    expect(screen.getByText("echo c2")).toBeTruthy();
    expect(screen.queryByText("out-c1")).toBeNull();

    // 再点子行才露出该条输出
    fireEvent.click(screen.getByRole("button", { name: /echo c1/ }));
    expect(screen.getByText("out-c1")).toBeTruthy();
  });

  it("keeps a lone command as its own row (no single-child group wrapper)", () => {
    renderStream([cmd("c1")]);
    // 单条命令走原命令卡：类别词是「Command」，不是组壳的「Terminal」
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.getByText("Command")).toBeTruthy();
    expect(screen.getByText("echo c1")).toBeTruthy();
  });

  it("splits groups at any non-command entry", () => {
    const textEntry: CodexStreamEntry = {
      kind: "agentMessage",
      revision: 0,
      item: { type: "agentMessage", id: "m1", text: "between" },
    };
    renderStream([cmd("c1"), cmd("c2"), textEntry, cmd("c3"), cmd("c4")]);
    expect(screen.getAllByText("Terminal")).toHaveLength(2);
    expect(screen.getByText("between")).toBeTruthy();
  });
});
