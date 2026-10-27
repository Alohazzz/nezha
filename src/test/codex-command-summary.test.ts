import { describe, expect, it } from "vitest";
import { groupCommandEntries, summarizeCommand } from "../components/codex-stream/codexCommandSummary";
import type { CodexStreamEntry } from "../hooks/codexStreamMerge";
import type { CodexCommandExecutionItem } from "../types";

// ── 命令摘要 + 聚合分组（密集度改版）────────────────────────────────────────
// summarizeCommand：剥掉 bash -lc / pwsh -Command 包裹，摘要行只显示真实命令。
// groupCommandEntries：连续 ≥2 条命令合成一组；单条不套壳；非命令条目是边界。

function makeCommandEntry(id: string, overrides: Partial<CodexCommandExecutionItem> = {}): CodexStreamEntry {
  return {
    kind: "commandExecution",
    revision: 0,
    item: {
      type: "commandExecution",
      id,
      command: `echo ${id}`,
      cwd: "/repo",
      status: "completed",
      aggregatedOutput: null,
      exitCode: 0,
      durationMs: 10,
      ...overrides,
    },
  };
}

function makeTextEntry(id: string): CodexStreamEntry {
  return {
    kind: "agentMessage",
    revision: 0,
    item: { type: "agentMessage", id, text: "hello" },
  };
}

describe("summarizeCommand", () => {
  it("strips a bash -lc wrapper and its surrounding quotes", () => {
    expect(
      summarizeCommand(`D:\\Program Files\\Git\\usr\\bin\\bash.exe -lc "Get-Content -Raw 'C:\\x\\SKILL.md'"`),
    ).toBe(`Get-Content -Raw 'C:\\x\\SKILL.md'`);
  });

  it("strips a pwsh -Command wrapper", () => {
    expect(summarizeCommand(`"C:\\pwsh.exe" -NoProfile -Command "git status --short"`)).toBe(
      "git status --short",
    );
  });

  it("unescapes escaped double quotes inside a double-quoted wrapper", () => {
    expect(summarizeCommand(`bash -lc "rg -n \\"foo\\" src"`)).toBe(`rg -n "foo" src`);
  });

  it("handles sh -c and zsh -lc", () => {
    expect(summarizeCommand(`sh -c 'ls -la'`)).toBe("ls -la");
    expect(summarizeCommand(`/bin/zsh -lc "pnpm test"`)).toBe("pnpm test");
  });

  it("returns the command unchanged when there is no wrapper", () => {
    expect(summarizeCommand("npm run build")).toBe("npm run build");
    expect(summarizeCommand("  git status  ")).toBe("git status");
  });

  it("keeps commands that merely mention a shell name", () => {
    expect(summarizeCommand("which bash")).toBe("which bash");
    expect(summarizeCommand("bash --version")).toBe("bash --version");
  });

  it("returns an empty string for empty input", () => {
    expect(summarizeCommand(null)).toBe("");
    expect(summarizeCommand("   ")).toBe("");
  });
});

describe("groupCommandEntries", () => {
  it("collapses a run of adjacent commands into one group", () => {
    const items = groupCommandEntries([
      makeCommandEntry("c1"),
      makeCommandEntry("c2"),
      makeCommandEntry("c3"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("commandGroup");
    if (items[0]?.kind !== "commandGroup") throw new Error("expected group");
    expect(items[0].commands).toHaveLength(3);
    expect(items[0].groupKey).toBe("execute:c1");
  });

  it("leaves a single command ungrouped", () => {
    const items = groupCommandEntries([makeCommandEntry("c1")]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("entry");
  });

  it("breaks the group on any non-command entry", () => {
    const items = groupCommandEntries([
      makeCommandEntry("c1"),
      makeCommandEntry("c2"),
      makeTextEntry("m1"),
      makeCommandEntry("c3"),
      makeCommandEntry("c4"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["commandGroup", "entry", "commandGroup"]);
  });

  it("keeps original entry indexes on the children", () => {
    const items = groupCommandEntries([
      makeTextEntry("m1"),
      makeCommandEntry("c1"),
      makeCommandEntry("c2"),
    ]);
    const group = items[1];
    if (group?.kind !== "commandGroup") throw new Error("expected group");
    expect(group.commands.map((child) => child.entryIndex)).toEqual([1, 2]);
  });

  it("anchors group identity to the first command so streaming appends keep state", () => {
    const before = groupCommandEntries([makeCommandEntry("c1"), makeCommandEntry("c2")]);
    const after = groupCommandEntries([
      makeCommandEntry("c1"),
      makeCommandEntry("c2"),
      makeCommandEntry("c3"),
    ]);
    const keyOf = (items: ReturnType<typeof groupCommandEntries>) =>
      items[0]?.kind === "commandGroup" ? items[0].groupKey : null;
    expect(keyOf(before)).toBe("execute:c1");
    expect(keyOf(after)).toBe(keyOf(before));
  });

  it("returns no items for an empty stream", () => {
    expect(groupCommandEntries([])).toEqual([]);
  });
});
