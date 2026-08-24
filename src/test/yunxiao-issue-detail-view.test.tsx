import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, YunxiaoSupplement, YunxiaoWorkitem } from "../types";
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

function view(task: Task, onFinalize = vi.fn(), onDraftChange = vi.fn()) {
  return (
    <I18nProvider>
      <ToastProvider>
        <YunxiaoIssueDetailView
          task={task}
          projectPath="C:\\proj"
          onBack={vi.fn()}
          onDraftChange={onDraftChange}
          onFinalize={onFinalize}
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
      if (command === "generate_issue_supplement") {
        return Promise.resolve({
          fields: { subject: "预填标题", expectation: "预填期望" },
        });
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

  it("定稿后切回该待办：恢复表单内容与定稿状态", async () => {
    const onFinalize = vi.fn();
    const { rerender } = render(view(baseTask("task-a", "workitem-a"), onFinalize));

    await waitFor(() => expect(screen.getByLabelText("Expected behavior")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Expected behavior"), {
      target: { value: "期望 A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));

    const supplement = onFinalize.mock.calls[0][2] as YunxiaoSupplement;
    expect(supplement.fields.expectation).toBe("期望 A");
    expect(supplement.finalized).toBe(true);

    // 切走再切回：任务已带上定稿数据（等同从磁盘加载）
    rerender(view({ ...baseTask("task-a", "workitem-a"), yunxiaoSupplement: supplement }));
    await waitFor(() => expect(screen.getByLabelText("Expected behavior")).toHaveValue("期望 A"));
    expect(screen.getByRole("button", { name: "Finalized" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start discussion" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("AI 预填后草稿立即落盘：未定稿切走再回来（重挂载）也能恢复内容", async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(view(baseTask("task-a", "workitem-a"), vi.fn(), onDraftChange));

    await waitFor(() => expect(screen.getByRole("button", { name: "AI prefill" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "AI prefill" }));

    // 预填完成即落盘（不走防抖）
    await waitFor(() => expect(onDraftChange).toHaveBeenCalled());
    const fields = onDraftChange.mock.calls[0][1] as Record<string, string>;
    expect(fields.subject).toBe("预填标题");

    // 模拟切到文件预览再回来：详情页重挂载，任务已带上未定稿的草稿数据
    rerender(
      view(
        {
          ...baseTask("task-a", "workitem-a"),
          yunxiaoSupplement: {
            fields,
            originalPrompt: "议题 A 的本地 prompt",
            finalized: false,
          },
        },
        vi.fn(),
        onDraftChange,
      ),
    );
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue("预填标题"));
    // 未定稿：可继续编辑/定稿，但发起讨论仍锁定
    expect(screen.getByRole("button", { name: "Finalize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start discussion" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("编辑字段后防抖落盘草稿（finalized=false），定稿前发起讨论保持锁定", async () => {
    const onDraftChange = vi.fn();
    render(view(baseTask("task-a", "workitem-a"), vi.fn(), onDraftChange));

    await waitFor(() => expect(screen.getByLabelText("Expected behavior")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Expected behavior"), {
      target: { value: "期望 A" },
    });

    await waitFor(() => expect(onDraftChange).toHaveBeenCalled(), { timeout: 2000 });
    const args = onDraftChange.mock.calls[0] as [string, Record<string, string>];
    expect(args[0]).toBe("task-a");
    expect(args[1].expectation).toBe("期望 A");
  });

  it("预填未完成时切走再切回：组件已挂载但 task 先收到草稿，表单同步最新字段", async () => {
    const { rerender } = render(view(baseTask("task-a", "workitem-a")));
    await waitFor(() => expect(screen.getByLabelText("Expected behavior")).toBeTruthy());

    // 旧实例的预填完成把草稿写回 task（组件仍挂载，task prop 更新）
    rerender(
      view({
        ...baseTask("task-a", "workitem-a"),
        yunxiaoSupplement: {
          fields: { subject: "预填标题", expectation: "预填期望" },
          originalPrompt: "议题 A 的本地 prompt",
          finalized: false,
        },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("Expected behavior")).toHaveValue("预填期望"));
    expect(screen.getByLabelText("Subject")).toHaveValue("预填标题");
    // 未定稿：发起讨论仍锁定
    expect(screen.getByRole("button", { name: "Start discussion" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("权限模式按项目记忆，切换待办后沿用上次选择", async () => {
    const { rerender } = render(view(baseTask("task-a", "workitem-a")));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto-edit" }));
    expect(localStorage.getItem("nezha:lastYunxiaoPermission:p-1")).toBe("full_access");

    // 同项目切到待办 B：权限默认取记忆值（YOLO）
    rerender(view(baseTask("task-b", "workitem-b")));
    await waitFor(() => expect(screen.getByRole("button", { name: "YOLO" })).toBeTruthy());
  });
});
