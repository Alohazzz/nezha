import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanPanel } from "../components/delivery-plan/PlanPanel";
import { I18nProvider } from "../i18n";
import type { Project } from "../types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  open: vi.fn().mockResolvedValue(null),
}));

const project: Project = {
  id: "p1",
  name: "demo",
  path: "H:/workspace/demo",
  lastOpenedAt: 1,
};

const settingsWithYunxiao = {
  yunxiao: {
    token: "pt-test",
    organizationId: "org-1",
    projectId: "proj-1",
  },
};

function renderPanel() {
  return render(
    <I18nProvider>
      <PlanPanel
        projects={[project]}
        tasks={[]}
        plans={[]}
        deliveryPlans={[]}
        onDeliveryPlansChange={() => undefined}
        onGoYunxiao={() => undefined}
        onStartDirectExecution={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("创建计划弹窗内的 Radix 下拉", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "load_app_settings":
          return Promise.resolve(settingsWithYunxiao);
        case "yunxiao_list_versions":
          return Promise.resolve([
            { id: "v-1", name: "v2.20260901.0" },
            { id: "v-2", name: "v2.20260501.0" },
          ]);
        case "list_branch_pr_repos":
          return Promise.resolve([]);
        case "list_delivery_plans":
          return Promise.resolve([]);
        case "git_list_branches":
          return Promise.resolve([]);
        case "get_delivery_plan_worktree_base":
          return Promise.resolve("H:/workspace/worktrees");
        case "preview_delivery_plan_branch":
          return Promise.resolve("feature/v2.20260901/develop/锁号");
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("点下拉项不会把弹窗关掉", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /创建计划/ }));
    // 「计划名称」字段出现＝弹窗已开（按钮与标题同名，避免 findByText 撞名）。
    expect(await screen.findByText("计划名称")).toBeInTheDocument();

    // 展开版本下拉（内容 portal 到 body），选一项。
    const picker = await screen.findByRole("button", { name: /选择/ });
    await waitFor(() => expect(picker).toBeEnabled());
    await user.click(picker);
    await user.click(await screen.findByText("v2.20260901"));

    // 回归点：点击 portal 出来的下拉项曾被判成「面板外点击」，连带卸载弹窗。
    await waitFor(() => {
      expect(screen.getByText("计划名称")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /取消/ })).toBeInTheDocument();
    });
  });

  it("目标分支段由 targetBranch 决定（留空则不带出），且没有「是否带目标分支段」的开关", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /创建计划/ }));
    await screen.findByText("计划名称");

    // 预览命令不再接收 includeTarget：目标分支段由 targetBranch 决定。
    // 目标分支默认留空（允许暂不指定合并目标），此时 preview 收到 null。
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "preview_delivery_plan_branch");
      const args = call?.[1] as Record<string, unknown> | undefined;
      expect(args?.targetBranch).toBeNull();
      expect(args).not.toHaveProperty("includeTarget");
    });

    // 手填目标分支后，preview 参数跟着带出目标段。
    const target = screen.getByPlaceholderText(/留空则暂不指定合并目标/);
    await user.type(target, "develop");
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(
        ([cmd]) => cmd === "preview_delivery_plan_branch",
      );
      const args = calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
      expect(args?.targetBranch).toBe("develop");
    });

    // 源分支输入框展示带目标段的完整名字，且可压缩（flex:1 + min-width:0），
    // 否则长分支名会被同行按钮挤出对话框、显示不全。
    const source = await screen.findByDisplayValue("feature/v2.20260901/develop/锁号");
    expect(source).toHaveStyle({ flex: "1", minWidth: "0" });

    expect(screen.queryByText("分支名带目标分支段")).not.toBeInTheDocument();
  });
});
