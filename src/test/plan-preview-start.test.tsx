import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PlanPreviewPanel } from "../components/yunxiao/plan/PlanPreviewPanel";
import type { AgentType, PermissionMode, Plan, PlanIssue, Task } from "../types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const PLAN_MD = `# 方案

## 统筹

总览内容。

## QHDK-A 议题 A

正文 A。
`;

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan1",
    projectId: "p1",
    name: "医保目录联合方案",
    issues: [
      { workitemId: "w1", serialNumber: "QHDK-A", subject: "议题 A" },
      { workitemId: "w2", serialNumber: "QHDK-B", subject: "议题 B" },
    ],
    status: "finalized",
    createdAt: 1,
    ...overrides,
  };
}

type PanelProps = React.ComponentProps<typeof PlanPreviewPanel>;

function renderPanel(props: Partial<PanelProps> = {}) {
  const onCreateTodos = vi.fn().mockResolvedValue(true);
  render(
    <I18nProvider>
      <PlanPreviewPanel
        plan={makePlan()}
        tasks={[] as Task[]}
        projectPath="/workspace/demo"
        onCreateTodos={onCreateTodos}
        onDeletePlan={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
  return { onCreateTodos };
}

describe("PlanPreviewPanel「开始」按钮", () => {
  beforeEach(() => {
    localStorage.clear();
    // 断言按中文文案；jsdom 的 navigator.language 默认是 en。
    localStorage.setItem("nezha:language", "zh");
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_app_settings") return Promise.resolve({});
      if (command === "read_file_content") return Promise.resolve(PLAN_MD);
      if (command === "read_dir_entries") return Promise.resolve([]);
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("定稿方案显示「开始」，点击即以 autoStart 生成待办（沿用议题顺序与默认 Agent/权限）", async () => {
    const user = userEvent.setup();
    localStorage.setItem("nezha:lastYunxiaoAgent:p1", "claude");
    localStorage.setItem("nezha:lastYunxiaoPermission:p1", "auto_edit");
    const { onCreateTodos } = renderPanel();

    const startBtn = await screen.findByRole("button", { name: /开始/ });
    await user.click(startBtn);

    await waitFor(() => expect(onCreateTodos).toHaveBeenCalledTimes(1));
    const input = onCreateTodos.mock.calls[0][0] as {
      planId: string;
      issues: PlanIssue[];
      agent: AgentType;
      permissionMode: PermissionMode;
      autoStart?: boolean;
    };
    expect(input.planId).toBe("plan1");
    expect(input.autoStart).toBe(true);
    expect(input.agent).toBe("claude");
    expect(input.permissionMode).toBe("auto_edit");
    // 「开始」跳过确认页，直接用方案快照的全部议题与顺序
    expect(input.issues.map((i) => i.serialNumber)).toEqual(["QHDK-A", "QHDK-B"]);
  });

  it("无历史选择时回落默认 codex / ask", async () => {
    const user = userEvent.setup();
    const { onCreateTodos } = renderPanel();
    await user.click(await screen.findByRole("button", { name: /开始/ }));

    await waitFor(() => expect(onCreateTodos).toHaveBeenCalledTimes(1));
    const input = onCreateTodos.mock.calls[0][0] as { agent: AgentType; permissionMode: PermissionMode };
    expect(input.agent).toBe("codex");
    expect(input.permissionMode).toBe("ask");
  });

  it("讨论中的方案「开始」与「生成待办」均禁用", async () => {
    renderPanel({ plan: makePlan({ status: "draft" }) });
    await screen.findByText("总览内容。");
    expect(screen.getByRole("button", { name: /开始/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /生成待办/ })).toBeDisabled();
  });

  it("「开始」成功后关闭预览弹窗", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });
    await user.click(await screen.findByRole("button", { name: /开始/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
