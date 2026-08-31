import { describe, expect, it } from "vitest";
import type { BranchBatch, Task } from "../types";
import { buildWorktreeScopeOptions } from "../components/branch-batch/worktreeScope";

const task = {
  id: "task-1",
  projectId: "project-1",
  prompt: "",
  agent: "claude",
  permissionMode: "ask",
  status: "done",
  createdAt: 1,
} as Task;

const batch = {
  id: "batch-1",
  projectId: "project-1",
  name: "PR",
  kind: "feature",
  branch: "feature/pr",
  baseBranch: "develop",
  targetBranch: "develop",
  taskIds: [],
  status: "active",
  createdAt: 1,
} as BranchBatch;

describe("buildWorktreeScopeOptions", () => {
  it("keeps live task and batch worktrees", () => {
    const options = buildWorktreeScopeOptions({
      tasks: [{ ...task, worktreePath: "H:/wt/task", worktreeBranch: "feature/task" }],
      batches: [{ ...batch, worktreePath: "H:/wt/batch" }],
      projectPath: "H:/project",
    });

    expect(options).toEqual([
      { key: "", label: "主检出" },
      {
        key: "H:/wt/task",
        label: "WorkTree · feature/task",
        description: "H:/wt/task",
      },
      {
        key: "H:/wt/batch",
        label: "WorkTree · feature/pr",
        description: "H:/wt/batch",
      },
    ]);
  });

  it("hides missing, merged, closed, and discarded worktrees", () => {
    const options = buildWorktreeScopeOptions({
      tasks: [{ ...task, worktreePath: "H:/wt/task", worktreeDiscarded: true }],
      batches: [
        { ...batch, id: "missing", worktreePath: "H:/wt/missing", worktreeMissing: true },
        { ...batch, id: "merged", status: "merged" },
        { ...batch, id: "closed", status: "closed" },
      ],
      projectPath: "H:/project",
    });

    expect(options).toEqual([{ key: "", label: "主检出" }]);
  });

  it("falls back to the legacy project-local batch path", () => {
    const options = buildWorktreeScopeOptions({
      tasks: [],
      batches: [batch],
      projectPath: "H:/project",
    });

    expect(options[1]?.key).toBe("H:/project/.nezha/worktrees/batch-1");
    expect(options[1]?.description).toBe("H:/project/.nezha/worktrees/batch-1");
  });
});
