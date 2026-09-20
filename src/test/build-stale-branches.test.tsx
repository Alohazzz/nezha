import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuildPanel } from "../components/build/BuildPanel";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(async () => true),
}));

type PruneItem = {
  branch: string;
  deleted: boolean;
  deletable: boolean;
  reason: string;
};

function repoResult(branches: PruneItem[]) {
  return {
    name: "HIS",
    path: "/workspace/HIS",
    ok: true,
    message: "",
    branches,
  };
}

/** BuildPanel 初始加载所需的最小命令 mock；prune 结果按 dry-run 与否分别返回。 */
function mockCommands(prune: (dryRun: boolean) => unknown) {
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "discover_build_repos":
        return Promise.resolve([
          {
            name: "HIS",
            path: "/workspace/HIS",
            remote: "https://example.com/HIS.git",
            branch: "main",
            branches: ["main", "fix/old", "fix/wip"],
            remote_branches: ["origin/other"],
            is_submodule: false,
            dirty: false,
            missing: false,
          },
        ]);
      case "read_build_config":
        return Promise.resolve({
          script_path: "",
          msbuild_path: "",
          solution: "Hsp v2.0.sln",
          configuration: "Debug",
          platform: "AnyCPU",
          external_dll_dir: "",
          skip_external_check: false,
          skip_restore: false,
          skip_clean: false,
          default_branch: "",
          max_parallel: 2,
        });
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
      case "build_prune_stale_branches":
        return Promise.resolve(prune(Boolean(args?.dryRun)));
      default:
        return Promise.resolve(null);
    }
  });
}

const renderPanel = () =>
  render(
    <I18nProvider>
      <BuildPanel projectPath="/workspace/HIS" width={400} />
    </I18nProvider>,
  );

describe("BuildPanel stale branch cleanup", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(confirm).mockReset();
  });

  it("deletes confirmed stale branches and drops them from the branch menu", async () => {
    mockCommands((dryRun) =>
      dryRun
        ? [
            repoResult([
              { branch: "fix/old", deleted: false, deletable: true, reason: "已合入 origin/main" },
              {
                branch: "fix/wip",
                deleted: false,
                deletable: false,
                reason: "提交未合入任何远端分支（可能有未提交内容），已跳过",
              },
            ]),
          ]
        : [
            repoResult([
              {
                branch: "fix/old",
                deleted: true,
                deletable: true,
                reason: "已删除（已合入 origin/main）",
              },
              {
                branch: "fix/wip",
                deleted: false,
                deletable: false,
                reason: "提交未合入任何远端分支（可能有未提交内容），已跳过",
              },
            ]),
          ],
    );
    vi.mocked(confirm).mockResolvedValue(true);
    renderPanel();

    // 清理前分支菜单里有 fix/old
    expect(await screen.findByText("仓库拉取")).toBeInTheDocument();
    fireEvent.click(screen.getByText("main"));
    expect(await screen.findByText("fix/old")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("fix/old")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /清理失效分支/ }));

    // 先 dry-run 扫描 → 弹确认 → 再真删
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("build_prune_stale_branches", {
        projectPath: "/workspace/HIS",
        selected: ["HIS"],
        dryRun: true,
      });
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("build_prune_stale_branches", {
        projectPath: "/workspace/HIS",
        selected: ["HIS"],
        dryRun: false,
      });
    });
    // 确认框只列将要删除的候选，不列跳过的分支
    const prompt = vi.mocked(confirm).mock.calls[0][0] as string;
    expect(prompt).toContain("HIS:fix/old");
    expect(prompt).not.toContain("fix/wip");

    expect(await screen.findByText(/✓ 已删除 HIS:fix\/old/)).toBeInTheDocument();
    expect(screen.getByText(/跳过 HIS:fix\/wip/)).toBeInTheDocument();

    // 已删除的分支从下拉菜单消失，未删除的仍在
    fireEvent.click(screen.getByText("main"));
    expect(await screen.findByText("本地")).toBeInTheDocument();
    expect(screen.queryByText("fix/old")).not.toBeInTheDocument();
    expect(screen.getByText("fix/wip")).toBeInTheDocument();
  });

  it("does not ask for confirmation when nothing is deletable", async () => {
    mockCommands(() => [
      repoResult([
        {
          branch: "fix/wip",
          deleted: false,
          deletable: false,
          reason: "提交未合入任何远端分支（可能有未提交内容），已跳过",
        },
      ]),
    ]);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /清理失效分支/ }));

    expect(await screen.findByText(/没有可清理的失效分支/)).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "build_prune_stale_branches"),
    ).toHaveLength(1);
  });

  it("keeps branches when the confirmation is declined", async () => {
    mockCommands((dryRun) =>
      dryRun
        ? [
            repoResult([
              { branch: "fix/old", deleted: false, deletable: true, reason: "已合入 origin/main" },
            ]),
          ]
        : [],
    );
    vi.mocked(confirm).mockResolvedValue(false);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /清理失效分支/ }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "build_prune_stale_branches" && (args as { dryRun?: boolean }).dryRun === false,
      ),
    ).toHaveLength(0);
  });
});
