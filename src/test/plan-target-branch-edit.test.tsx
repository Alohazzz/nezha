import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryPlan, Plan, Project, Task } from "../types";
import { PlanPanel } from "../components/delivery-plan/PlanPanel";
import { TargetBranchEditor } from "../components/delivery-plan/TargetBranchEditor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  open: vi.fn().mockResolvedValue(null),
}));

// Radix Select 在 jsdom 里需要 pointer-capture 等一堆 polyfill；这里替换成原生 select，
// 测的是编辑器的提交逻辑与按钮状态联动（presenter 本身由 SelectField 自己的测试覆盖）。
vi.mock("../components/yunxiao/SelectField", () => ({
  SelectField: ({
    value,
    onChange,
    options,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string }>;
    placeholder: string;
  }) => (
    <select
      aria-label={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const planWithNoTarget: DeliveryPlan = {
  id: "b1",
  projectId: "p1",
  name: "处方打印问题修复",
  kind: "fix",
  branch: "fix/v2.20260901/QHDK-30486-处方打印医保类别勾选报错",
  baseBranch: "master",
  targetBranch: "",
  issues: [],
  status: "active",
  createdAt: Date.now(),
  worktreePath: "H:/Project/.nezha/worktrees/b1",
  useWorktree: true,
};

const projects = [{ id: "p1", path: "H:/Project", name: "HIS" }] as Project[];

function renderPanel(plan: DeliveryPlan, onChange = () => undefined) {
  return render(
    <PlanPanel
      projects={projects}
      tasks={[] as Task[]}
      plans={[] as Plan[]}
      deliveryPlans={[plan]}
      onDeliveryPlansChange={onChange}
      onGoYunxiao={() => undefined}
      onStartDirectExecution={() => undefined}
      onCreatePlan={() => ({
        id: "draft",
        projectId: "p1",
        name: "",
        issues: [],
        status: "draft",
        createdAt: 0,
      })}
      onStartPlanDiscussion={() => undefined}
      onCancelPlan={() => undefined}
      onSetParentPlan={() => undefined}
    />,
  );
}

describe("未指定合并目标时的「提交 MR」出路", () => {
  it("按钮禁用时给出可操作的悬停原因，而不是静默无反应", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    renderPanel(planWithNoTarget);

    const btn = await screen.findByRole("button", { name: /提交 MR/ });
    expect(btn).toBeDisabled();
    // title 挂在包裹层（disabled 的 button 不派发 hover）。
    const wrap = btn.parentElement!;
    expect(wrap.getAttribute("title")).toMatch(/未指定合并回目标分支/);
    expect(wrap.getAttribute("title")).toMatch(/分支行补记/);
  });

  it("分支行提供补记入口：改目标分支后按钮解禁", async () => {
    const updated: DeliveryPlan = { ...planWithNoTarget, targetBranch: "master" };
    const inv = vi.mocked(invoke);
    inv.mockImplementation((command: string) => {
      if (command === "git_list_branches") {
        return Promise.resolve([
          { name: "master", current: true, remote: null },
          { name: "develop", current: false, remote: null },
          { name: "remotes/origin/master", current: false, remote: "origin" },
        ]);
      }
      if (command === "update_delivery_plan_target") return Promise.resolve(updated);
      return Promise.resolve([]);
    });

    const onChange = vi.fn();
    const { rerender } = renderPanel(planWithNoTarget, onChange);

    // 空目标时分支行是可点的占位（不再是纯灰字）。
    const placeholder = await screen.findByRole("button", { name: /未指定合并目标/ });
    fireEvent.click(placeholder);

    const select = await screen.findByLabelText("选择目标分支");
    // 候选 = 本地 ∪ 远端去重，且排除源分支自身。
    await waitFor(() => {
      const values = [...select.querySelectorAll("option")].map((o) => o.getAttribute("value"));
      expect(values).toContain("master");
      expect(values).toContain("develop");
      expect(values).not.toContain("fix/v2.20260901/QHDK-30486-处方打印医保类别勾选报错");
    });

    fireEvent.change(select, { target: { value: "master" } });

    await waitFor(() => {
      expect(inv).toHaveBeenCalledWith("update_delivery_plan_target", {
        projectId: "p1",
        projectPath: "H:/Project",
        repoPath: null,
        planId: "b1",
        targetBranch: "master",
      });
    });

    // 后端返回的记录替换本地项后，按钮解禁。
    rerender(
      <PlanPanel
        projects={projects}
        tasks={[] as Task[]}
        plans={[] as Plan[]}
        deliveryPlans={[updated]}
        onDeliveryPlansChange={onChange}
        onGoYunxiao={() => undefined}
        onStartDirectExecution={() => undefined}
        onCreatePlan={() => ({
          id: "draft",
          projectId: "p1",
          name: "",
          issues: [],
          status: "draft",
          createdAt: 0,
        })}
        onStartPlanDiscussion={() => undefined}
        onCancelPlan={() => undefined}
        onSetParentPlan={() => undefined}
      />,
    );
    expect(await screen.findByRole("button", { name: /提交 MR/ })).toBeEnabled();
  });

  it("已提交/已合并的计划不再提供目标分支编辑（避免 MR 目标与记录不一致）", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const review: DeliveryPlan = { ...planWithNoTarget, targetBranch: "master", status: "review" };
    renderPanel(review);

    expect(await screen.findByRole("button", { name: /提交 MR/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /未指定合并目标/ })).toBeNull();
    // 静态展示目标分支，无编辑按钮。
    expect(screen.getByText("master")).toBeInTheDocument();
    expect(screen.queryByTitle("点击补记 / 修改合并回目标分支")).toBeNull();
  });
});

describe("TargetBranchEditor", () => {
  it("把补记失败的原因留在行内显示", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "git_list_branches") {
        return Promise.resolve([{ name: "master", current: false, remote: null }]);
      }
      if (command === "update_delivery_plan_target") {
        return Promise.reject(new Error("目标分支「master」在本地与远端都不存在，请检查分支名"));
      }
      return Promise.resolve([]);
    });

    render(
      <TargetBranchEditor
        plan={planWithNoTarget}
        projectPath="H:/Project"
        onUpdated={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /未指定合并目标/ }));
    fireEvent.change(await screen.findByLabelText("选择目标分支"), {
      target: { value: "master" },
    });

    expect(await screen.findByText(/在本地与远端都不存在/)).toBeInTheDocument();
  });
});
