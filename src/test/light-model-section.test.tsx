import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LightModelSection } from "../components/app-settings/LightModelSection";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../components/app-settings/types";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// jsdom 缺少 Radix Select 交互所需的 pointer capture API。
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function renderSection(agentKey: "claude" | "codex") {
  return render(
    <I18nProvider>
      <LightModelSection agentKey={agentKey} />
    </I18nProvider>,
  );
}

function withCatalog(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    claude_model_catalog: {
      initialized: true,
      models: [
        { model: "fast-model", label: "Fast Model", reasoningEfforts: ["low", "high"] },
        { model: "no-effort-model", label: "No Effort", reasoningEfforts: [] },
      ],
    },
    ...overrides,
  };
}

describe("LightModelSection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("defaults to following the agent model and disables effort picker", async () => {
    invokeMock.mockResolvedValue(withCatalog());
    renderSection("claude");

    expect(await screen.findByText("Follow agent default")).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking depth")).toBeDisabled();
  });

  it("persists a chosen light model", async () => {
    invokeMock.mockResolvedValue(withCatalog());
    const user = userEvent.setup();
    renderSection("claude");

    await user.click(await screen.findByLabelText("Model"));
    await user.click(await screen.findByRole("option", { name: "Fast Model" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_light_model_config", {
        agent: "claude",
        model: "fast-model",
        reasoningEffort: null,
      }),
    );
  });

  it("persists a thinking depth for the selected model", async () => {
    invokeMock.mockResolvedValue(withCatalog({ claude_light_model: "fast-model" }));
    const user = userEvent.setup();
    renderSection("claude");

    await user.click(await screen.findByLabelText("Thinking depth"));
    await user.click(await screen.findByRole("option", { name: "low" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_light_model_config", {
        agent: "claude",
        model: "fast-model",
        reasoningEffort: "low",
      }),
    );
  });

  it("clears the light model when following the agent default is picked", async () => {
    invokeMock.mockResolvedValue(
      withCatalog({ claude_light_model: "fast-model", claude_light_reasoning_effort: "low" }),
    );
    const user = userEvent.setup();
    renderSection("claude");

    await user.click(await screen.findByLabelText("Model"));
    await user.click(await screen.findByRole("option", { name: "Follow agent default" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_light_model_config", {
        agent: "claude",
        model: null,
        reasoningEffort: null,
      }),
    );
  });

  it("disables effort picker for models without configured efforts", async () => {
    invokeMock.mockResolvedValue(withCatalog({ claude_light_model: "no-effort-model" }));
    renderSection("claude");

    expect(await screen.findByLabelText("Thinking depth")).toBeDisabled();
  });
});
