import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeupMr, Task } from "../types";
import { I18nProvider } from "../i18n";
import App from "../App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  welcome: vi.fn(),
  project: vi.fn(),
  events: new Map<string, (event: { payload: unknown }) => void>(),
  terminal: {
    terminalSizeRef: { current: { cols: 120, rows: 40 } },
    createOutputChannel: vi.fn(),
    resetTaskTerminal: vi.fn(),
    removeTaskBuffers: vi.fn(),
    writeErrorToTerminal: vi.fn(),
    getTaskRestoreState: vi.fn(),
    handleInput: vi.fn(),
    handleTerminalReady: vi.fn(),
  },
  stream: {
    resetTask: vi.fn(),
    ingestFrameLine: vi.fn(),
    finalizeTask: vi.fn(),
    getStream: vi.fn(),
    hydrateHistory: vi.fn(),
    beginFollowUpRound: vi.fn(),
    appendLocalUserMessage: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, handler) => {
    mocks.events.set(name, handler);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme: async () => {} }),
}));
vi.mock("../components/WelcomePage", () => ({ WelcomePage: mocks.welcome }));
vi.mock("../components/ProjectPage", () => ({ ProjectPage: mocks.project }));
vi.mock("../components/BoardOverlay", () => ({ BoardOverlay: () => null }));
vi.mock("../components/update/UpdateController", () => ({ UpdateController: () => null }));
vi.mock("../hooks/useTerminalManager", () => ({ useTerminalManager: () => mocks.terminal }));
vi.mock("../hooks/useCodexStream", () => ({ useCodexStream: () => mocks.stream }));
vi.mock("../hooks/useWorktreeDiffStats", () => ({
  useWorktreeDiffStats: () => ({ scheduleForDoneTask: vi.fn() }),
}));
vi.mock("../hooks/useCodexAutoName", () => ({ useCodexAutoName: () => {} }));
vi.mock("../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const project = { id: "p1", path: "C:/fixture", name: "fixture", lastOpenedAt: 1 };
const mr = {
  projectPath: project.path,
  sourceBranch: "feature",
  targetBranch: "main",
  localId: 1,
  title: "fixture",
  repository: "fixture",
} as CodeupMr;

async function mountApp(mode: "structured" | "pty", tasks: Task[] = []) {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "load_app_settings") return { codex_run_mode: mode };
    if (command === "load_projects") return [project];
    if (command === "load_project_tasks") return tasks;
    if (command === "codeup_pull_code") return "C:/fixture/checkout";
    if (command === "read_project_config") return { agent: {}, plan: {} };
    if (command === "load_skill_hub_config") return {};
    return [];
  });
  render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
  await waitFor(() => expect(mocks.welcome.mock.lastCall?.[0].projects).toEqual([project]));
}

async function startIncompleteMerge(mode: "structured" | "pty" = "structured") {
  await mountApp(mode);
  await act(async () => {
    await mocks.welcome.mock.lastCall![0].onStartCodeupTask(mr, "merge");
  });
  const taskId: string = mocks.invoke.mock.calls.find(([command]) => command === "run_task")![1]
    .taskId;
  await act(async () => {
    mocks.events.get("task-session")!({
      payload: {
        task_id: taskId,
        session_id: "merge-thread",
        session_path: "C:/fixture/merge.jsonl",
      },
    });
  });
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, ...args) => {
    if (command === "codeup_cleanup_mr" || command === "codeup_check_merge_completion")
      throw new Error("CODEUP_MERGE_INCOMPLETE: unresolved merge");
    return original(command, ...args);
  });
  return taskId;
}

async function completeTurn(taskId: string, status = "done") {
  await act(async () => {
    mocks.events.get("task-status")!({ payload: { task_id: taskId, status } });
  });
}

describe("application task launch settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["review", "merge", "conflict"] as const)(
    "%s follows structured settings through run_task and persistence",
    async (kind) => {
      await mountApp("structured");
      await act(async () => {
        await mocks.welcome.mock.lastCall![0].onStartCodeupTask(mr, kind);
      });
      expect(mocks.invoke.mock.calls.find(([command]) => command === "run_task")?.[1].runMode).toBe(
        "structured",
      );
      const writes = mocks.invoke.mock.calls.filter(
        ([command]) => command === "save_project_tasks",
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[writes.length - 1][1].tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agent: "codex", runMode: "structured" }),
        ]),
      );
    },
  );

  it("merge keeps PTY when configured", async () => {
    await mountApp("pty");
    await act(async () => {
      await mocks.welcome.mock.lastCall![0].onStartCodeupTask(mr, "merge");
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "run_task",
      expect.objectContaining({ runMode: "pty" }),
    );
  });

  it.each([
    ["codex", "structured", "structured"],
    ["codex", "pty", "pty"],
    ["claude", "structured", "pty"],
  ] as const)("new %s task with %s settings launches as %s", async (agent, mode, expected) => {
    await mountApp(mode);
    await act(async () => {
      await mocks.welcome.mock.lastCall![0].onProjectClick(project);
    });
    await act(async () => {
      await mocks.project.mock.lastCall![0].onSubmitTask({
        prompt: "fix",
        agent,
        permissionMode: "ask",
        images: [],
        texts: [],
        immediate: true,
        launchMode: "local",
        baseBranch: "",
      });
    });
    const launch = mocks.invoke.mock.calls.find(([command]) => command === "run_task")?.[1];
    expect(launch).toMatchObject({ agent, runMode: expected });
    if (expected === "pty") {
      await act(async () => {
        mocks.project.mock.lastCall![0].onInput(launch.taskId, "raw\r\x1b");
      });
      expect(mocks.terminal.handleInput).toHaveBeenCalledWith(launch.taskId, "raw\r\x1b");
    }
  });

  it("a structured startup failure persists the PTY fallback", async () => {
    await mountApp("structured");
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, ...args) => {
      if (command === "run_task" && args[0].runMode === "structured")
        throw new Error("handshake failed");
      return original(command, ...args);
    });
    await act(async () => {
      await mocks.welcome.mock.lastCall![0].onStartCodeupTask(mr, "review");
    });
    const launches = mocks.invoke.mock.calls.filter(([command]) => command === "run_task");
    expect(launches.map(([, params]) => params.runMode)).toEqual(["structured", "pty"]);
    const writes = mocks.invoke.mock.calls.filter(([command]) => command === "save_project_tasks");
    expect(writes[writes.length - 1][1].tasks[0]).toMatchObject({
      runMode: "pty",
      failureReason: "handshake failed",
    });
  });

  it.each(["structured", "pty"] as const)("session forks follow %s settings", async (mode) => {
    const task: Task = {
      id: "source",
      projectId: project.id,
      prompt: "source",
      agent: "codex",
      permissionMode: "ask",
      status: "done",
      createdAt: 1,
      codexSessionId: "thread-source",
    };
    await mountApp(mode, [task]);
    await act(async () => {
      await mocks.welcome.mock.lastCall![0].onProjectClick(project);
    });
    await act(async () => {
      mocks.project.mock.lastCall![0].onForkTask(task.id, "fork");
    });
    const launch = mocks.invoke.mock.calls.find(([command]) => command === "fork_task")?.[1];
    expect(launch).toMatchObject({
      sourceSessionId: "thread-source",
      runMode: mode === "structured" ? mode : undefined,
    });
    if (mode === "structured") {
      expect(mocks.invoke.mock.calls.some(([command]) => command === "arm_terminal_ready")).toBe(
        false,
      );
    }
  });

  it("starts an existing PTY todo with the current structured setting", async () => {
    const task: Task = {
      id: "todo",
      projectId: project.id,
      prompt: "fix",
      agent: "codex",
      permissionMode: "ask",
      status: "todo",
      createdAt: 1,
      runMode: "pty",
    };
    await mountApp("structured", [task]);
    await act(async () => {
      await mocks.welcome.mock.lastCall![0].onProjectClick(project);
    });
    await act(async () => {
      mocks.project.mock.lastCall![0].onRunTodoTask(task);
    });
    expect(mocks.invoke.mock.calls.find(([command]) => command === "run_task")?.[1].runMode).toBe(
      "structured",
    );
  });

  it.each(["running", "done"] as const)(
    "review comment input for a %s structured task uses app-server",
    async (status) => {
      await mountApp("structured");
      await act(async () => {
        await mocks.welcome.mock.lastCall![0].onStartCodeupTask(mr, "review");
      });
      const taskId = mocks.invoke.mock.calls.find(([command]) => command === "run_task")![1].taskId;
      await act(async () => {
        mocks.events.get("task-session")!({
          payload: {
            task_id: taskId,
            session_id: "thread-review",
            session_path: "C:/fixture/session.jsonl",
          },
        });
        mocks.events.get("task-status")!({ payload: { task_id: taskId, status } });
      });
      await act(async () => {
        mocks.project.mock.lastCall![0].onInput(taskId, "review feedback\r");
      });
      const command = status === "running" ? "steer_codex_structured" : "resume_codex_structured";
      expect(mocks.invoke).toHaveBeenCalledWith(
        command,
        expect.objectContaining({ prompt: "review feedback", taskId }),
      );
      expect(mocks.invoke.mock.calls.some(([name]) => name === "resume_task")).toBe(false);
    },
  );

  it("does not clean up a failed merge task", async () => {
    await mountApp("structured");
    await act(async () => {
      await mocks.welcome.mock.lastCall![0].onStartCodeupTask(mr, "merge");
    });
    const taskId = mocks.invoke.mock.calls.find(([command]) => command === "run_task")![1].taskId;
    await act(async () => {
      mocks.events.get("task-status")!({ payload: { task_id: taskId, status: "failed" } });
    });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "codeup_cleanup_mr")).toBe(
      false,
    );
  });

  it("preserves an unfinished merge when the agent reports done", async () => {
    await mountApp("structured");
    await act(async () => {
      await mocks.welcome.mock.lastCall![0].onStartCodeupTask(mr, "merge");
    });
    const taskId = mocks.invoke.mock.calls.find(([command]) => command === "run_task")![1].taskId;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, ...args) => {
      if (command === "codeup_cleanup_mr") throw new Error("unfinished merge");
      return original(command, ...args);
    });
    await act(async () => {
      mocks.events.get("task-status")!({ payload: { task_id: taskId, status: "done" } });
    });
    const writes = mocks.invoke.mock.calls.filter(([command]) => command === "save_project_tasks");
    expect(writes[writes.length - 1][1].tasks[0].status).toBe("interrupted");
  });

  it.each(["structured", "pty"] as const)(
    "continues the same %s session when the agent stops with Git conflicts",
    async (mode) => {
      const taskId = await startIncompleteMerge(mode);
      await completeTurn(taskId);
      if (mode === "structured") {
        const resume = mocks.invoke.mock.calls.find(
          ([command]) => command === "resume_codex_structured",
        )?.[1];
        expect(resume).toMatchObject({
          taskId,
          threadId: "merge-thread",
          projectPath: "C:/fixture/checkout",
        });
        expect(resume.prompt).toContain("继续解决");
        expect(resume.prompt).toContain("HEAD:main");
      } else {
        await act(async () => {
          mocks.project.mock.lastCall![0].onTerminalReady(taskId, 1);
        });
        expect(mocks.invoke).toHaveBeenCalledWith(
          "resume_task",
          expect.objectContaining({
            taskId,
            sessionId: "merge-thread",
            projectPath: "C:/fixture/checkout",
          }),
        );
        expect(mocks.invoke).toHaveBeenCalledWith(
          "send_input",
          expect.objectContaining({ taskId, data: expect.stringContaining("继续解决") }),
        );
      }
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "run_task")).toHaveLength(1);
    },
  );

  it("stops after two unsuccessful continuations and preserves the merge", async () => {
    const taskId = await startIncompleteMerge();
    await completeTurn(taskId);
    await completeTurn(taskId);
    await completeTurn(taskId);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "resume_codex_structured"),
    ).toHaveLength(2);
    const writes = mocks.invoke.mock.calls.filter(([command]) => command === "save_project_tasks");
    expect(writes[writes.length - 1][1].tasks[0].status).toBe("interrupted");
  });

  it("continues an idle PTY turn in place without cleaning or starting a second process", async () => {
    const taskId = await startIncompleteMerge("pty");
    await completeTurn(taskId, "awaiting_review");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "codeup_check_merge_completion",
      expect.objectContaining({ repository: mr.repository }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "send_input",
      expect.objectContaining({ taskId, data: expect.stringContaining("继续解决") }),
    );
    expect(
      mocks.invoke.mock.calls.some(
        ([command]) => command === "codeup_cleanup_mr" || command === "resume_task",
      ),
    ).toBe(false);
  });

  it("does not continue a merge if the user cancels while Git checks are pending", async () => {
    const taskId = await startIncompleteMerge();
    let rejectCleanup: (reason: Error) => void = () => {};
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, ...args) => {
      if (command === "codeup_cleanup_mr")
        return new Promise((_, reject) => {
          rejectCleanup = reject;
        });
      return original(command, ...args);
    });
    await completeTurn(taskId);
    await act(async () => {
      mocks.project.mock.lastCall![0].onCancelTask(taskId);
      mocks.events.get("task-status")!({ payload: { task_id: taskId, status: "cancelled" } });
    });
    await act(async () => {
      rejectCleanup(new Error("CODEUP_MERGE_INCOMPLETE: unresolved merge"));
    });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "resume_codex_structured")).toBe(
      false,
    );
    const writes = mocks.invoke.mock.calls.filter(([command]) => command === "save_project_tasks");
    expect(writes[writes.length - 1][1].tasks[0].status).toBe("cancelled");
  });

  it("keeps the live PTY available after two unsuccessful continuations", async () => {
    const taskId = await startIncompleteMerge("pty");
    await completeTurn(taskId, "awaiting_review");
    await completeTurn(taskId, "awaiting_review");
    await completeTurn(taskId, "awaiting_review");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "send_input")).toHaveLength(2);
    const writes = mocks.invoke.mock.calls.filter(([command]) => command === "save_project_tasks");
    expect(writes[writes.length - 1][1].tasks[0].status).toBe("awaiting_review");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "resume_task")).toBe(false);
  });
});
