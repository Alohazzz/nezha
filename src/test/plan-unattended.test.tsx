import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeneratePlanTodosDialog } from "../components/yunxiao/plan/GeneratePlanTodosDialog";
import { I18nProvider } from "../i18n";
import type { PermissionMode, Plan, PlanIssue } from "../types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

type CreateInput = { planId: string; issues: PlanIssue[]; agent: string; permissionMode: PermissionMode };
const plan: Plan = {
  id: "plan1", projectId: "p1", name: "联合方案", status: "finalized", createdAt: 1,
  issues: [{ workitemId: "w1", serialNumber: "QHDK-A", subject: "议题 A" }],
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("nezha:language", "zh");
  invokeMock.mockReset().mockImplementation((command: string) => Promise.resolve(
    command === "read_project_config" ? { agent: { default_permission_mode: "auto_edit" } } : {},
  ));
});

function renderDialog() {
  const onCreateTodos = vi.fn((_input: CreateInput) => Promise.resolve(true));
  render(<I18nProvider><GeneratePlanTodosDialog
    plan={plan} tasks={[]} projectPath="/workspace/demo"
    onCreateTodos={onCreateTodos} onClose={() => undefined}
  /></I18nProvider>);
  return onCreateTodos;
}

describe("方案待办使用项目默认权限", () => {
  it("删除无人值守入口，项目权限优先于旧的 YOLO 选择记忆", async () => {
    localStorage.setItem("nezha:lastYunxiaoPermission:p1", "full_access");
    const create = renderDialog();
    await screen.findByRole("button", { name: "自动编辑" });
    expect(screen.queryByRole("switch", { name: "整链自动接续" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /生成 1 个待办/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].permissionMode).toBe("auto_edit");
    expect(create.mock.calls[0][0]).not.toHaveProperty("unattended");
    expect(invokeMock).toHaveBeenCalledWith("read_project_config", { projectPath: "/workspace/demo" });
  });

  it("项目配置为 full_access 时继承它，权限仍可手动选择", async () => {
    invokeMock.mockImplementation((command: string) => Promise.resolve(
      command === "read_project_config" ? { agent: { default_permission_mode: "full_access" } } : {},
    ));
    const create = renderDialog();
    const badge = await screen.findByRole("button", { name: "YOLO" });
    expect(badge).toBeEnabled();
    fireEvent.click(badge);
    expect(screen.getByRole("button", { name: "询问" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /生成 1 个待办/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].permissionMode).toBe("ask");
  });

  it("读取项目权限前不能生成任务", async () => {
    let finish!: (config: unknown) => void;
    invokeMock.mockImplementation((command: string) => command === "read_project_config"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    renderDialog();
    const create = screen.getByRole("button", { name: /生成 1 个待办/ });
    expect(create).toBeDisabled();
    finish({ agent: { default_permission_mode: "ask" } });
    await waitFor(() => expect(create).toBeEnabled());
  });
});
