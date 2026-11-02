import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddPlanResult, DeliveryPlan, YunxiaoWorkitem } from "../types";
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

/** 后端 partial 返回：4 条中 2 成功 / 1 已加入 / 1 失败（issue #121 现场形状）。 */
function partialResult(): AddPlanResult {
  return {
    plan: { ...plan, issues: [] },
    summary: {
      succeeded: [
        { serialNumber: "QHDK-1", workitemId: "w-1" },
        { serialNumber: "QHDK-2", workitemId: "w-2" },
      ],
      skipped: [
        { serialNumber: "QHDK-3", workitemId: "w-3", reason: "已在计划中（待开发）" },
      ],
      failed: [
        { serialNumber: "QHDK-4", workitemId: "w-4", reason: "回写失败：云效 500", retryable: true },
      ],
      pending: [],
      partial: true,
    },
  };
}

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
    invokeMock.mockResolvedValue({ plan, summary: { succeeded: [], skipped: [], failed: [], pending: [], partial: false } });
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

  it("硬失败（如状态拉不到）时在弹窗内展示完整错误", async () => {
    invokeMock.mockRejectedValue("议题 QHDK-1 状态获取失败：401 Unauthorized");
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "加入" }));

    expect(await screen.findByText(/状态获取失败/)).toBeTruthy();
  });
});

describe("AddToPlanDialog 部分失败摘要与重试（issue #121）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("partial 返回时弹四分组摘要，已落盘计划同步父级，弹窗保持打开", async () => {
    invokeMock.mockResolvedValue(partialResult());
    const onAdded = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AddToPlanDialog
        issues={[workitem(1), workitem(2), workitem(3), workitem(4)]}
        projectId="p1"
        deliveryPlans={[plan]}
        settings={SETTINGS}
        onAdded={onAdded}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "加入" }));

    // 四分组齐全，失败组带原因；已加入组标「无需处理」。
    expect(await screen.findByText("✅ 成功", { exact: false })).toBeTruthy();
    expect(screen.getByText("⏭ 无需处理（已加入）", { exact: false })).toBeTruthy();
    expect(screen.getByText(/QHDK-4（回写失败：云效 500）/)).toBeTruthy();
    // 计划已落盘：onAdded 必须被同步调用；弹窗不自动关闭。
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // 出现重试按钮，计数只含 failed + pending。
    expect(screen.getByRole("button", { name: /重试失败\+未处理（1）/ })).toBeTruthy();
  });

  it("重试只把失败/未处理子集发回后端，成功后关闭弹窗", async () => {
    invokeMock
      .mockResolvedValueOnce(partialResult())
      .mockResolvedValueOnce({
        plan,
        summary: { succeeded: [{ serialNumber: "QHDK-4", workitemId: "w-4" }], skipped: [], failed: [], pending: [], partial: false },
      });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AddToPlanDialog
        issues={[workitem(1), workitem(2), workitem(3), workitem(4)]}
        projectId="p1"
        deliveryPlans={[plan]}
        settings={SETTINGS}
        onAdded={vi.fn()}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "加入" }));
    await screen.findByText("✅ 成功", { exact: false });

    await user.click(screen.getByRole("button", { name: /重试失败\+未处理（1）/ }));

    // 第二次 invoke 只带失败子集（w-4），不带已成功/已跳过的条目。
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    const retryArgs = invokeMock.mock.calls[1][1] as { issues: { workitemId: string }[] };
    expect(retryArgs.issues.map((i) => i.workitemId)).toEqual(["w-4"]);
    // 全部成功：摘要态消失，弹窗关闭。
    expect(await screen.findByRole("button", { name: "加入" })).toBeTruthy();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("全部成功（partial=false）时维持旧路径：直接关弹窗，不展示摘要", async () => {
    invokeMock.mockResolvedValue({
      plan,
      summary: { succeeded: [], skipped: [], failed: [], pending: [], partial: false },
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AddToPlanDialog
        issues={[workitem(1), workitem(2)]}
        projectId="p1"
        deliveryPlans={[plan]}
        settings={SETTINGS}
        onAdded={vi.fn()}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "加入" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/✅ 成功/)).toBeNull();
  });

  it("「已属其它计划」前置拦截：失败组展示计划名，且不进重试集", async () => {
    // issue #121：归属冲突在预检阶段（任何写 API 前）逐条拒绝，retryable=false。
    invokeMock.mockResolvedValue({
      plan,
      summary: {
        succeeded: [{ serialNumber: "QHDK-1", workitemId: "w-1" }],
        skipped: [],
        failed: [
          {
            serialNumber: "QHDK-2",
            workitemId: "w-2",
            reason: "已属于其它计划「1108日常需求修改」，请先移出再添加",
            retryable: false,
          },
        ],
        pending: [],
        partial: true,
      },
    });
    const user = userEvent.setup();
    render(
      <AddToPlanDialog
        issues={[workitem(1), workitem(2)]}
        projectId="p1"
        deliveryPlans={[plan]}
        settings={SETTINGS}
        onAdded={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "加入" }));

    // 失败组带计划名；摘要弹出不自动关闭。
    expect(
      await screen.findByText(/已属于其它计划「1108日常需求修改」/),
    ).toBeTruthy();
    // 重试集为空（唯一失败条目不可重试）：重试按钮禁用。
    const retryBtn = screen.getByRole("button", { name: /重试失败\+未处理（0）/ });
    expect(retryBtn).toBeTruthy();
    expect((retryBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

