import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryPlan, Plan, Project, Task } from "../types";
import { PlanPanel } from "../components/delivery-plan/PlanPanel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

const baseBatch: DeliveryPlan = {
  id: "b1",
  projectId: "p1",
  name: "门诊挂号优化",
  kind: "feature",
  branch: "feature/门诊挂号优化",
  baseBranch: "develop",
  targetBranch: "develop",
  issues: [
    { workitemId: "w1", serialNumber: "QHDK-30439", subject: "ApiUrl 为空" },
  ],
  status: "active",
  createdAt: Date.now(),
  worktreePath: "H:/Project/.nezha/worktrees/b1",
  useWorktree: true,
};

const projects = [{ id: "p1", path: "H:/Project", name: "HIS" }] as Project[];
const tasks = [] as Task[];
const plans = [] as Plan[];

const renderView = (batch: DeliveryPlan) =>
  render(
    <PlanPanel
      projects={projects}
      tasks={tasks}
      plans={plans}
      deliveryPlans={[batch]}
      onDeliveryPlansChange={() => undefined}
      onGoYunxiao={() => undefined}
      onStartDirectExecution={() => undefined}
    />,
  );

describe("PlanPanel", () => {
  it("exposes open / submit / delete and hides the worktree path", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    renderView(baseBatch);

    expect(await screen.findByRole("button", { name: /打开/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /提交 MR/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /删除计划/ })).toBeInTheDocument();
    expect(screen.queryByText(/worktree: /)).not.toBeInTheDocument();
    expect(screen.queryByText(/复制路径/)).not.toBeInTheDocument();
  });

  it("shows derived issue status without blocking actions when the run program is missing", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    renderView({ ...baseBatch, runRootMissing: true });

    expect(await screen.findByText("运行程序缺失")).toBeInTheDocument();
    // 议题表派生状态：无任务无方案＝未开始。
    expect(screen.getByText("未开始")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /提交 MR/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /删除计划/ })).toBeEnabled();
  });

  it("keeps a missing worktree available for cleanup without opening it", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    renderView({ ...baseBatch, worktreeMissing: true });

    expect(await screen.findByText("WorkTree 缺失")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /打开/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /提交 MR/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /删除计划/ })).toBeEnabled();
  });
});

describe("SubmitMrDialog", () => {
  it("prefills reviewers from the target branch rule and submits them as names", async () => {
    const inv = vi.mocked(invoke);
    inv.mockImplementation((command: string) => {
      if (command === "codeup_branch_managers") return Promise.resolve(["苏一", "付茂玲"]);
      if (command === "codeup_list_members") {
        return Promise.resolve([
          { name: "苏一", userId: "641a5524b8f7e038cbee4317" },
          { name: "付茂玲", userId: "642bbc4b3cecdaec3aff0c12" },
        ]);
      }
      if (command === "codeup_create_mr") return Promise.resolve({});
      return Promise.resolve(null);
    });

    const { container } = renderView(baseBatch);
    fireEvent.click(await screen.findByRole("button", { name: /提交 MR/ }));

    await waitFor(() => {
      expect(screen.getByLabelText("移除评审人 苏一")).toBeInTheDocument();
      expect(screen.getByLabelText("移除评审人 付茂玲")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /提交到 Codeup/ }));

    // 审核人以人名发出（后端解析成云效 userID），且带上计划所属仓库。
    await waitFor(() => {
      expect(inv).toHaveBeenCalledWith("codeup_create_mr", {
        projectPath: "H:/Project",
        repoPath: null,
        projectId: "p1",
        planId: "b1",
        reviewers: ["苏一", "付茂玲"],
      });
    });
    expect(container.querySelector(".pm-submit-error")).toBeNull();
  });

  it("lets the user add a reviewer from the member picker", async () => {
    const inv = vi.mocked(invoke);
    inv.mockImplementation((command: string) => {
      if (command === "codeup_branch_managers") return Promise.resolve([]);
      if (command === "codeup_list_members") {
        return Promise.resolve([{ name: "陈学清", userId: "6423f3653cecdaec3a1bf8da" }]);
      }
      if (command === "codeup_create_mr") return Promise.resolve({});
      return Promise.resolve(null);
    });

    renderView(baseBatch);
    fireEvent.click(await screen.findByRole("button", { name: /提交 MR/ }));

    const input = await screen.findByPlaceholderText(/输入姓名搜索/);
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("button", { name: /陈学清/ }));
    await waitFor(() => expect(screen.getByLabelText("移除评审人 陈学清")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /提交到 Codeup/ }));
    await waitFor(() => {
      expect(inv).toHaveBeenCalledWith(
        "codeup_create_mr",
        expect.objectContaining({ reviewers: ["陈学清"] }),
      );
    });
  });

  it("shows the backend error when the MR cannot be created", async () => {
    const inv = vi.mocked(invoke);
    inv.mockImplementation((command: string) => {
      if (command === "codeup_branch_managers") return Promise.resolve([]);
      if (command === "codeup_list_members") return Promise.resolve([]);
      if (command === "codeup_create_mr") {
        return Promise.reject(
          new Error(
            "云效组织成员里找不到审核人「张三」，请检查姓名或改填云效用户 ID",
          ),
        );
      }
      return Promise.resolve(null);
    });

    renderView(baseBatch);
    fireEvent.click(await screen.findByRole("button", { name: /提交 MR/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交到 Codeup/ }));

    // 发起失败必须留在弹层里明示原因（此前只显示裸的 "Not Found"）。
    expect(await screen.findByText(/找不到审核人「张三」/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /提交到 Codeup/ })).toBeInTheDocument();
  });
});
