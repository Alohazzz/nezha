import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanLaunchParentField } from "../components/yunxiao/plan/PlanLaunchParentField";
import { I18nProvider } from "../i18n";
import type { Plan } from "../types";

// 断言按中文文案；jsdom 的 navigator.language 默认是 en。
beforeEach(() => {
  localStorage.setItem("nezha:language", "zh");
});

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "p1",
    projectId: "proj",
    name: "主方案甲",
    issues: [{ workitemId: "w1", serialNumber: "QHDK-A", subject: "议题 A" }],
    status: "executing",
    createdAt: 1,
    ...overrides,
  };
}

function renderField(props: Partial<React.ComponentProps<typeof PlanLaunchParentField>> = {}) {
  return render(
    <I18nProvider>
      <PlanLaunchParentField
        plans={[makePlan()]}
        targetProjectId="proj"
        currentPlanId="draft-1"
        value=""
        onChange={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

describe("PlanLaunchParentField — 关联方案下拉", () => {
  it("无候选方案时整块不渲染（独立方案是默认路径）", () => {
    const { container } = renderField({ plans: [makePlan({ status: "draft" })] });
    expect(container.querySelector(".plan-launch-parent")).toBeNull();
  });

  it("打开下拉不崩溃：Radix 禁止空字符串 value，占位项必须用哨兵值", () => {
    renderField();
    // Radix 的 SelectItem 在渲染期校验 value，空串会抛错并掀翻根 ErrorBoundary。
    expect(() => fireEvent.click(screen.getByLabelText("不关联（独立方案）"))).not.toThrow();
    expect(screen.getByRole("option", { name: "主方案甲" })).toBeTruthy();
  });

  it("选中主方案 → onChange 收到方案 id", () => {
    const onChange = vi.fn();
    renderField({ onChange });
    fireEvent.click(screen.getByLabelText("不关联（独立方案）"));
    fireEvent.click(screen.getByRole("option", { name: "主方案甲" }));
    expect(onChange).toHaveBeenCalledWith("p1");
  });

  it("从已关联切回「不关联」→ onChange 收到空串（回到独立方案）", () => {
    const onChange = vi.fn();
    renderField({ value: "p1", onChange });
    fireEvent.click(screen.getByLabelText("主方案甲"));
    fireEvent.click(screen.getByRole("option", { name: "不关联（独立方案）" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("已关联时显示追加提示，未关联时显示普通提示", () => {
    const { unmount } = renderField({ value: "" });
    expect(screen.getByText(/将挂成它的子方案/)).toBeTruthy();
    unmount();
    renderField({ value: "p1" });
    expect(screen.getByText(/将成为上述方案的子方案/)).toBeTruthy();
  });

  it("下拉只列本项目、可追加状态的方案（排除自身与不可追加者）", () => {
    renderField({
      plans: [
        makePlan({ id: "ok", name: "可追加" }),
        makePlan({ id: "draft", name: "讨论中", status: "draft" }),
        makePlan({ id: "cancel", name: "已取消", status: "cancelled" }),
        makePlan({ id: "other", name: "别项目", projectId: "other" }),
      ],
    });
    fireEvent.click(screen.getByLabelText("不关联（独立方案）"));
    expect(screen.getByRole("option", { name: "可追加" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "讨论中" })).toBeNull();
    expect(screen.queryByRole("option", { name: "已取消" })).toBeNull();
    expect(screen.queryByRole("option", { name: "别项目" })).toBeNull();
  });
});
