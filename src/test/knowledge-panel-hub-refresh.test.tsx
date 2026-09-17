import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { KnowledgePanel } from "../components/knowledge/KnowledgePanel";

const invokeMock = vi.fn();
/** 捕获注册的 Tauri 事件回调，供测试手动触发。 */
let hubChangedHandler: (() => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: () => void) => {
    if (event === "skill-hub-changed") hubChangedHandler = handler;
    return Promise.resolve(() => {
      hubChangedHandler = null;
    });
  },
}));

function renderPanel() {
  return render(
    <I18nProvider>
      <KnowledgePanel projectPath="C:\\project" onOpenCard={() => {}} />
    </I18nProvider>,
  );
}

describe("KnowledgePanel 监听技能库变更", () => {
  beforeEach(() => {
    hubChangedHandler = null;
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_project_config") {
        return Promise.resolve({ knowledge: { graph_id: "HIS" } });
      }
      if (command === "list_knowledge_targets") {
        return Promise.resolve([
          { id: "HIS", name: "HIS", adapter: "dotnet", ready: true, scanAvailable: true },
        ]);
      }
      if (command === "list_knowledge_cards") {
        return Promise.resolve([
          { module: "Hsp.Register", content: "# Register\n", modified: false },
        ]);
      }
      if (command === "list_modified_knowledge_cards") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    hubChangedHandler = null;
  });

  it("注册 skill-hub-changed 监听并在事件到达时重新读取卡片", async () => {
    renderPanel();
    // 卡片按 `splitModule` 拆成 name + namespace 渲染，故用 aria-label（完整模块名）定位。
    await screen.findByLabelText("Hsp.Register");
    // 首次挂载触发一轮读取。
    const before = invokeMock.mock.calls.filter((call) => call[0] === "list_knowledge_cards").length;
    expect(before).toBeGreaterThan(0);
    await waitFor(() => expect(hubChangedHandler).not.toBeNull());

    // 事件到达（如后台 15 分钟拉取到新提交）后应再次读取卡片。
    hubChangedHandler?.();

    await waitFor(() => {
      const after = invokeMock.mock.calls.filter(
        (call) => call[0] === "list_knowledge_cards",
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
