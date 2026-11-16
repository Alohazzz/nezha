import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n, type AppLanguage } from "../../i18n";
import {
  clampTerminalScrollback,
  TASK_DISPLAY_WINDOW_VALUES,
  TERMINAL_SCROLLBACK_STEP,
  type TaskDisplayWindow,
  type TaskRunMode,
  type TerminalScrollback,
} from "../../types";
import { APP_PLATFORM } from "../../platform";
import { APP_SETTINGS_CHANGED_EVENT, type AppSettings } from "./types";

export type GeneralPanelProps = {
  taskDisplayWindow: TaskDisplayWindow;
  onTaskDisplayWindowChange: (window: TaskDisplayWindow) => void;
  attentionBadge: boolean;
  onAttentionBadgeChange: (enabled: boolean) => void;
  terminalScrollback: TerminalScrollback;
  onTerminalScrollbackChange: (value: TerminalScrollback) => void;
};

export function useGeneralSettings({
  taskDisplayWindow,
  onTaskDisplayWindowChange,
  attentionBadge,
  onAttentionBadgeChange,
  terminalScrollback,
  onTerminalScrollbackChange,
}: GeneralPanelProps) {
  const { language, setLanguage, t } = useI18n();

  // 侧载 ConPTY 开关:仅 Windows 可改,其他平台展示为禁用态(让全平台用户
  // 知道有此能力)。仅后端启动时读取,面板内自包含加载/保存,不经由 App.tsx
  // 透传 props(其他面板拿到的 AppSettings 由 CHANGED 事件自行刷新)。
  const isConptyEditable = APP_PLATFORM === "windows";
  // null = 尚未从后端读到真实值(仅 Windows 需要读):渲染为关闭态,避免磁盘值
  // 为 false 时先闪一下「开启」。非 Windows 固定展示默认值 true 的禁用态。
  const [sideloadedConpty, setSideloadedConpty] = useState<boolean | null>(
    isConptyEditable ? null : true,
  );
  // 加载或保存进行中:禁用开关,防止保存期间连点(stale 闭包会连发同一值)
  const [conptyBusy, setConptyBusy] = useState(isConptyEditable);

  useEffect(() => {
    if (!isConptyEditable) return;
    let cancelled = false;
    invoke<AppSettings>("load_app_settings")
      .then((loaded) => {
        if (!cancelled) setSideloadedConpty(loaded.use_sideloaded_conpty);
      })
      .catch(() => {
        // 读取失败按后端默认值展示,保持开关可操作
        if (!cancelled) setSideloadedConpty(true);
      })
      .finally(() => {
        if (!cancelled) setConptyBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isConptyEditable]);

  const handleSideloadedConptyToggle = async () => {
    if (!isConptyEditable || conptyBusy || sideloadedConpty === null) return;
    const enabled = !sideloadedConpty;
    setSideloadedConpty(enabled);
    setConptyBusy(true);
    try {
      const next = await invoke<AppSettings>("save_use_sideloaded_conpty", { enabled });
      setSideloadedConpty(next.use_sideloaded_conpty);
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    } catch {
      setSideloadedConpty(!enabled);
    } finally {
      setConptyBusy(false);
    }
  };

  // 框选自动复制开关:与 ConPTY 同款自包含模式(面板内加载/保存,不经由
  // App.tsx 透传 props),保存后广播 CHANGED 事件,终端侧的单例监听随之刷新。
  // null = 尚未读到真实值,渲染为关闭态(与后端默认 false 一致,不会闪)。
  const [copyOnSelect, setCopyOnSelect] = useState<boolean | null>(null);
  const [copyOnSelectBusy, setCopyOnSelectBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>("load_app_settings")
      .then((loaded) => {
        if (!cancelled) setCopyOnSelect(loaded.terminal_copy_on_select);
      })
      .catch(() => {
        if (!cancelled) setCopyOnSelect(false);
      })
      .finally(() => {
        if (!cancelled) setCopyOnSelectBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyOnSelectToggle = async () => {
    if (copyOnSelectBusy || copyOnSelect === null) return;
    const enabled = !copyOnSelect;
    setCopyOnSelect(enabled);
    setCopyOnSelectBusy(true);
    try {
      const next = await invoke<AppSettings>("save_terminal_copy_on_select", { enabled });
      setCopyOnSelect(next.terminal_copy_on_select);
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    } catch {
      setCopyOnSelect(!enabled);
    } finally {
      setCopyOnSelectBusy(false);
    }
  };

  const copyOnSelectOn = copyOnSelect === true;

  // 系统通知开关：与框选复制同款自包含模式（后端持久化到 settings.json）。
  const [systemNotifications, setSystemNotifications] = useState<boolean | null>(null);
  const [systemNotificationsBusy, setSystemNotificationsBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>("load_app_settings")
      .then((loaded) => {
        if (!cancelled) setSystemNotifications(loaded.system_notifications);
      })
      .catch(() => {
        // 读取失败按后端默认值展示,保持开关可操作
        if (!cancelled) setSystemNotifications(true);
      })
      .finally(() => {
        if (!cancelled) setSystemNotificationsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSystemNotificationsToggle = async () => {
    if (systemNotificationsBusy || systemNotifications === null) return;
    const enabled = !systemNotifications;
    setSystemNotifications(enabled);
    setSystemNotificationsBusy(true);
    try {
      const next = await invoke<AppSettings>("save_system_notifications", { enabled });
      setSystemNotifications(next.system_notifications);
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    } catch {
      setSystemNotifications(!enabled);
    } finally {
      setSystemNotificationsBusy(false);
    }
  };

  const systemNotificationsOn = systemNotifications === true;

  // Codex ask 模式工作区内免逐条审批（issue #120）：与系统通知开关同款自包含模式。
  const [codexAskInWorkspaceAutoApprove, setCodexAskInWorkspaceAutoApprove] = useState<boolean | null>(null);
  const [codexAskInWorkspaceAutoApproveBusy, setCodexAskInWorkspaceAutoApproveBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>("load_app_settings")
      .then((loaded) => {
        if (!cancelled) setCodexAskInWorkspaceAutoApprove(loaded.codex_ask_in_workspace_auto_approve);
      })
      .catch(() => {
        // 读取失败按后端默认值展示（关闭），保持开关可操作
        if (!cancelled) setCodexAskInWorkspaceAutoApprove(false);
      })
      .finally(() => {
        if (!cancelled) setCodexAskInWorkspaceAutoApproveBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCodexAskInWorkspaceAutoApproveToggle = async () => {
    if (codexAskInWorkspaceAutoApproveBusy || codexAskInWorkspaceAutoApprove === null) return;
    const enabled = !codexAskInWorkspaceAutoApprove;
    setCodexAskInWorkspaceAutoApprove(enabled);
    setCodexAskInWorkspaceAutoApproveBusy(true);
    try {
      const next = await invoke<AppSettings>("save_codex_ask_in_workspace_auto_approve", { enabled });
      setCodexAskInWorkspaceAutoApprove(next.codex_ask_in_workspace_auto_approve);
    } catch {
      setCodexAskInWorkspaceAutoApprove(!enabled);
    } finally {
      setCodexAskInWorkspaceAutoApproveBusy(false);
    }
  };

  const codexAskInWorkspaceAutoApproveOn = codexAskInWorkspaceAutoApprove === true;

  // Codex 运行通道全局设置：自包含模式（面板内加载/保存，广播 CHANGED 让
  // App.tsx 的任务创建状态同步）。structured 有版本地板（codex ≥ 0.156）：
  // null = 探测中，探测失败（含未安装）视为不支持；不支持时自愈回 pty。
  const [codexRunMode, setCodexRunMode] = useState<TaskRunMode | null>(null);
  const [codexRunModeBusy, setCodexRunModeBusy] = useState(true);
  const [structuredSupported, setStructuredSupported] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>("load_app_settings")
      .then((loaded) => {
        if (cancelled) return;
        setCodexRunMode(
          loaded.codex_run_mode === "structured" ? "structured" : "pty",
        );
      })
      .catch(() => {
        if (!cancelled) setCodexRunMode("pty");
      })
      .finally(() => {
        if (!cancelled) setCodexRunModeBusy(false);
      });
    invoke<boolean>("codex_structured_supported")
      .then((ok) => {
        if (!cancelled) setStructuredSupported(ok);
      })
      .catch(() => {
        if (!cancelled) setStructuredSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCodexRunModeChange = async (value: TaskRunMode) => {
    if (codexRunModeBusy) return;
    setCodexRunMode(value);
    setCodexRunModeBusy(true);
    try {
      const next = await invoke<AppSettings>("save_codex_run_mode", { runMode: value });
      setCodexRunMode(next.codex_run_mode === "structured" ? "structured" : "pty");
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    } catch {
      setCodexRunMode(value === "structured" ? "pty" : "structured");
    } finally {
      setCodexRunModeBusy(false);
    }
  };

  // 记忆值是 structured 但版本不支持（或探测失败）时自愈回 pty，避免提交后必走降级路径。
  useEffect(() => {
    if (structuredSupported === false && codexRunMode === "structured" && !codexRunModeBusy) {
      void handleCodexRunModeChange("pty");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuredSupported, codexRunMode, codexRunModeBusy]);

  const conptyOn = sideloadedConpty === true;
  const conptyDisabled = !isConptyEditable || conptyBusy;
  const conptyHint = isConptyEditable
    ? t("appSettings.sideloadedConptyHint")
    : t("appSettings.sideloadedConptyWindowsOnly") + t("appSettings.sideloadedConptyHint");

  const languageOptions: Array<{ value: AppLanguage; label: string }> = [
    { value: "en", label: t("language.english") },
    { value: "zh", label: t("language.chinese") },
  ];
  const selectedLanguageLabel =
    languageOptions.find((option) => option.value === language)?.label ?? language;
  const taskDisplayWindowOptions = TASK_DISPLAY_WINDOW_VALUES.map((value) => ({
    value,
    label:
      value === "all"
        ? t("appSettings.taskDisplayAll")
        : t("appSettings.taskDisplayRecentDays", { days: value }),
  }));
  const selectedTaskDisplayWindowLabel =
    taskDisplayWindowOptions.find((option) => option.value === taskDisplayWindow)?.label ??
    t("appSettings.taskDisplayRecentDays", { days: 3 });

  const codexRunModeOptions: Array<{ value: TaskRunMode; label: string }> = [
    { value: "pty", label: t("codex.runMode.pty") },
    { value: "structured", label: t("codex.runMode.structured") },
  ];
  const selectedCodexRunModeLabel =
    codexRunModeOptions.find((option) => option.value === codexRunMode)?.label ??
    t("codex.runMode.pty");
  const structuredDisabled = structuredSupported === false;
  const codexRunModeHint = structuredDisabled
    ? t("appSettings.codexRunModeUnsupportedHint")
    : t("appSettings.codexRunModeHint");

  const stepScrollback = (direction: 1 | -1) => {
    onTerminalScrollbackChange(
      clampTerminalScrollback(terminalScrollback + direction * TERMINAL_SCROLLBACK_STEP),
    );
  };

  return {
    t,
    language,
    setLanguage,
    languageOptions,
    selectedLanguageLabel,
    taskDisplayWindow,
    onTaskDisplayWindowChange,
    taskDisplayWindowOptions,
    selectedTaskDisplayWindowLabel,
    codexRunMode,
    codexRunModeBusy,
    handleCodexRunModeChange,
    selectedCodexRunModeLabel,
    codexRunModeOptions,
    structuredDisabled,
    codexRunModeHint,
    codexAskInWorkspaceAutoApproveOn,
    codexAskInWorkspaceAutoApproveBusy,
    handleCodexAskInWorkspaceAutoApproveToggle,
    attentionBadge,
    onAttentionBadgeChange,
    terminalScrollback,
    onTerminalScrollbackChange,
    stepScrollback,
    copyOnSelectOn,
    copyOnSelectBusy,
    handleCopyOnSelectToggle,
    systemNotificationsOn,
    systemNotificationsBusy,
    handleSystemNotificationsToggle,
    conptyOn,
    conptyDisabled,
    handleSideloadedConptyToggle,
    conptyHint
  };
}
