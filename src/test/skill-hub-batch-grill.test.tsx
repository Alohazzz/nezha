import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "../components/app-settings/SkillsPanel";
import { PlanLaunchDialog } from "../components/yunxiao/plan/PlanLaunchDialog";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "../components/app-settings/types";
import type { Plan, Task, YunxiaoWorkitem } from "../types";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

/** load_app_settings / get_skill_hub_config 之外一律返回 null。 */
function mockBackend(settings: Partial<AppSettings>) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_app_settings") {
      return Promise.resolve({ ...DEFAULT_APP_SETTINGS, ...settings });
    }
    if (cmd === "get_skill_hub_config") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

function renderPanel() {
  return render(
    <I18nProvider>
      <SkillsPanel />
    </I18nProvider>,
  );
}

/**
 * 提问方式（grilling / batch-grill-me / grill-with-ui）已从设置页开关迁移到
 * 发起弹窗的三态循环 badge；设置页不再渲染任何提问方式开关。
 */
describe("SkillsPanel — 提问方式开关已移除", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("不再渲染批量盘问 / UI 盘问开关，也不调保存命令", async () => {
    mockBackend({});
    renderPanel();

    await screen.findByText("Knowledge sedimentation");
    expect(screen.queryByText("Batch Grill")).not.toBeInTheDocument();
    expect(screen.queryByText("UI Grill")).not.toBeInTheDocument();
  });
});

describe("SkillsPanel — 被引用技能未安装的提示", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  /** 每个技能各自的已安装 Agent；未列出的技能视为完全未安装。 */
  function mockBackendWithInstalls(
    settings: Partial<AppSettings>,
    installsBySkill: Record<string, Array<{ agent: string; health?: string }>>,
  ) {
    invokeMock.mockImplementation((cmd: string, args?: { skillName?: string }) => {
      if (cmd === "load_app_settings") {
        return Promise.resolve({ ...DEFAULT_APP_SETTINGS, ...settings });
      }
      if (cmd === "get_skill_hub_config") {
        return Promise.resolve({ hubPath: "/hub", installations: [] });
      }
      if (cmd === "list_skill_installations") {
        const skill = args?.skillName ?? "";
        return Promise.resolve(
          (installsBySkill[skill] ?? []).map((ins) => ({
            skillName: skill,
            projectId: "",
            agent: ins.agent,
            scope: "universal",
            installedAt: 1,
            linkPath: `/x/${ins.agent}/${skill}`,
            targetPath: `/hub/${skill}`,
            health: ins.health ?? "ok",
          })),
        );
      }
      return Promise.resolve(null);
    });
  }

  it("执行技能全部已安装时不提示", async () => {
    mockBackendWithInstalls({}, {
      "yunxiao-issue-execution": [{ agent: "claude" }, { agent: "codex" }, { agent: "dsh" }],
    });
    renderPanel();

    await screen.findByText("Knowledge sedimentation");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("直接执行技能未安装时提示", async () => {
    mockBackendWithInstalls({}, {});
    renderPanel();

    const warn = await screen.findByRole("status");
    expect(warn).toHaveTextContent("yunxiao-issue-execution");
    expect(warn).toHaveTextContent("Claude Code");
  });

  it("仅在缺失该技能的 Agent 上提示", async () => {
    // claude 缺 direct-execution，codex/dsh 已装 → 只提示 Claude Code。
    mockBackendWithInstalls({}, {
      "yunxiao-issue-execution": [{ agent: "codex" }, { agent: "dsh" }],
    });
    renderPanel();

    const warn = await screen.findByRole("status");
    expect(warn).toHaveTextContent("Claude Code");
    expect(warn).not.toHaveTextContent("Codex");
  });

  it("broken 安装不算已安装（仍提示）", async () => {
    mockBackendWithInstalls({}, {
      "yunxiao-issue-execution": [
        { agent: "claude", health: "broken" },
        { agent: "codex" },
        { agent: "dsh" },
      ],
    });
    renderPanel();

    const warn = await screen.findByRole("status");
    expect(warn).toHaveTextContent("Claude Code");
  });

  it("禁用的 Agent 不计入提示", async () => {
    mockBackendWithInstalls({ claude_enabled: false }, {});
    renderPanel();

    const warn = await screen.findByRole("status");
    // claude 已禁用 → 只提示启用中的 codex / dsh。
    expect(warn).not.toHaveTextContent("Claude Code");
    expect(warn).toHaveTextContent("Codex");
    expect(warn).toHaveTextContent("DSH");
  });

  it("技能库未配置时不做提示（无从安装）", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_app_settings") return Promise.resolve({ ...DEFAULT_APP_SETTINGS });
      if (cmd === "get_skill_hub_config") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    renderPanel();

    await screen.findByText("Knowledge sedimentation");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});

/**
 * 方案讨论弹窗的三态提问方式 badge：localStorage 记住上次选择、点击循环切换、
 * 启动时随指令命令透传。
 */
describe("PlanLaunchDialog — 提问方式选择器", () => {
  const issue: YunxiaoWorkitem = {
    id: "w1",
    serialNumber: "#1",
    subject: "Issue 1",
    categoryId: "req",
    customFieldValues: [],
  };
  const plan: Plan = {
    id: "p1",
    projectId: "proj1",
    name: "P1",
    issues: [],
    createdAt: 1,
    status: "draft",
  };

  function mockDialogBackend() {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_app_settings") return Promise.resolve({ ...DEFAULT_APP_SETTINGS });
      if (cmd === "yunxiao_get_workitem") {
        return Promise.resolve({ ...issue, description: "" });
      }
      if (cmd === "yunxiao_prepare_issue_images") {
        return Promise.resolve({
          paths: [],
          failed: 0,
          downloaded: 0,
          total: 0,
          issueTextPath: null,
          errors: [],
        });
      }
      if (cmd === "get_plan_discussion_instructions") {
        return Promise.resolve("instructions");
      }
      return Promise.resolve(null);
    });
  }

  function renderDialog() {
    return render(
      <I18nProvider>
        <PlanLaunchDialog
          issues={[issue]}
          plans={[plan]}
          tasks={[] as Task[]}
          targetProjectId="proj1"
          projectPath="/proj"
          projectName="Proj"
          settings={DEFAULT_APP_SETTINGS.yunxiao}
          onCreatePlan={() => plan}
          onSetParentPlan={() => undefined}
          onStartDiscussion={() => undefined}
          onCancelPlan={() => Promise.resolve()}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );
  }

  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
  });

  it("默认逐条盘问，点击循环切换并写 localStorage", async () => {
    mockDialogBackend();
    const user = userEvent.setup();
    renderDialog();

    const badge = await screen.findByRole("button", { name: "One-by-one" });
    await user.click(badge);
    expect(screen.getByRole("button", { name: "Batch grill" })).toBeInTheDocument();
    expect(localStorage.getItem("nezha:lastQuestionMode")).toBe("batch");

    await user.click(screen.getByRole("button", { name: "Batch grill" }));
    expect(screen.getByRole("button", { name: "UI grill" })).toBeInTheDocument();
    expect(localStorage.getItem("nezha:lastQuestionMode")).toBe("ui");

    await user.click(screen.getByRole("button", { name: "UI grill" }));
    expect(screen.getByRole("button", { name: "One-by-one" })).toBeInTheDocument();
    expect(localStorage.getItem("nezha:lastQuestionMode")).toBe("grilling");
  });

  it("localStorage 里有上次选择时预填，且选择随启动透传给指令命令", async () => {
    localStorage.setItem("nezha:lastQuestionMode", "ui");
    mockDialogBackend();
    const user = userEvent.setup();
    renderDialog();

    await screen.findByRole("button", { name: "UI grill" });
    // 详情拉取完成后「发起讨论」可用。
    const start = await screen.findByRole("button", { name: /Start discussion/ });
    await waitFor(() => expect(start).not.toBeDisabled());
    await user.click(start);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_plan_discussion_instructions", {
        projectPath: "/proj",
        planId: "p1",
        hasBug: false,
        questionMode: "ui",
      }),
    );
  });
});
