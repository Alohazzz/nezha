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
    expect(screen.queryByRole("button", { name: "Initialize once" })).not.toBeInTheDocument();
  });

  it("offers Codex initialization only until the first successful import", async () => {
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
      if (command === "initialize_agent_model_catalog") {
        currentSettings = initialized;
      }
      return Promise.resolve(currentSettings);
    });
    const user = userEvent.setup();
    renderSection("codex");

    await user.click(await screen.findByRole("button", { name: "Initialize once" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Initialize once" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByDisplayValue("gpt-example")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("initialize_agent_model_catalog", {
      agent: "codex",
    });
  });
});
