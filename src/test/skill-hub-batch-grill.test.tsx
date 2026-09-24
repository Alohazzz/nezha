import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "../components/app-settings/SkillsPanel";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../components/app-settings/types";
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

describe("SkillsPanel batch grill (experimental skill)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders the toggle off with the experimental badge by default", async () => {
    mockBackend({});
    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Batch Grill" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Experimental")).toBeInTheDocument();
  });

  it("reflects an enabled setting and persists the flip", async () => {
    mockBackend({ batch_grill_enabled: true });
    const user = userEvent.setup();
    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Batch Grill" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "save_batch_grill_enabled") {
        return Promise.resolve({ ...DEFAULT_APP_SETTINGS, batch_grill_enabled: false });
      }
      return Promise.resolve(null);
    });
    await user.click(toggle);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_batch_grill_enabled", { enabled: false }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });
});

/**
 * 云效任务提示词会按名引用技能；未安装时 Agent 读不到契约，流程静默降级
 * （直接执行丢产物契约 / 批量盘问退回逐条）。设置页据此给出提示（Nezha 不做自动安装）。
 */
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

  const BOTH = ["yunxiao-issue-execution", "batch-grill-me"];
  function allInstalled(): Record<string, Array<{ agent: string }>> {
    return Object.fromEntries(
      BOTH.map((s) => [s, [{ agent: "claude" }, { agent: "codex" }, { agent: "dsh" }]]),
    );
  }

  it("全部已安装时不提示", async () => {
    mockBackendWithInstalls({}, allInstalled());
    renderPanel();

    await screen.findByRole("switch", { name: "Batch Grill" });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("直接执行技能未安装时提示（与批量盘问开关无关）", async () => {
    mockBackendWithInstalls({ batch_grill_enabled: false }, {
      "batch-grill-me": [{ agent: "codex" }],
    });
    renderPanel();

    const warn = await screen.findByRole("status");
    expect(warn).toHaveTextContent("yunxiao-issue-execution");
    expect(warn).toHaveTextContent("Claude Code");
    // 开关关闭时 batch-grill-me 不会被引用，不提示。
    expect(warn).not.toHaveTextContent("batch-grill-me");
  });

  it("开关开启且 batch-grill-me 未安装时，两条提示并列", async () => {
    mockBackendWithInstalls({ batch_grill_enabled: true }, {});
    renderPanel();

    const warn = await screen.findByRole("status");
    expect(warn).toHaveTextContent("yunxiao-issue-execution");
    expect(warn).toHaveTextContent("batch-grill-me");
  });

  it("仅在缺失该技能的 Agent 上提示", async () => {
    // claude 缺 direct-execution，codex/dsh 已装 → 只提示 Claude Code。
    mockBackendWithInstalls({}, {
      "yunxiao-issue-execution": [{ agent: "codex" }, { agent: "dsh" }],
      "batch-grill-me": [{ agent: "claude" }, { agent: "codex" }, { agent: "dsh" }],
    });
    renderPanel();

    const warn = await screen.findByRole("status");
    expect(warn).toHaveTextContent("Claude Code");
    expect(warn).not.toHaveTextContent("Codex");
  });

  it("broken 安装不算已安装（仍提示）", async () => {
    const installs = allInstalled() as Record<string, Array<{ agent: string; health?: string }>>;
    installs["yunxiao-issue-execution"] = [
      { agent: "claude", health: "broken" },
      { agent: "codex" },
      { agent: "dsh" },
    ];
    mockBackendWithInstalls({}, installs);
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

    await screen.findByRole("switch", { name: "Batch Grill" });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
