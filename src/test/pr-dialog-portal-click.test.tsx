import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "../components/ProjectPage";
import { ToastProvider } from "../components/Toast";
import { NotificationsProvider } from "../hooks/useNotifications";
import { DEFAULT_APP_SETTINGS } from "../components/app-settings/types";
import { I18nProvider } from "../i18n";
import type { Project } from "../types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => undefined),
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isVisible: () => Promise.resolve(true),
    listen: () => Promise.resolve(() => undefined),
    onDragDropEvent: () => Promise.resolve(() => undefined),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("../components/RunningView", () => ({
  RunningView: () => <div data-testid="running-view-stub" />,
}));

const project: Project = {
  id: "p1",
  name: "demo",
  path: "H:/workspace/demo",
  lastOpenedAt: 1,
};

const settingsWithYunxiao = {
  ...DEFAULT_APP_SETTINGS,
  yunxiao: {
    token: "pt-test",
    organizationId: "org-1",
    projectId: "proj-1",
  },
};

function noop() {
  /* event sink */
}

function renderPage() {
  return render(
    <I18nProvider>
      <NotificationsProvider>
        <ToastProvider>
          <ProjectPage
            project={project}
            tasks={[]}
            getTaskRestoreState={() => ({})}
            taskRunCounts={{}}
            selectedTaskId={null}
            isNewTask
            onNewTask={noop}
            onSelectTask={noop}
            onDeleteTask={noop}
            onDeleteAllTasks={noop}
            onToggleTaskStar={noop}
            onRenameTask={noop}
            onGenerateTaskName={vi.fn().mockResolvedValue(undefined)}
            onSubmitTask={noop}
            onRunTodoTask={noop}
            onUpdateTodo={noop}
            onStartTodoYunxiaoDiscussion={noop}
            onStartTodoYunxiaoDirect={noop}
            todoDiscussionStarting={false}
            onGenerateWritebackSummary={vi.fn()}
            onWritebackYunxiao={vi.fn()}
            onRetryWritebackScoreField={vi.fn()}
            knowledgeResults={{}}
            sedimentingTasks={{}}
            plans={[]}
            onGeneratePlanTodos={vi.fn()}
            onRebindTaskPlan={vi.fn()}
            onDeletePlan={vi.fn()}
            onCancelTask={noop}
            onResumeTask={noop}
            onResumeTaskAndSend={noop}
            onForkTask={noop}
            onMergeWorktree={vi.fn()}
            onDiscardWorktree={vi.fn()}
            onReconnectTask={noop}
            onMarkTaskDone={noop}
            onInput={noop}
            onResize={noop}
            onRegisterTerminal={() => 0}
            onTerminalReady={noop}
            onSnapshot={noop}
            onBack={noop}
            onSwitchProject={noop}
            onCommitProjectOrder={vi.fn()}
            onOpen={noop}
            themeVariant="dark"
            themeMode="dark"
            systemPrefersDark
            onThemeModeChange={noop}
            onToggleTheme={noop}
            terminalFontSize={12}
            onTerminalFontSizeChange={noop}
            taskDisplayWindow={3}
            onTaskDisplayWindowChange={noop}
            attentionBadge={false}
            onAttentionBadgeChange={noop}
            terminalScrollback={1000}
            onTerminalScrollbackChange={noop}
            uiFontFamily="system-ui"
            onUiFontFamilyChange={noop}
            monoFontFamily="monospace"
            onMonoFontFamilyChange={noop}
          />
        </ToastProvider>
      </NotificationsProvider>
    </I18nProvider>,
  );
}

describe("创建 PR 弹窗内的 Radix 下拉", () => {
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
        case "read_project_config":
          return Promise.resolve({ agent: {} });
        case "get_hook_readiness":
          return Promise.resolve([]);
        case "list_project_files":
          return Promise.resolve([]);
        case "discover_git_roots":
          return Promise.resolve([]);
        case "read_file_content":
          return Promise.reject(new Error("not found"));
        case "list_branch_batches":
          return Promise.resolve([]);
        case "git_list_branches":
          return Promise.resolve([]);
        case "watch_dir":
          return Promise.resolve(false);
        case "get_branch_batch_worktree_base":
          return Promise.resolve("H:/workspace/worktrees");
        case "preview_branch_batch_branch":
          return Promise.resolve("feature/v2.20260901/develop/锁号");
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("点下拉项不会把弹窗（以及面板）关掉", async () => {
    const user = userEvent.setup();
    renderPage();

    // 打开右侧 PR 面板（悬浮，未固定 → 外部点击会自动收起）。
    await user.click(await screen.findByTitle("PR"));
    await user.click(await screen.findByRole("button", { name: /新建 PR/ }));
    expect(await screen.findByText("创建 PR")).toBeInTheDocument();

    // 展开版本下拉（内容 portal 到 body），选一项。
    const picker = await screen.findByRole("button", { name: /选择/ });
    await waitFor(() => expect(picker).toBeEnabled());
    await user.click(picker);
    await user.click(await screen.findByText("v2.20260901"));

    // 回归点：点击 portal 出来的下拉项曾被判成「面板外点击」，连带卸载弹窗与面板。
    await waitFor(() => {
      expect(screen.getByText("创建 PR")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /取消/ })).toBeInTheDocument();
    });
  });

  it("目标分支段恒在源分支名里，且没有「是否带目标分支段」的开关", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByTitle("PR"));
    await user.click(await screen.findByRole("button", { name: /新建 PR/ }));
    await screen.findByText("创建 PR");

    // 预览命令不再接收 includeTarget：目标分支段由 targetBranch 决定、恒带出。
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "preview_branch_batch_branch");
      const args = call?.[1] as Record<string, unknown> | undefined;
      expect(args?.targetBranch).toBe("develop");
      expect(args).not.toHaveProperty("includeTarget");
    });

    // 源分支输入框展示带目标段的完整名字，且可压缩（flex:1 + min-width:0），
    // 否则长分支名会被同行按钮挤出对话框、显示不全。
    const source = await screen.findByDisplayValue("feature/v2.20260901/develop/锁号");
    expect(source).toHaveStyle({ flex: "1", minWidth: "0" });

    expect(screen.queryByText("分支名带目标分支段")).not.toBeInTheDocument();
  });
});
