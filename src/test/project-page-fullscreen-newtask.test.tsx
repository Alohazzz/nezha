import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ProjectPage } from "../components/ProjectPage";
import { ToastProvider } from "../components/Toast";
import { NotificationsProvider } from "../hooks/useNotifications";
import { DEFAULT_APP_SETTINGS } from "../components/app-settings/types";
import { I18nProvider } from "../i18n";
import type { Project, Task } from "../types";

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

// RunningView 内部挂载 xterm/WebGL，jsdom 跑不起来；本测试只关注 ProjectPage 的分层渲染，
// 用轻量标记替代真实终端组件。
vi.mock("../components/RunningView", () => ({
  RunningView: ({ visible }: { visible?: boolean }) => (
    <div data-testid="running-view-stub" data-visible={String(!!visible)} />
  ),
}));

const project: Project = {
  id: "p1",
  name: "demo",
  path: "/workspace/demo",
  lastOpenedAt: 1,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    prompt: "",
    agent: "claude",
    permissionMode: "ask",
    status: "done",
    createdAt: 1,
    ...overrides,
  };
}

function noop() {
  /* event sink */
}

function renderPage(props: {
  tasks: Task[];
  selectedTaskId: string | null;
  isNewTask: boolean;
}) {
  return render(
    <I18nProvider>
      <NotificationsProvider>
        <ToastProvider>
          <ProjectPage
          project={project}
          tasks={props.tasks}
          getTaskRestoreState={() => ({})}
          taskRunCounts={{}}
          selectedTaskId={props.selectedTaskId}
          isNewTask={props.isNewTask}
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
          onGenerateKnowledgeSedimentation={vi.fn()}
          onCreateKnowledgeIssues={vi.fn()}
          plans={[]}
          onGeneratePlanTodos={vi.fn()}
          onRebindTaskPlan={vi.fn()}
          onCancelPlan={vi.fn()}
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
          systemPrefersDark={true}
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

describe("ProjectPage fullscreen 新建任务前景层", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "load_app_settings":
          return Promise.resolve(DEFAULT_APP_SETTINGS);
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
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("fullscreen 下新建任务时内容层不渲染空态占位遮挡 NewTaskView", async () => {
    // 有一个已完成任务但处于"新建任务"态：背景层应显示 NewTaskView，
    // 前景层不渲染（fbd28bd 引入的 isNewTask 条件会让空态占位盖住背景层）
    renderPage({
      tasks: [makeTask()],
      selectedTaskId: null,
      isNewTask: true,
    });

    // 背景层 NewTaskView 已渲染（启动终端按钮可见且可点）
    const startBtn = await screen.findByRole("button", { name: /启动终端|Start Terminal/i });
    expect(startBtn).toBeEnabled();

    // 前景空态占位不允许存在 —— 存在时 zIndex:1 的透明层会截掉上方所有点击
    const stage = document.getElementById("nezha-main-stage")!;
    expect(within(stage).queryByText("还没有打开文件")).not.toBeInTheDocument();
  });

  it("fullscreen 下选中任务查看终端时不渲染内容层", async () => {
    renderPage({
      tasks: [makeTask()],
      selectedTaskId: "t1",
      isNewTask: false,
    });

    // 背景层 RunningView（终端 stub）渲染且可见，前景内容层不渲染
    const stub = await screen.findByTestId("running-view-stub");
    expect(stub).toHaveAttribute("data-visible", "true");
    const stage = document.getElementById("nezha-main-stage")!;
    expect(within(stage).queryByText("还没有打开文件")).not.toBeInTheDocument();
  });
});
