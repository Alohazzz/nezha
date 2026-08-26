import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BuildPanel } from "../components/build/BuildPanel";

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

describe("BuildPanel branch switching", () => {
  it("does not re-run full repo discovery after switching a single branch, and keeps hidden submodules hidden", async () => {
    let discoverCalls = 0;
    const checkout = deferred<void>();
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "discover_build_repos":
          discoverCalls += 1;
          // Root repo is visible; "OtherSub" is a submodule not matching the visible filter.
          return Promise.resolve([
            buildRepo(),
            buildRepo({ name: "OtherSub", path: "/workspace/HIS/OtherSub", is_submodule: true }),
          ]);
        case "build_checkout_branch":
          return checkout.promise;
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
        default:
          return Promise.resolve(null);
      }
    });

    render(<BuildPanel projectPath="/workspace/HIS" width={400} />);

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
      checkout.resolve(undefined);
      await Promise.resolve();
    });

    // The switched repo updates in place; full discovery is NOT re-run.
    expect(discoverCalls).toBe(initialDiscoverCalls);
    expect(screen.queryByText("OtherSub")).not.toBeInTheDocument();
    expect(await screen.findByText("main")).toBeInTheDocument();
  });
});
