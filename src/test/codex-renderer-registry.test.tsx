import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexStreamView } from "../components/codex-stream/CodexStreamView";
import { codexEntryRenderers } from "../components/codex-stream/codexRenderers";
import { codexToolCardExpansion } from "../components/codex-stream/CodexToolCard";
import type { CodexStreamEntry } from "../hooks/codexStreamMerge";
import type {
  CodexCollabAgentToolCallItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexMcpToolCallItem,
  CodexReasoningItem,
  CodexSubAgentActivityItem,
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
  // #119：endedAtMs 有值 = 完成态（reasoning 无 status 字段，完成以终点时间判定）；
  // 缺省会变 running 态触发自动展开，完成态才符合「默认收起」的历史语义。
  startedAtMs: 1000,
  endedAtMs: 4200,
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

const collabEntry: CodexStreamEntry = {
  kind: "collabAgentToolCall",
  revision: 0,
  startedAtMs: 1000,
  endedAtMs: 31_000,
  item: {
    type: "collabAgentToolCall",
    id: "call_wait_1",
    tool: "wait",
    status: "completed",
    senderThreadId: "root-thread",
    receiverThreadIds: ["child-thread-aaaa1111"],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: { "child-thread-aaaa1111": { status: "completed", message: "review done" } },
  } satisfies CodexCollabAgentToolCallItem,
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
      "collabAgentToolCall",
      "subAgentActivity",
      "imageView",
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

  it("gives id-less fallback entries independent expansion keys via positional index", () => {
    // 回归（review P2）：多个无 id 同类条目之前共用 unknown-<type> 键——展开一个
    // 两个全开。现在展开键并入视图位置序号，各自独立。
    const idless: CodexStreamEntry = {
      kind: "fallback",
      revision: 0,
      item: { type: "wizardSpell", payload: { level: 7 } } as typeof fallbackEntry.item,
    };
    renderView([fallbackEntry, idless]);

    const headers = screen.getAllByRole("button", { name: /wizardSpell/ });
    expect(headers).toHaveLength(2);
    // 展开第一个：只有第一个卡体的 JSON 可见（默认都收起）
    fireEvent.click(headers[0]);
    expect(screen.getByText(/"level"/)).toBeTruthy();
    // 第二张卡仍收起：它的 payload 键 "level: 7" 不出现（两张卡都含 "level" 字样，
    // 靠展开按钮 data-expanded 状态区分更稳）
    const expandedFlags = screen
      .getAllByRole("button", { name: /wizardSpell/ })
      .map((b) => b.getAttribute("data-expanded"));
    expect(expandedFlags).toEqual(["true", null]);
  });
});

// ── 协作卡：上游 collabAgentToolCall 不再落 fallback 原始 JSON ─────────────────

describe("codex collab agent tool call card", () => {
  it("renders the collab card instead of the unknown-type fallback", () => {
    renderView([collabEntry]);
    // 动作词进摘要行（本地化文案），不是一坨原始 JSON
    expect(screen.getByRole("button", { name: /Waiting for sub-agents/ })).toBeTruthy();
    // 兜底卡的「未知类型」提示不出现
    expect(screen.queryByText(/Unknown entry type/)).toBeNull();
    // 原始字段名不会以 JSON 形态裸露在摘要行
    expect(screen.queryByText(/"receiverThreadIds"/)).toBeNull();
  });

  it("reveals the sub-agent state rows on expand", () => {
    renderView([collabEntry]);
    fireEvent.click(screen.getByRole("button", { name: /Waiting for sub-agents/ }));
    expect(screen.getByText("Sub-agents")).toBeTruthy();
    // 短 id（末 8 位）+ 状态词 + 消息
    expect(screen.getByText("aaaa1111")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("review done")).toBeTruthy();
  });

  it("does not render the failure tooltip for a completed wait", () => {
    renderView([collabEntry]);
    // wait 超时/正常结束都是 completed 语义，不该被画成失败
    const card = document.querySelector('.codex-stream-tool-card[data-status="failed"]');
    expect(card).toBeNull();
  });

  it("marks a failed collab call as failed and exposes the agent error message", () => {
    const failedEntry: CodexStreamEntry = {
      kind: "collabAgentToolCall",
      revision: 0,
      item: {
        type: "collabAgentToolCall",
        id: "call_spawn_fail",
        tool: "spawnAgent",
        status: "failed",
        agentsStates: { "child-2222": { status: "errored", message: "model unavailable" } },
      } satisfies CodexCollabAgentToolCallItem,
    };
    renderView([failedEntry]);
    expect(document.querySelector('.codex-stream-tool-card[data-status="failed"]')).not.toBeNull();
  });
});

// ── 子智能体生命周期卡：状态必须一眼可辨 ──────────────────────────────────────

describe("codex sub-agent activity card", () => {
  const subAgentEntry = (kind: string, endedAtMs: number | null = 4200): CodexStreamEntry => ({
    kind: "subAgentActivity",
    revision: 0,
    startedAtMs: 1000,
    endedAtMs,
    item: {
      type: "subAgentActivity",
      id: `evt_${kind}`,
      kind,
      agentThreadId: "child-thread-aaaa1111",
      agentPath: "/root/worker",
      model: "glm-4",
      reasoningEffort: "high",
    } satisfies CodexSubAgentActivityItem,
  });

  it("uses the agent path as the summary text instead of dumping raw JSON", () => {
    renderView([subAgentEntry("started")]);
    expect(screen.getByRole("button", { name: /\/root\/worker/ })).toBeTruthy();
    expect(screen.queryByText(/Unknown entry type/)).toBeNull();
    expect(screen.queryByText(/"agentThreadId"/)).toBeNull();
  });

  it("maps activity kinds to distinct, readable status words", () => {
    // 这三种状态必须互不相同——「不知道结束没结束」的直接原因就是它们此前
    // 全部落进同一张无状态 JSON 卡。
    // started 需要 running=true 才是「运行中」；轮次结束时无终态会收口（另一用例覆盖）。
    const active = render(
      <I18nProvider>
        <CodexStreamView
          entries={[subAgentEntry("started", null)]}
          usage={null}
          approval={null}
          onApprovalResolved={() => {}}
          running
        />
      </I18nProvider>,
    );
    expect(screen.getByText("Running")).toBeTruthy();
    active.unmount();

    const done = renderView([subAgentEntry("completed")]);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(document.querySelector('.codex-stream-tool-card[data-status="ok"]')).not.toBeNull();
    done.unmount();

    renderView([subAgentEntry("interrupted")]);
    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(document.querySelector('.codex-stream-tool-card[data-status="failed"]')).not.toBeNull();
  });

  it("treats an unknown activity kind as still running rather than finished", () => {
    // 上游新增枚举值时宁可多显示一秒「运行中」，也不能把还在跑的智能体画成已完成。
    render(
      <I18nProvider>
        <CodexStreamView
          entries={[subAgentEntry("someFutureKind", null)]}
          usage={null}
          approval={null}
          onApprovalResolved={() => {}}
          running
        />
      </I18nProvider>,
    );
    expect(document.querySelector('.codex-stream-tool-card[data-status="running"]')).not.toBeNull();
  });

  it("stops claiming 'running' once the turn ends without a terminal event", () => {
    // 子智能体没发 completed 父轮就结束（取消 / 进程退出 / 事件丢失）时，
    // 卡片必须收口——否则界面永远转圈，任务其实早已结束。
    renderView([subAgentEntry("started", null)]); // renderView 传 running={false}
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getByText("Ended (no result)")).toBeTruthy();
    expect(document.querySelector('.codex-stream-tool-card[data-status="running"]')).toBeNull();
  });

  it("keeps showing 'running' while the turn is still active", () => {
    render(
      <I18nProvider>
        <CodexStreamView
          entries={[subAgentEntry("started", null)]}
          usage={null}
          approval={null}
          onApprovalResolved={() => {}}
          running
        />
      </I18nProvider>,
    );
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("reveals identity details on expand", () => {
    renderView([subAgentEntry("completed")]);
    fireEvent.click(screen.getByRole("button", { name: /\/root\/worker/ }));
    expect(screen.getByText("child-thread-aaaa1111")).toBeTruthy();
    expect(screen.getByText("glm-4 · high")).toBeTruthy();
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
    // #119：摘要行现在展示摘要首行片段，展开与否以展开区 body（完整 join）为准
    const first = renderView([reasoningEntry]);
    expect(screen.queryByTestId("codex-reasoning-body")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Considering the registry/ }));
    expect(screen.getByTestId("codex-reasoning-body")).toBeTruthy();

    first.unmount();
    renderView([reasoningEntry]);
    // 模块级 Map 持久：重挂载后仍展开
    expect(screen.getByTestId("codex-reasoning-body")).toBeTruthy();
  });

  it("shows the frozen duration on completed entries (time props reach the card)", () => {
    // #119：归并层条目时间字段经注册表下传 → 摘要行渲染定格时长 4200-1000=3.2s
    renderView([reasoningEntry]);
    expect(screen.getByText("3.2s")).toBeTruthy();
    // 完成态不渲染状态词（密集度改版：类别词「思考」+ 时长已足够）
    expect(screen.queryByText("Thought")).toBeNull();
  });

  it("keeps running entries collapsed and streams the latest thought in the summary row", () => {
    // 结构化改版：思考正文不再自动展开（自动展开会把工具与正文持续挤下去），
    // 摘要行改为跟播最新一段思考；动态秒数仍走本地时钟兜底。
    const runningEntry: CodexStreamEntry = {
      kind: "reasoning",
      revision: 1,
      startedAtMs: Date.now() - 2000,
      endedAtMs: null,
      item: {
        type: "reasoning",
        id: "think-running",
        summary: ["Streaming thought."],
      } satisfies CodexReasoningItem,
    };
    renderView([runningEntry]);
    // 状态词不再渲染（类别词已高亮）
    expect(document.querySelector(".codex-stream-tool-status")).toBeNull();
    // 保持收起：完整正文（展开区 body）不可见
    expect(screen.queryByTestId("codex-reasoning-body")).toBeNull();
    // 摘要行承载思考实况
    const summary = screen.getByTestId("codex-reasoning-summary");
    expect(summary.textContent).toBe("Streaming thought.");
    expect(summary.getAttribute("data-live")).toBe("true");
    // 动态秒数已渲染（2s 起跳，容错时钟推进显示 2.x s 量级）
    expect(screen.getByText(/^[0-9]+(\.[0-9]+)?s$/)).toBeTruthy();
  });
});

// ── 失败 / 中断横幅：必须常驻可见，不能被长流滚出视野 ───────────────────────

describe("codex stream status banner", () => {
  it("renders the failure reason above the scroll area, not inside the entry stream", () => {
    // 回归：失败横幅早先是流首行，几百条条目之后早被滚走，任务看起来像正常结束。
    const { container } = render(
      <I18nProvider>
        <CodexStreamView
          entries={[commandEntry]}
          usage={null}
          approval={null}
          onApprovalResolved={() => {}}
          running={false}
          statusText="quota exhausted: no credits remaining"
          statusTone="error"
        />
      </I18nProvider>,
    );

    const banner = container.querySelector(".codex-stream-banner");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("data-tone")).toBe("error");
    expect(banner?.textContent).toContain("quota exhausted");

    // 横幅必须是滚动区的兄弟节点（不随条目滚动）
    const scrollArea = banner?.parentElement?.querySelector(".codex-stream-root") ??
      container.querySelector('[style*="overflow-y"]');
    expect(scrollArea).not.toBeNull();
    expect(scrollArea?.contains(banner as Node)).toBe(false);
  });

  it("uses the warning tone for interrupted / cancelled turns", () => {
    const { container } = render(
      <I18nProvider>
        <CodexStreamView
          entries={[]}
          usage={null}
          approval={null}
          onApprovalResolved={() => {}}
          running={false}
          statusText="Turn stopped"
          statusTone="warning"
        />
      </I18nProvider>,
    );
    expect(container.querySelector(".codex-stream-banner")?.getAttribute("data-tone")).toBe("warning");
  });

  it("renders no banner when the task has no terminal status text", () => {
    const { container } = renderView([commandEntry]);
    expect(container.querySelector(".codex-stream-banner")).toBeNull();
  });
});
