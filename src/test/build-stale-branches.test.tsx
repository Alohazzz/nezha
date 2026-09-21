import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuildPanel } from "../components/build/BuildPanel";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
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

/** 清理按钮在仓库列表加载完（勾选非空）之前是 disabled 的，此时点击会被忽略。
 *  面板外壳先于 `load()` 完成渲染，所以必须等按钮真正可用再点，否则测试结果
 *  取决于微任务时序（CI 上偶发「找不到结果文案」）。 */
async function clickPruneWhenReady() {
  const button = await screen.findByRole("button", { name: /清理失效分支/ });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return button;
}

describe("BuildPanel stale branch cleanup", () => {
  beforeEach(() => {
    invokeMock.mockReset();
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
    renderPanel();

    // 清理前分支菜单里有 fix/old
    expect(await screen.findByText("仓库拉取")).toBeInTheDocument();
    fireEvent.click(screen.getByText("main"));
    expect(await screen.findByText("fix/old")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("fix/old")).not.toBeInTheDocument();

    await clickPruneWhenReady();

    // 先 dry-run 扫描 → 弹确认 → 再真删
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("build_prune_stale_branches", {
        projectPath: "/workspace/HIS",
        selected: ["HIS"],
        dryRun: true,
      });
    });    // 确认框只列将要删除的候选，不列跳过的分支
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("fix/old");
    expect(dialog.textContent).not.toContain("fix/wip");
    // 此时尚未真删，只有 dry-run 那次调用
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "build_prune_stale_branches" && (args as { dryRun?: boolean }).dryRun === false,
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /删除 1 个分支/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("build_prune_stale_branches", {
        projectPath: "/workspace/HIS",
        selected: ["HIS"],
        dryRun: false,
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

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

    await clickPruneWhenReady();

    expect(await screen.findByText(/没有可清理的失效分支/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    renderPanel();

    await clickPruneWhenReady();

    // 用户点「取消」→ 弹层关闭且不触发真删
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "build_prune_stale_branches" && (args as { dryRun?: boolean }).dryRun === false,
      ),
    ).toHaveLength(0);
  });
});
