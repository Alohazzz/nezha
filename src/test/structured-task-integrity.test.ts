import { describe, expect, it } from "vitest";
import { isActiveTaskStatus, isStructuredTaskWithoutSession, type Task } from "../types";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    projectId: "p1",
    prompt: "do things",
    agent: "codex",
    permissionMode: "ask",
    status: "done",
    createdAt: 1,
    ...overrides,
  };
}

describe("isStructuredTaskWithoutSession", () => {
  it("flags structured codex task marked done without session artifacts", () => {
    const task = makeTask({ runMode: "structured", agent: "codex" });
    expect(isStructuredTaskWithoutSession(task)).toBe(true);
  });

  it("flags task with thread id but no session path", () => {
    const task = makeTask({ runMode: "structured", agent: "codex", codexSessionId: "th1" });
    expect(isStructuredTaskWithoutSession(task)).toBe(true);
  });

  it("does not flag structured task with full session artifacts", () => {
    const task = makeTask({
      runMode: "structured",
      agent: "codex",
      codexSessionId: "th1",
      codexSessionPath: "C:/sessions/th1.jsonl",
    });
    expect(isStructuredTaskWithoutSession(task)).toBe(false);
  });

  it("does not flag pty tasks", () => {
    const task = makeTask({ runMode: "pty", agent: "codex" });
    expect(isStructuredTaskWithoutSession(task)).toBe(false);
  });

  it("does not flag undefined runMode (legacy = pty semantics)", () => {
    const task = makeTask({ agent: "codex" });
    expect(isStructuredTaskWithoutSession(task)).toBe(false);
  });

  it("does not flag structured claude tasks", () => {
    const task = makeTask({ runMode: "structured", agent: "claude" });
    expect(isStructuredTaskWithoutSession(task)).toBe(false);
  });
});

describe("isActiveTaskStatus (guard against regressions)", () => {
  it("treats interrupted as non-active so startup normalization can fire", () => {
    expect(isActiveTaskStatus("interrupted")).toBe(false);
  });
});
