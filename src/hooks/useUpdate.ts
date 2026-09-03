import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpdateInfo } from "../types";

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 与通知 6h 轮询一致
const LAST_NOTIFIED_KEY = "nezha:last-update-notified";

/** AboutPanel 手动「检查更新」通过该 DOM 事件触发控制器重新检查并打开弹窗。 */
export const OPEN_UPDATE_DIALOG_EVENT = "nezha:open-update-dialog";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "upToDate"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export function useUpdate() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  const pendingPathRef = useRef("");

  const dialogOpenRef = useRef(false);
  const [dialogOpen, setDialogOpenState] = useState(false);

  const openDialog = useCallback(() => {
    dialogOpenRef.current = true;
    setDialogOpenState(true);
  }, []);

  const closeDialog = useCallback(() => {
    dialogOpenRef.current = false;
    setDialogOpenState(false);
  }, []);

  const setDialogOpen = useCallback((open: boolean) => {
    dialogOpenRef.current = open;
    setDialogOpenState(open);
  }, []);

  const notifyOncePerVersion = useCallback((version: string) => {
    try {
      const last = window.localStorage.getItem(LAST_NOTIFIED_KEY) ?? "";
      if (version && version !== last) {
        window.localStorage.setItem(LAST_NOTIFIED_KEY, version);
        void invoke("notify_update_available", { version }).catch(() => {});
      }
    } catch {
      // localStorage 不可用时静默降级为仅 app 内横幅。
    }
  }, []);

  const checkForUpdate = useCallback(
    async (openIfAvailable = false) => {
      setChecking(true);
      setError(null);
      try {
        const result = await invoke<UpdateInfo | null>("check_for_update");
        if (result) {
          setInfo(result);
          setPhase("available");
          setBannerDismissed(false);
          setProgress(0);
          notifyOncePerVersion(result.version);
          if (openIfAvailable) {
            openDialog();
          }
        } else {
          setInfo(null);
          setPhase("upToDate");
          setProgress(0);
          if (openIfAvailable) {
            openDialog();
          }
        }
      } catch (err) {
        setError(String(err));
        setPhase("error");
        if (openIfAvailable) {
          openDialog();
        }
      } finally {
        setChecking(false);
      }
    },
    [notifyOncePerVersion, openDialog],
  );

  // 启动 + 每 6h 轮询；发现更新时自动推送系统通知（后端判断前台则跳过）。
  useEffect(() => {
    void checkForUpdate();
    const interval = setInterval(() => void checkForUpdate(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkForUpdate]);

  // Tauri 系统通知点击 → 唤起窗口并打开升级弹窗。
  useEffect(() => {
    const unlisten = listen("open_update_dialog", () => {
      if (!dialogOpenRef.current) {
        void checkForUpdate(true);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [checkForUpdate]);

  // AboutPanel 手动「检查更新」→ 刷新并打开弹窗。
  useEffect(() => {
    const handler = () => {
      void checkForUpdate(true);
    };
    window.addEventListener(OPEN_UPDATE_DIALOG_EVENT, handler);
    return () => window.removeEventListener(OPEN_UPDATE_DIALOG_EVENT, handler);
  }, [checkForUpdate]);

  const downloadAndInstall = useCallback(async () => {
    if (!info?.asset || !info.asset.supported) return;
    setError(null);
    setProgress(0);
    setPhase("downloading");
    const channel = new Channel<number>();
    channel.onmessage = (p) => setProgress(Math.max(0, Math.min(1, p)));
    try {
      const installPath = await invoke<string>("download_update", {
        url: info.asset.url,
        digest: info.asset.digest,
        filename: info.asset.name,
        onProgress: channel,
      });
      // 记录安装路径供确认后拉起。
      pendingPathRef.current = installPath;
      const active = await invoke<string[]>("get_active_task_ids");
      setActiveCount(active.length);
      setPhase("ready");
    } catch (err) {
      setError(String(err));
      setPhase("error");
    }
  }, [info]);

  const confirmInstall = useCallback(async (force: boolean) => {
    const path = pendingPathRef.current;
    if (!path) return;
    setPhase("installing");
    try {
      await invoke("launch_update_installer", { installerPath: path, force });
      // app 即将退出，正常无需后续处理。
    } catch (err) {
      setError(String(err));
      setPhase("error");
    }
  }, []);

  const dismissBanner = useCallback(() => setBannerDismissed(true), []);

  const reset = useCallback(() => {
    setInfo(null);
    setPhase("idle");
    setProgress(0);
    setError(null);
    setBannerDismissed(false);
  }, []);

  return {
    info,
    phase,
    error,
    progress,
    activeCount,
    bannerDismissed,
    checking,
    dialogOpen,
    setDialogOpen,
    openDialog,
    closeDialog,
    checkForUpdate,
    downloadAndInstall,
    confirmInstall,
    dismissBanner,
    reset,
  };
}
