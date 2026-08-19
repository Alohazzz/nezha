import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, YunxiaoWorkitem } from "../types";
import { I18nProvider } from "../i18n";
import { ToastProvider } from "../components/Toast";
import { YunxiaoIssueDetailView } from "../components/yunxiao/YunxiaoIssueDetailView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

const workitemA: YunxiaoWorkitem = {
  id: "workitem-a",
  serialNumber: "QHDK-10001",
  subject: "议题 A",
  description: "描述 A",
  status: { name: "待处理", displayName: "待处理", id: "100005" },
  customFieldValues: [],
  categoryId: "Req",
};

const workitemB: YunxiaoWorkitem = {
  id: "workitem-b",
  serialNumber: "QHDK-10002",
  subject: "议题 B",
  description: "描述 B",
  status: { name: "待处理", displayName: "待处理", id: "100005" },
  customFieldValues: [],
  categoryId: "Bug",
};

function baseTask(id: string, workitemId: string): Task {
  return {
    id,
    projectId: "p-1",
    name: `任务 ${id}`,
    prompt: `议题 ${id} 的本地 prompt`,
    agent: "claude",
    permissionMode: "ask",
    status: "todo",
    createdAt: 1787000000000,
    yunxiaoWorkitemId: workitemId,
    yunxiaoSerialNumber: workitemId === "workitem-a" ? "QHDK-10001" : "QHDK-10002",
  };
}

function view(task: Task) {
  return (
    <I18nProvider>
      <ToastProvider>
        <YunxiaoIssueDetailView
          task={task}
          projectPath="C:\\proj"
          onBack={vi.fn()}
          onFinalize={vi.fn()}
          onStartDiscussion={vi.fn()}
        />
      </ToastProvider>
    </I18nProvider>
  );
}

describe("YunxiaoIssueDetailView 待办切换", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "load_app_settings") {
        return Promise.resolve({
          yunxiao: { token: "pt-1", organizationId: "org-1", projectId: "proj-1" },
        });
      }
      if (command === "yunxiao_get_workitem") {
        return Promise.resolve(args?.workitemId === "workitem-b" ? workitemB : workitemA);
      }
      if (command === "get_issue_discussion_instructions") {
        return Promise.resolve("");
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("定稿后切换到另一个待办：表单值清空、定稿状态重置、发起讨论重新禁用", async () => {
    const { rerender } = render(view(baseTask("task-a", "workitem-a")));

    // 等议题加载完成，填入字段并定稿
    await waitFor(() => expect(screen.getByLabelText("Expected behavior")).toBeTruthy());
    // 用需求/Bug 表单共有的「期望行为」字段验证跨待办串值
    fireEvent.change(screen.getByLabelText("Expected behavior"), {
      target: { value: "期望 A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    expect(screen.getByRole("button", { name: "Finalized" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start discussion" }).hasAttribute("disabled")).toBe(
      false,
    );

    // 切换到待办 B
    rerender(view(baseTask("task-b", "workitem-b")));
    await waitFor(() => expect(screen.getByLabelText("Expected behavior")).toHaveValue(""));

    expect(screen.getByLabelText("Expected behavior")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Finalize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start discussion" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});
