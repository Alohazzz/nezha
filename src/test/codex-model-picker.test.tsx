import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexModelPicker } from "../components/codex-stream/CodexModelPicker";
import { DEFAULT_APP_SETTINGS } from "../components/app-settings/types";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const staleCatalog = {
  initialized: true,
  models: [{ model: "deepseek-flash", reasoningEfforts: ["high"] }],
};
const currentSettings = {
  ...DEFAULT_APP_SETTINGS,
  codex_model_catalog: {
    initialized: true,
    models: [{ model: "gpt-example", reasoningEfforts: ["low", "high"] }],
  },
};

function renderPicker(model?: string) {
  const onSetModel = vi.fn();
  render(
    <I18nProvider>
      <CodexModelPicker
        view="models"
        catalog={staleCatalog}
        model={model}
        onClose={vi.fn()}
        onSetModel={onSetModel}
        onSetEffort={vi.fn()}
      />
    </I18nProvider>,
  );
  return onSetModel;
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

describe("CodexModelPicker after switching authentication", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("refreshes the account catalog and lets a failed thread choose a supported model", async () => {
    invokeMock.mockResolvedValue(currentSettings);
    const onSetModel = renderPicker("deepseek-flash");

    await userEvent.click(await screen.findByRole("button", { name: "gpt-example" }));

    expect(invokeMock).toHaveBeenCalledWith("refresh_agent_model_catalog", { agent: "codex" });
    expect(onSetModel).toHaveBeenCalledWith("gpt-example");
    expect(screen.queryByRole("button", { name: "deepseek-flash" })).not.toBeInTheDocument();
  });

  it("does not offer stale provider models while the current account is loading", () => {
    invokeMock.mockReturnValue(new Promise(() => {}));
    renderPicker();
    expect(screen.queryByRole("button", { name: "deepseek-flash" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows a retry when discovery fails instead of silently using stale models", async () => {
    invokeMock.mockRejectedValueOnce(new Error("discovery unavailable"));
    invokeMock.mockResolvedValue(currentSettings);
    renderPicker();

    expect(await screen.findByRole("alert")).toHaveTextContent("discovery unavailable");
    expect(screen.queryByRole("button", { name: "deepseek-flash" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "gpt-example" })).toBeEnabled());
  });
});
