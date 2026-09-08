import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BuildPanel } from "../components/build/BuildPanel";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

function buildRepo(overrides: Partial<{
  name: string;
  path: string;
  branch: string;
  branches: string[];
  remote_branches: string[];
  is_submodule: boolean;
  dirty: boolean;
  missing: boolean;
}> = {}) {
  return {
    name: "HIS",
    path: "/workspace/HIS",
    remote: "https://example.com/HIS.git",
    branch: "",
    branches: ["main", "dev"],
    remote_branches: [],
    is_submodule: false,
    dirty: false,
    missing: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** BuildPanel 初始加载所需的最小命令 mock；各测试可对关心的命令覆盖。 */
function panelCommandDefaults(): Record<string, () => unknown> {
  return {
    read_build_config: () => ({
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
    }),
    read_build_state: () => ({ last_built: {} }),
    read_project_config: () => ({ agent: { default: "claude", default_permission_mode: "ask" } }),
    read_build_fix_status: () => [],
    read_build_plan: () => null,
    get_running_builds: () => [],
  };
}

/** 合并默认 mock 与各测试覆盖项：覆盖项为命令 -> 返回值/Promise。 */
function mockPanelCommands(overrides: Record<string, (cmd: string) => unknown> = {}) {
  const defaults = panelCommandDefaults();
  invokeMock.mockImplementation((command: string) => {
    const override = overrides[command];
    if (override) return override(command);
    const def = defaults[command];
    if (def) return Promise.resolve(def());
    return Promise.resolve(null);
  });
}

describe("BuildPanel branch switching", () => {
  it("does not re-run full repo discovery after switching a single branch, and keeps hidden submodules hidden", async () => {
    let discoverCalls = 0;
    const checkout = deferred<string>();
    mockPanelCommands({
      discover_build_repos: () => {
        discoverCalls += 1;
        // Root repo is visible; "OtherSub" is a submodule not matching the visible filter.
        return Promise.resolve([
          buildRepo(),
          buildRepo({ name: "OtherSub", path: "/workspace/HIS/OtherSub", is_submodule: true }),
        ]);
      },
      build_checkout_branch: () => checkout.promise,
    });

    render(
      <I18nProvider>
        <BuildPanel projectPath="/workspace/HIS" width={400} />
      </I18nProvider>,
    );

    // Initial load: only the visible root repo renders, hidden submodule stays away.
    expect(await screen.findByText("选择分支")).toBeInTheDocument();
    expect(screen.queryByText("OtherSub")).not.toBeInTheDocument();
    const initialDiscoverCalls = discoverCalls;

    // Open the branch menu and switch to "main".
    fireEvent.click(screen.getByText("选择分支"));
    fireEvent.click(await screen.findByText("main"));

    expect(invokeMock).toHaveBeenCalledWith("build_checkout_branch", {
      projectPath: "/workspace/HIS",
      repoPath: "/workspace/HIS",
      branch: "main",
    });

    // Let the checkout succeed and any post-switch work settle.
    await act(async () => {
      checkout.resolve("main");
      await Promise.resolve();
    });

    // The switched repo updates in place; full discovery is NOT re-run.
    expect(discoverCalls).toBe(initialDiscoverCalls);
    expect(screen.queryByText("OtherSub")).not.toBeInTheDocument();
    expect(await screen.findByText("main")).toBeInTheDocument();
  });

  it("switches to a remote branch and promotes it to the local group after checkout", async () => {
    const checkout = deferred<string>();
    mockPanelCommands({
      discover_build_repos: () =>
        Promise.resolve([
          buildRepo({ branches: ["main"], remote_branches: ["origin/feature/x", "origin/hotfix"] }),
        ]),
      build_checkout_branch: () => checkout.promise,
    });

    render(
      <I18nProvider>
        <BuildPanel projectPath="/workspace/HIS" width={400} />
      </I18nProvider>,
    );

    expect(await screen.findByText("选择分支")).toBeInTheDocument();

    // Open the menu: remote branches are grouped under "远端".
    fireEvent.click(screen.getByText("选择分支"));
    fireEvent.click(await screen.findByText("origin/feature/x"));

    // The remote short name goes to the backend, which returns the landed local name.
    expect(invokeMock).toHaveBeenCalledWith("build_checkout_branch", {
      projectPath: "/workspace/HIS",
      repoPath: "/workspace/HIS",
      branch: "origin/feature/x",
    });

    await act(async () => {
      checkout.resolve("feature/x");
      await Promise.resolve();
    });

    // Trigger shows the landed local branch, not the remote ref.
    expect(screen.getByText("feature/x")).toBeInTheDocument();

    // Reopen: the landed branch moved into the local group, the remote entry is gone.
    fireEvent.click(screen.getByText("feature/x"));
    expect(await screen.findByText("本地")).toBeInTheDocument();
    expect(screen.getByText("远端")).toBeInTheDocument();
    expect(screen.queryByText("origin/feature/x")).not.toBeInTheDocument();
    expect(screen.queryByText("main")).toBeInTheDocument();
    expect(screen.getByText("origin/hotfix")).toBeInTheDocument();
  });

  it("filters local and remote branches by query", async () => {
    mockPanelCommands({
      discover_build_repos: () =>
        Promise.resolve([
          buildRepo({ branches: ["main", "dev"], remote_branches: ["origin/feature/x"] }),
        ]),
    });

    render(
      <I18nProvider>
        <BuildPanel projectPath="/workspace/HIS" width={400} />
      </I18nProvider>,
    );

    expect(await screen.findByText("选择分支")).toBeInTheDocument();

    fireEvent.click(screen.getByText("选择分支"));
    expect(await screen.findByText("main")).toBeInTheDocument();

    const filter = document.querySelector<HTMLInputElement>(".build-branch-filter");
    expect(filter).not.toBeNull();
    fireEvent.change(filter!, { target: { value: "feat" } });

    expect(screen.getByText("origin/feature/x")).toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.queryByText("dev")).not.toBeInTheDocument();

    // No match -> empty hint.
    fireEvent.change(filter!, { target: { value: "zzz" } });
    expect(screen.getByText("无匹配分支")).toBeInTheDocument();
  });
});
