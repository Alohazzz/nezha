import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PermissionMode } from "../types";

export async function readProjectPermissionMode(projectPath: string): Promise<PermissionMode> {
  try {
    const config = await invoke<{ agent?: { default_permission_mode?: string } }>(
      "read_project_config", { projectPath },
    );
    const mode = config?.agent?.default_permission_mode;
    return mode === "full_access" || mode === "auto_edit" ? mode : "ask";
  } catch (error) {
    console.warn("read project default permission failed", error);
    return "ask";
  }
}

/** Project config is the default for plan execution; per-dialog overrides stay local. */
export function useProjectPermissionMode(projectPath: string) {
  const [state, setState] = useState({ projectPath: "", permissionMode: "ask" as PermissionMode });
  useEffect(() => {
    let active = true;
    void readProjectPermissionMode(projectPath).then((permissionMode) => {
      if (active) setState({ projectPath, permissionMode });
    });
    return () => { active = false; };
  }, [projectPath]);
  return {
    permissionMode: state.projectPath === projectPath ? state.permissionMode : "ask" as PermissionMode,
    ready: state.projectPath === projectPath,
  };
}
