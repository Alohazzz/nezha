import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPlan, YunxiaoWorkitem } from "../types";
import { AddToPlanDialog } from "../components/delivery-plan/AddToPlanDialog";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const SETTINGS = { token: "pt-test", organizationId: "org-1", projectId: "proj-1" };

function workitem(n: number): YunxiaoWorkitem {
  return {
    id: `w-${n}`,
    serialNumber: `QHDK-${n}`,
    subject: `议题 ${n}`,
    customFieldValues: [],
  };
}

const plan: DeliveryPlan = {
  id: "b1",
  projectId: "p1",
  name: "处方打印问题修复",
  kind: "fix",
  branch: "fix/处方打印问题修复",
  baseBranch: "master",
  targetBranch: "",
  issues: [],
  status: "active",
  createdAt: 1,
  planEndDate: new Date(2026, 9, 15).getTime(),
};

function renderDialog(overrides: { settings?: Partial<typeof SETTINGS>; plan?: DeliveryPlan } = {}) {
  return render(
    <AddToPlanDialog
      issues={[workitem(1), workitem(2)]}
      projectId="p1"
      deliveryPlans={[overrides.plan ?? plan]}
      settings={overrides.settings ? { ...SETTINGS, ...overrides.settings } : SETTINGS}
      onAdded={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe("AddToPlanDialog 云效回写（issue #105）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(plan);
  });

  it("提交时把云效连接与成员列表一并交给后端（不再回写完成时间）", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "加入" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith(
      "add_delivery_plan_issues",
      expect.objectContaining({
        token: "pt-test",
        organizationId: "org-1",
      }),
    );
    const args = invokeMock.mock.calls[0][1] as Record<string, unknown>;
    expect("planEndDate" in args).toBe(false);
  });

  it("未连接云效时不发起请求，直接提示配置令牌", async () => {
    const user = userEvent.setup();
    renderDialog({ settings: { token: "", organizationId: "" } });
    await user.click(screen.getByRole("button", { name: "加入" }));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/未连接云效/)).toBeTruthy();
  });

  it("计划缺少完成时间（旧数据）时不再阻断，可正常添加", async () => {
    const user = userEvent.setup();
    renderDialog({ plan: { ...plan, planEndDate: undefined } });

    await user.click(screen.getByRole("button", { name: "加入" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith(
      "add_delivery_plan_issues",
      expect.objectContaining({ planId: plan.id }),
    );
  });

  it("后端回写失败（如已是待开发）时在弹窗内展示完整错误", async () => {
    invokeMock.mockRejectedValue("议题 QHDK-1、QHDK-2 已是「待开发」状态，不能重复加入计划");
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "加入" }));

    expect(await screen.findByText(/已是「待开发」状态/)).toBeTruthy();
  });
});
