import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeneratePlanTodosDialog } from "../components/yunxiao/plan/GeneratePlanTodosDialog";
import { I18nProvider } from "../i18n";
import type { Plan, PlanIssue } from "../types";

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve({}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type CreateInput = {
  planId: string;
  issues: PlanIssue[];
  agent: string;
  permissionMode: string;
  unattended?: boolean;
};

// 断言按中文文案；jsdom 的 navigator.language 默认是 en。
beforeEach(() => {
  localStorage.setItem("nezha:language", "zh");
  invokeMock.mockClear();
});

function makePlan(): Plan {
  return {
    id: "plan1",
    projectId: "p1",
    name: "联合方案",
    issues: [
      { workitemId: "w1", serialNumber: "QHDK-A", subject: "议题 A" },
      { workitemId: "w2", serialNumber: "QHDK-B", subject: "议题 B" },
    ],
    status: "finalized",
    createdAt: 1,
  };
}

function renderDialog() {
  const onCreateTodos = vi.fn((_input: CreateInput) => Promise.resolve(true));
  render(
    <I18nProvider>
      <GeneratePlanTodosDialog
        plan={makePlan()}
        tasks={[]}
        onCreateTodos={onCreateTodos}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );
  return { onCreateTodos };
}

/** 等 `load_app_settings` 的 effect 落定，避免 act() 警告。 */
async function toggleUnattended() {
  const toggle = await screen.findByRole("switch", { name: "整链自动接续" });
  fireEvent.click(toggle);
  return toggle;
}

describe("GeneratePlanTodosDialog 无人值守", () => {
  it("默认关闭：生成待办不带 unattended，权限保留用户的询问模式", async () => {
    const { onCreateTodos } = renderDialog();
    // 等设置 effect 落定（同时确认开关默认关）。
    const toggle = await screen.findByRole("switch", { name: "整链自动接续" });
    expect(toggle).toHaveAttribute("data-checked", "false");

    fireEvent.click(screen.getByRole("button", { name: /生成 2 个待办/ }));
    await vi.waitFor(() => expect(onCreateTodos).toHaveBeenCalled());
    expect(onCreateTodos.mock.calls[0][0]).toMatchObject({
      unattended: false,
      permissionMode: "ask",
    });
  });

  it("勾选无人值守：权限徽标强制显示 YOLO，生成带 unattended", async () => {
    const { onCreateTodos } = renderDialog();
    const toggle = await toggleUnattended();
    expect(toggle).toHaveAttribute("data-checked", "true");

    // 权限徽标变为 YOLO（无人值守覆盖用户的「询问」选择）。
    expect(screen.getByRole("button", { name: "YOLO" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /生成 2 个待办/ }));
    await vi.waitFor(() => expect(onCreateTodos).toHaveBeenCalled());
    expect(onCreateTodos.mock.calls[0][0]).toMatchObject({ unattended: true });
  });

  it("勾选无人值守后权限徽标不可再循环", async () => {
    renderDialog();
    await toggleUnattended();
    expect(screen.getByRole("button", { name: "YOLO" })).toBeDisabled();
  });
});
