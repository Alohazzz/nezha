import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import type { BranchBatch } from "../types";
import { BranchBatchView } from "../components/branch-batch/BranchBatchView";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

const baseBatch: BranchBatch = {
  id: "b1",
  projectId: "p1",
  name: "门诊挂号优化",
  kind: "feature",
  branch: "feature/门诊挂号优化",
  baseBranch: "develop",
  targetBranch: "develop",
  taskIds: [],
  status: "active",
  createdAt: Date.now(),
  worktreePath: "H:/Project/.nezha/worktrees/b1",
  prepareStatus: "ready",
};

const renderView = (batch: BranchBatch) =>
  render(
    <BranchBatchView
      projectPath="H:/Project"
      projectId="p1"
      repoPath="H:/Project"
      shellOpen={false}
      tasks={[]}
      worktreeScope={batch.worktreePath ?? ""}
      onScopeChange={() => undefined}
      onClose={() => undefined}
    />,
  );

describe("BranchBatchView", () => {
  it("only exposes open / submit / delete and hides the worktree path", async () => {
    vi.mocked(invoke).mockResolvedValue([baseBatch]);
    renderView(baseBatch);

    expect(await screen.findByRole("button", { name: /打开/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /提交 MR/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /删除 WorkTree/ })).toBeInTheDocument();
    expect(screen.queryByText(/查看 Diff/)).not.toBeInTheDocument();
    expect(screen.queryByText(/复制路径/)).not.toBeInTheDocument();
    expect(screen.queryByText(/审查/)).not.toBeInTheDocument();
    expect(screen.queryByText(/worktree: /)).not.toBeInTheDocument();
  });

  it("disables submission while the run root is preparing", async () => {
    vi.mocked(invoke).mockResolvedValue([{ ...baseBatch, prepareStatus: "preparing" }]);
    renderView({ ...baseBatch, prepareStatus: "preparing" });

    expect(await screen.findByRole("button", { name: /提交 MR/ })).toBeDisabled();
    expect(screen.getByText("准备运行根中")).toBeInTheDocument();
  });
});
