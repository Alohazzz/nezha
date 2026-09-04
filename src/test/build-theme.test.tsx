import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BuildPanel } from "../components/build/BuildPanel";
import { BranchBatchView } from "../components/branch-batch/BranchBatchView";
import { KnowledgePanel } from "../components/knowledge/KnowledgePanel";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(async () => false),
}));

/** 右侧面板统一的样式守护：
 *  构建 / PR / 知识库三个面板与 GitHistory、GitChanges 共用同一套设计语言，
 *  面板根必须挂 `rp-root`（bg-sidebar + border-left + 统一宽度变量），
 *  头部必须是 `rp-titlebar`（48px 标题栏），不允许再各画各的。 */
function assertSharedPanelChrome(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>(".rp-root");
  expect(root, "panel root must use the shared .rp-root chrome").not.toBeNull();
  expect(root!.querySelector(".rp-titlebar"), "panel header must use .rp-titlebar").not.toBeNull();
  // 宽度经由 --rp-width 变量注入，而不是散落的内联样式
  expect(root!.getAttribute("style")).toContain("--rp-width");
}

describe("Right panels share the unified design language", () => {
  it("BuildPanel renders the shared panel chrome", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "discover_build_repos":
          return Promise.resolve([]);
        case "read_build_config":
          return Promise.resolve(null);
        case "read_build_state":
          return Promise.resolve({ last_built: {} });
        case "read_project_config":
          return Promise.resolve({ agent: { default: "claude", default_permission_mode: "ask" } });
        case "read_build_fix_status":
          return Promise.resolve([]);
        case "read_build_plan":
          return Promise.resolve(null);
        case "get_running_builds":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    const { container } = render(
      <I18nProvider>
        <BuildPanel projectPath="/workspace/HIS" width={320} />
      </I18nProvider>,
    );

    await screen.findByText("仓库拉取");
    assertSharedPanelChrome(container);
  });

  it("BranchBatchView (PR) renders the shared panel chrome", async () => {
    invokeMock.mockImplementation(() => Promise.resolve([]));

    const { container } = render(
      <I18nProvider>
        <BranchBatchView
          projectPath="/workspace/HIS"
          projectId="p1"
          repoPath="/workspace/HIS"
          shellOpen={false}
          tasks={[]}
          worktreeScope=""
          onScopeChange={() => {}}
          onClose={() => {}}
          width={320}
        />
      </I18nProvider>,
    );

    await screen.findByText("PR");
    assertSharedPanelChrome(container);
  });

  it("KnowledgePanel renders the shared panel chrome", async () => {
    invokeMock.mockImplementation(() => Promise.resolve([]));

    const { container } = render(
      <I18nProvider>
        <KnowledgePanel projectPath="/workspace/HIS" onOpenCard={() => {}} width={320} />
      </I18nProvider>,
    );

    // 标题文案随 i18n 语言变化，这里断言结构而不是文案
    await screen.findByRole("button", { name: /commit & push|提交并推送/i });
    assertSharedPanelChrome(container);
  });
});
