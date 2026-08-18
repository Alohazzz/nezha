import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, AlertTriangle } from "lucide-react";
import * as Select from "@radix-ui/react-select";
import { useI18n, type AppLanguage } from "../../i18n";
import {
  clampTerminalScrollback,
  normalizeTaskDisplayWindow,
  TASK_DISPLAY_WINDOW_VALUES,
  TERMINAL_SCROLLBACK_MIN,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_STEP,
  type TaskDisplayWindow,
  type TerminalScrollback,
} from "../../types";
import { APP_PLATFORM } from "../../platform";
import s from "../../styles";
import { APP_SETTINGS_CHANGED_EVENT, type AppSettings } from "./types";

export function GeneralPanel({
  taskDisplayWindow,
  onTaskDisplayWindowChange,
  attentionBadge,
  onAttentionBadgeChange,
  terminalScrollback,
  onTerminalScrollbackChange,
}: {
  taskDisplayWindow: TaskDisplayWindow;
  onTaskDisplayWindowChange: (window: TaskDisplayWindow) => void;
  attentionBadge: boolean;
  onAttentionBadgeChange: (enabled: boolean) => void;
  terminalScrollback: TerminalScrollback;
  onTerminalScrollbackChange: (value: TerminalScrollback) => void;
}) {
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

  const stepScrollback = (direction: 1 | -1) => {
    onTerminalScrollbackChange(
      clampTerminalScrollback(terminalScrollback + direction * TERMINAL_SCROLLBACK_STEP),
    );
  };

  return (
    <div style={s.settingsBodyColumn}>
      <div style={s.settingField}>
        <label style={s.settingFieldLabel}>{t("appSettings.appLanguage")}</label>
        <Select.Root value={language} onValueChange={(value) => setLanguage(value as AppLanguage)}>
          <Select.Trigger
            aria-label={t("appSettings.appLanguage")}
            style={s.settingsSelectTriggerCompact}
          >
            <Select.Value>{selectedLanguageLabel}</Select.Value>
            <Select.Icon>
              <ChevronDown size={13} strokeWidth={2.2} color="var(--text-hint)" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content position="popper" sideOffset={4} style={s.settingsSelectContent}>
              <Select.Viewport style={s.settingsSelectViewport}>
                {languageOptions.map((option) => {
                  const selected = option.value === language;

                  return (
                    <Select.Item
                      key={option.value}
                      value={option.value}
                      className="radix-select-item"
                      style={selected ? s.settingsSelectOptionSelected : s.settingsSelectOption}
                    >
                      <Select.ItemText>{option.label}</Select.ItemText>
                      <Select.ItemIndicator style={s.settingsSelectIndicator}>
                        <Check size={13} style={s.settingsSelectCheck} />
                      </Select.ItemIndicator>
                    </Select.Item>
                  );
                })}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <span style={s.settingFieldHint}>{t("appSettings.languageHint")}</span>
      </div>

      <div style={s.settingFieldSpaced}>
        <label style={s.settingFieldLabel}>{t("appSettings.taskDisplayWindow")}</label>
        <Select.Root
          value={String(taskDisplayWindow)}
          onValueChange={(value) => onTaskDisplayWindowChange(normalizeTaskDisplayWindow(value))}
        >
          <Select.Trigger
            aria-label={t("appSettings.taskDisplayWindow")}
            style={s.settingsSelectTriggerCompact}
          >
            <Select.Value>{selectedTaskDisplayWindowLabel}</Select.Value>
            <Select.Icon>
              <ChevronDown size={13} strokeWidth={2.2} color="var(--text-hint)" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content position="popper" sideOffset={4} style={s.settingsSelectContent}>
              <Select.Viewport style={s.settingsSelectViewport}>
                {taskDisplayWindowOptions.map((option) => {
                  const optionValue = String(option.value);
                  const selected = option.value === taskDisplayWindow;

                  return (
                    <Select.Item
                      key={optionValue}
                      value={optionValue}
                      className="radix-select-item"
                      style={selected ? s.settingsSelectOptionSelected : s.settingsSelectOption}
                    >
                      <Select.ItemText>{option.label}</Select.ItemText>
                      <Select.ItemIndicator style={s.settingsSelectIndicator}>
                        <Check size={13} style={s.settingsSelectCheck} />
                      </Select.ItemIndicator>
                    </Select.Item>
                  );
                })}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <span style={s.settingFieldHint}>{t("appSettings.taskDisplayWindowHint")}</span>
      </div>

      <div style={s.settingFieldSpaced}>
        <label style={s.settingFieldLabel}>{t("appSettings.attentionBadge")}</label>
        <button
          type="button"
          role="switch"
          aria-checked={attentionBadge}
          aria-label={t("appSettings.attentionBadge")}
          onClick={() => onAttentionBadgeChange(!attentionBadge)}
          style={s.settingToggle}
        >
          <span style={s.settingToggleLabel}>{t("appSettings.attentionBadgeToggle")}</span>
          <span style={attentionBadge ? s.settingToggleTrackOn : s.settingToggleTrack}>
            <span style={attentionBadge ? s.settingToggleKnobOn : s.settingToggleKnob} />
          </span>
        </button>
        <span style={s.settingFieldHint}>{t("appSettings.attentionBadgeHint")}</span>
      </div>

      <div style={s.settingFieldSpaced}>
        <label style={s.settingFieldLabel}>{t("appSettings.terminalScrollback")}</label>
        <div style={s.fontSizeControls}>
          <input
            type="number"
            inputMode="numeric"
            min={TERMINAL_SCROLLBACK_MIN}
            max={TERMINAL_SCROLLBACK_MAX}
            step={TERMINAL_SCROLLBACK_STEP}
            value={terminalScrollback}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next)) {
                onTerminalScrollbackChange(clampTerminalScrollback(next));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                stepScrollback(1);
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                stepScrollback(-1);
                return;
              }
              if (e.key !== "Tab") {
                e.preventDefault();
              }
            }}
            onPaste={(e) => e.preventDefault()}
            aria-label={t("appSettings.terminalScrollback")}
            style={s.settingsNumberInput}
          />
          <span style={s.fontSizeUnit}>{t("appSettings.terminalScrollbackUnit")}</span>
        </div>
        <span style={s.settingFieldHint}>{t("appSettings.terminalScrollbackHint")}</span>
        {terminalScrollback > 3000 && (
          <div style={s.settingsFieldWarning} role="alert">
            <AlertTriangle size={13} strokeWidth={2} style={s.settingsFieldWarningIcon} />
            <span>{t("appSettings.terminalScrollbackWarning")}</span>
          </div>
        )}
      </div>

      <div style={s.settingFieldSpaced}>
        <label style={s.settingFieldLabel}>{t("appSettings.copyOnSelect")}</label>
        <button
          type="button"
          role="switch"
          aria-checked={copyOnSelectOn}
          aria-label={t("appSettings.copyOnSelect")}
          disabled={copyOnSelectBusy}
          data-checked={copyOnSelectOn}
          data-disabled={copyOnSelectBusy}
          onClick={() => void handleCopyOnSelectToggle()}
          className="app-settings-toggle"
        >
          <span className="app-settings-toggle-label">{t("appSettings.copyOnSelectToggle")}</span>
          <span className="app-settings-toggle-track">
            <span className="app-settings-toggle-knob" />
          </span>
        </button>
        <span style={s.settingFieldHint}>{t("appSettings.copyOnSelectHint")}</span>
      </div>

      <div style={s.settingFieldSpaced}>
        <label style={s.settingFieldLabel}>{t("appSettings.sideloadedConpty")}</label>
        <button
          type="button"
          role="switch"
          aria-checked={conptyOn}
          aria-label={t("appSettings.sideloadedConpty")}
          disabled={conptyDisabled}
          onClick={() => void handleSideloadedConptyToggle()}
          style={conptyDisabled ? s.settingToggleDisabled : s.settingToggle}
        >
          <span style={s.settingToggleLabel}>{t("appSettings.sideloadedConptyToggle")}</span>
          <span style={conptyOn ? s.settingToggleTrackOn : s.settingToggleTrack}>
            <span style={conptyOn ? s.settingToggleKnobOn : s.settingToggleKnob} />
          </span>
        </button>
        <span style={s.settingFieldHint}>{conptyHint}</span>
      </div>
    </div>
  );
}
