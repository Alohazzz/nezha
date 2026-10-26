import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexStreamView } from "../components/codex-stream/CodexStreamView";
import { codexEntryRenderers } from "../components/codex-stream/codexRenderers";
import { codexToolCardExpansion } from "../components/codex-stream/CodexToolCard";
import type { CodexStreamEntry } from "../hooks/codexStreamMerge";
import type {
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexMcpToolCallItem,
  CodexReasoningItem,
} from "../types";

// jsdom 缺少 Radix Popover 交互所需的 pointer capture API。
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const commandEntry: CodexStreamEntry = {
  kind: "commandExecution",
  revision: 0,
  item: {
    type: "commandExecution",
    id: "cmd-1",
    command: "npm install",
    cwd: "/repo",
    status: "completed",
    aggregatedOutput: "added 128 packages",
    exitCode: 0,
    durationMs: 1200,
  } satisfies CodexCommandExecutionItem,
};

const mcpEntry: CodexStreamEntry = {
  kind: "mcpToolCall",
  revision: 0,
  item: {
    type: "mcpToolCall",
    id: "mcp-1",
    server: "slack",
    tool: "search",
    status: "completed",
    arguments: { query: "incident", limit: 5 },
    result: {
      content: [{ type: "text", text: "Found 3 incidents" }],
      structuredContent: { total: 3 },
    },
    durationMs: 80,
  } satisfies CodexMcpToolCallItem,
};

const fileChangeEntry: CodexStreamEntry = {
  kind: "fileChange",
  revision: 0,
  item: {
    type: "fileChange",
    id: "fc-1",
    status: "completed",
    changes: [
      {
        path: "src/app.ts",
        kind: { type: "update", movePath: null },
        diff: ["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,2 +1,2 @@", "-old", "+new"].join("\n"),
      },
    ],
  } satisfies CodexFileChangeItem,
};

const reasoningEntry: CodexStreamEntry = {
  kind: "reasoning",
  revision: 0,
  item: {
    type: "reasoning",
    id: "think-1",
    summary: ["Considering the registry approach."],
  } satisfies CodexReasoningItem,
};

const fallbackEntry: CodexStreamEntry = {
  kind: "fallback",
  revision: 0,
  item: { type: "wizardSpell", id: "u-1", payload: { level: 3 } },
};

function renderView(entries: CodexStreamEntry[]) {
  return render(
    <I18nProvider>
      <CodexStreamView entries={entries} usage={null} approval={null} onApprovalResolved={() => {}} running={false} />
    </I18nProvider>,
  );
}

afterEach(() => {
  codexToolCardExpansion.clear();
  window.localStorage.clear();
});

// ── 注册表 ───────────────────────────────────────────────────────────────────

describe("codex renderer registry", () => {
  it("registers every known entry kind with its renderer", () => {
    for (const kind of [
      "userMessage",
      "agentMessage",
      "plan",
      "reasoning",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "fallback",
    ] as const) {
      expect(codexEntryRenderers[kind], `missing renderer for ${kind}`).toBeTruthy();
    }
  });

  it("dispatches known types to their renderer (command)", () => {
    renderView([commandEntry]);
    // 命令卡的骨架摘要行（可点击的 header button）
    expect(screen.getByRole("button", { name: /npm install/ })).toBeTruthy();
  });

  it("dispatches unknown types to the fallback debug card with type badge and expandable raw JSON", () => {
    renderView([fallbackEntry]);
    // type 徽标可见
    expect(screen.getByText("wizardSpell")).toBeTruthy();
    // 原始 JSON 默认收起
    expect(screen.queryByText(/wizardSpell.*level/)).toBeNull();
    // 展开后看到原始 JSON 内容
    fireEvent.click(screen.getByRole("button", { name: /wizardSpell/ }));
    expect(screen.getByText(/"level"/)).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
  });
});

// ── MCP 卡：参数与结果分离（user story 11）───────────────────────────────────

describe("codex mcp tool call card", () => {
  it("renders arguments and result as separate structured sections after expanding", () => {
    renderView([mcpEntry]);
    fireEvent.click(screen.getByRole("button", { name: /slack/ }));

    // 两块结构化区域：参数节 + 结果节
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    // 参数只含 arguments 的 JSON
    expect(screen.getByText(/"query"/)).toBeTruthy();
    // 结果节的文本内容
    expect(screen.getByText("Found 3 incidents")).toBeTruthy();
  });

  it("does not dump the whole item as a single JSON blob", () => {
    renderView([mcpEntry]);
    fireEvent.click(screen.getByRole("button", { name: /slack/ }));
    // 整包倾倒会把 status / id / durationMs 等元字段一并序列化——不该出现
    expect(screen.queryByText(/"durationMs"/)).toBeNull();
    expect(screen.queryByText(/"inProgress"/)).toBeNull();
  });
});

// ── 文件变更卡：默认收起（user story 3 的行为矩阵）──────────────────────────

describe("codex file change card", () => {
  it("is collapsed by default and reveals the diff on toggle", () => {
    renderView([fileChangeEntry]);
    // 摘要行可见（路径），diff 内容不可见
    expect(screen.getByRole("button", { name: /src\/app\.ts/ })).toBeTruthy();
    expect(screen.queryByText("new")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /src\/app\.ts/ }));
    // T4 起 diff 行有结构：行内容去掉 +/- 前缀、按 data-type 标类型
    expect(screen.getByText("new")).toBeTruthy();
    expect(screen.getByText("old")).toBeTruthy();
    expect(document.querySelector('.codex-stream-diff-row[data-type="add"]')).not.toBeNull();
    expect(document.querySelector('.codex-stream-diff-row[data-type="del"]')).not.toBeNull();
  });
});

// ── 思考卡：默认收起 + 展开持久（user story 5）──────────────────────────────

describe("codex reasoning card", () => {
  it("is collapsed by default and persists expansion across unmount/remount", () => {
    const first = renderView([reasoningEntry]);
    expect(screen.queryByText(/Considering the registry/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    expect(screen.getByText(/Considering the registry/)).toBeTruthy();

    first.unmount();
    renderView([reasoningEntry]);
    // 模块级 Map 持久：重挂载后仍展开
    expect(screen.getByText(/Considering the registry/)).toBeTruthy();
  });
});
