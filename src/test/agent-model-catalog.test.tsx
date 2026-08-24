import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentModelCatalogSection } from "../components/app-settings/AgentModelCatalogSection";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "../components/app-settings/types";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function renderSection(agentKey: "claude" | "codex") {
  return render(
    <I18nProvider>
      <AgentModelCatalogSection agentKey={agentKey} />
    </I18nProvider>,
  );
}

describe("AgentModelCatalogSection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("keeps Claude manual-only", async () => {
    invokeMock.mockResolvedValue(DEFAULT_APP_SETTINGS);
    renderSection("claude");

    expect(await screen.findByText(/manual only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync" })).not.toBeInTheDocument();
  });

  it("auto-syncs the Codex catalog on mount when not initialized", async () => {
    const initialized: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      codex_model_catalog: {
        initialized: true,
        sourceVersion: "0.144.0",
        models: [
          {
            model: "gpt-example",
            label: "GPT Example",
            reasoningEfforts: ["low", "high"],
          },
        ],
      },
    };
    let currentSettings = DEFAULT_APP_SETTINGS;
    invokeMock.mockImplementation((command: string) => {
      if (command === "refresh_agent_model_catalog") {
        currentSettings = initialized;
      }
      return Promise.resolve(currentSettings);
    });
    renderSection("codex");

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("refresh_agent_model_catalog", {
        agent: "codex",
      }),
    );
    expect(screen.getByDisplayValue("gpt-example")).toBeInTheDocument();
    // 同步成功后，同步按钮仍然保留，便于手动刷新
    expect(screen.getByRole("button", { name: "Sync" })).toBeInTheDocument();
  });

  it("manual Sync button re-syncs even after the catalog is initialized", async () => {
    const catalog: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      codex_model_catalog: {
        initialized: true,
        initializedAt: Date.now(),
        sourceVersion: "0.144.0",
        models: [
          {
            model: "gpt-example",
            label: "GPT Example",
            reasoningEfforts: ["low", "high"],
          },
        ],
      },
    };
    invokeMock.mockResolvedValue(catalog);
    const user = userEvent.setup();
    renderSection("codex");

    // 已初始化且未过期：挂载时不自动触发
    await screen.findByDisplayValue("gpt-example");
    expect(invokeMock).not.toHaveBeenCalledWith("refresh_agent_model_catalog", {
      agent: "codex",
    });

    await user.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("refresh_agent_model_catalog", {
        agent: "codex",
      }),
    );
  });
});
