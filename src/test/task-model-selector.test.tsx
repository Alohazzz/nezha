import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TaskModelSelector } from "../components/new-task/TaskModelSelector";
import { I18nProvider } from "../i18n";

const catalog = {
  initialized: true,
  models: [
    {
      model: "provider/model:deployment",
      label: "Production model",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    },
  ],
};

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

describe("TaskModelSelector", () => {
  it("passes opaque provider model identifiers through unchanged", async () => {
    const user = userEvent.setup();
    const onSetModel = vi.fn();
    render(
      <I18nProvider>
        <TaskModelSelector
          catalog={catalog}
          onSetModel={onSetModel}
          onSetReasoningEffort={vi.fn()}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Model: Agent default" }));
    await user.click(screen.getByRole("button", { name: "Model Agent default" }));
    await user.click(screen.getByRole("button", { name: /Production model/ }));

    expect(onSetModel).toHaveBeenCalledWith("provider/model:deployment");
  });

  it("shows configured thinking depths only after a model is selected", async () => {
    const user = userEvent.setup();
    const onSetReasoningEffort = vi.fn();
    render(
      <I18nProvider>
        <TaskModelSelector
          catalog={catalog}
          model="provider/model:deployment"
          onSetModel={vi.fn()}
          onSetReasoningEffort={onSetReasoningEffort}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Model: Production model" }));
    await user.click(screen.getByRole("button", { name: "Thinking Auto" }));
    await user.click(screen.getByRole("button", { name: "high" }));

    expect(onSetReasoningEffort).toHaveBeenCalledWith("high");
  });

  it("combines the selected model and thinking depth in one toolbar trigger", () => {
    render(
      <I18nProvider>
        <TaskModelSelector
          catalog={catalog}
          model="provider/model:deployment"
          reasoningEffort="high"
          onSetModel={vi.fn()}
          onSetReasoningEffort={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Model: Production model high" }),
    ).toBeInTheDocument();
  });
});
