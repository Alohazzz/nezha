import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { KnowledgeGraphPanel } from "../components/settings/KnowledgeGraphPanel";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function renderPanel() {
  return render(
    <I18nProvider>
      <KnowledgeGraphPanel projectPath="C:\\project" />
    </I18nProvider>,
  );
}

describe("KnowledgeGraphPanel", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "list_knowledge_targets") {
        return Promise.resolve([{ id: "HIS", name: "HIS 知识图谱", adapter: "his", ready: true, scanAvailable: true }]);
      }
      if (command === "list_knowledge_graph_adapters") {
        return Promise.resolve([{ id: "his", name: "HIS" }]);
      }
      if (command === "read_project_config") {
        return Promise.resolve({ knowledge: { graph_id: "HIS" } });
      }
      if (command === "list_knowledge_cards") {
        return Promise.resolve([
          { module: "Hsp.Register", content: "# Register\n", modified: false },
          { module: "io", content: "# io\n", modified: false },
        ]);
      }
      if (command === "save_knowledge_card") {
        return Promise.resolve(null);
      }
      if (command === "publish_knowledge_changes") {
        expect(args?.paths).toEqual(["data/modules/io.md"]);
        return Promise.resolve("已提交并推送");
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => invokeMock.mockReset());

  it("loads the bound graph, saves a card locally, and publishes saved changes", async () => {
    renderPanel();

    await waitFor(() => expect(screen.getAllByText("HIS 知识图谱").length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByRole("button", { name: /Manage cards/ }));
    await screen.findByText("io");
    fireEvent.click(screen.getByText("io"));
    await waitFor(() => expect(document.querySelector(".knowledge-card-source")).toBeTruthy());
    const editor = document.querySelector<HTMLTextAreaElement>(".knowledge-card-source");
    if (!editor) throw new Error("card editor not found");
    fireEvent.change(editor, { target: { value: "# io\n\n_updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved io")).toBeTruthy());

    const publish = screen.getByRole("button", { name: "Commit & push (1)" });
    fireEvent.click(publish);
    await waitFor(() => expect(screen.getByText("已提交并推送")).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith("publish_knowledge_changes", {
      graphId: "HIS",
      paths: ["data/modules/io.md"],
      message: "docs(knowledge): update HIS graph",
    });
  });

  it("shows the initialize skeleton button when the bound graph is not ready", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_knowledge_targets") {
        return Promise.resolve([{ id: "HIS", name: "HIS 知识图谱", adapter: "his", ready: false, scanAvailable: false }]);
      }
      if (command === "list_knowledge_graph_adapters") {
        return Promise.resolve([{ id: "his", name: "HIS" }]);
      }
      if (command === "read_project_config") {
        return Promise.resolve({ knowledge: { graph_id: "HIS" } });
      }
      if (command === "list_knowledge_cards") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    renderPanel();

    await waitFor(() => expect(screen.getAllByText("HIS 知识图谱").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /Initialize skeleton/ })).toBeTruthy();
  });

  it("does not pre-select the HIS adapter when creating a graph", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_knowledge_targets") return Promise.resolve([]);
      if (command === "list_knowledge_graph_adapters") {
        return Promise.resolve([
          { id: "his", name: "HIS" },
          { id: "icucis", name: "ICUCIS" },
        ]);
      }
      if (command === "read_project_config") return Promise.resolve({ knowledge: { graph_id: "" } });
      return Promise.resolve(null);
    });

    renderPanel();

    // 适配器下拉默认显示占位符，而不是 HIS。
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Choose adapter" })).toBeTruthy());
    // 未选择适配器时创建按钮保持禁用。
    const create = screen.getByRole("button", { name: "Create" });
    expect(create.hasAttribute("disabled")).toBe(true);
  });
});
