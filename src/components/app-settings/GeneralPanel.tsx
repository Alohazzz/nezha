import { Check, ChevronDown, AlertTriangle } from "lucide-react";
import * as Select from "@radix-ui/react-select";
import type { AppLanguage } from "../../i18n";
import { clampTerminalScrollback, normalizeTaskDisplayWindow, TERMINAL_SCROLLBACK_MIN, TERMINAL_SCROLLBACK_MAX, TERMINAL_SCROLLBACK_STEP, type TaskRunMode } from "../../types";
import { PromptPredictionSetting } from "./PromptPredictionSetting";
import { useGeneralSettings, type GeneralPanelProps } from "./useGeneralSettings";

export function GeneralPanel(props: GeneralPanelProps) {
  const {
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
  } = useGeneralSettings(props);
  return (
    <div className="nz-settingsBodyColumn nz-generalSettings">
      <section className="nz-generalSection" aria-labelledby="general-basics">
        <h3 id="general-basics" className="nz-generalSectionTitle">{t("appSettings.group.basics")}</h3>
      <div className="nz-settingField">
        <label className="nz-settingFieldLabel">{t("appSettings.appLanguage")}</label>
        <Select.Root value={language} onValueChange={(value) => setLanguage(value as AppLanguage)}>
          <Select.Trigger
            aria-label={t("appSettings.appLanguage")}
            className="nz-settingsSelectTriggerCompact"
          >
            <Select.Value>{selectedLanguageLabel}</Select.Value>
            <Select.Icon>
              <ChevronDown size={13} strokeWidth={2.2} color="var(--text-hint)" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content position="popper" sideOffset={4} className="nz-settingsSelectContent">
              <Select.Viewport className="nz-settingsSelectViewport">
                {languageOptions.map((option) => {
                  const selected = option.value === language;

                  return (
                    <Select.Item
                      key={option.value}
                      value={option.value}
                      className={selected ? "radix-select-item nz-settingsSelectOptionSelected" : "radix-select-item nz-settingsSelectOption"}

                    >
                      <Select.ItemText>{option.label}</Select.ItemText>
                      <Select.ItemIndicator className="nz-settingsSelectIndicator">
                        <Check size={13} className="nz-settingsSelectCheck" />
                      </Select.ItemIndicator>
                    </Select.Item>
                  );
                })}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <span className="nz-settingFieldHint">{t("appSettings.languageHint")}</span>
      </div>
      <div className="nz-settingFieldSpaced">
        <label className="nz-settingFieldLabel">{t("appSettings.taskDisplayWindow")}</label>
        <Select.Root
          value={String(taskDisplayWindow)}
          onValueChange={(value) => onTaskDisplayWindowChange(normalizeTaskDisplayWindow(value))}
        >
          <Select.Trigger
            aria-label={t("appSettings.taskDisplayWindow")}
            className="nz-settingsSelectTriggerCompact"
          >
            <Select.Value>{selectedTaskDisplayWindowLabel}</Select.Value>
            <Select.Icon>
              <ChevronDown size={13} strokeWidth={2.2} color="var(--text-hint)" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content position="popper" sideOffset={4} className="nz-settingsSelectContent">
              <Select.Viewport className="nz-settingsSelectViewport">
                {taskDisplayWindowOptions.map((option) => {
                  const optionValue = String(option.value);
                  const selected = option.value === taskDisplayWindow;

                  return (
                    <Select.Item
                      key={optionValue}
                      value={optionValue}
                      className={selected ? "radix-select-item nz-settingsSelectOptionSelected" : "radix-select-item nz-settingsSelectOption"}

                    >
                      <Select.ItemText>{option.label}</Select.ItemText>
                      <Select.ItemIndicator className="nz-settingsSelectIndicator">
                        <Check size={13} className="nz-settingsSelectCheck" />
                      </Select.ItemIndicator>
                    </Select.Item>
                  );
                })}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <span className="nz-settingFieldHint">{t("appSettings.taskDisplayWindowHint")}</span>
      </div>
      </section>
      <section className="nz-generalSection" aria-labelledby="general-codex">
        <h3 id="general-codex" className="nz-generalSectionTitle">{t("appSettings.group.codex")}</h3>
      <div className="nz-settingFieldSpaced">
        <label className="nz-settingFieldLabel">{t("codex.runMode")}</label>
        <Select.Root
          value={codexRunMode ?? "pty"}
          onValueChange={(value) => void handleCodexRunModeChange(value as TaskRunMode)}
          disabled={codexRunModeBusy || codexRunMode === null}
        >
          <Select.Trigger
            aria-label={t("codex.runMode")}
            className="nz-settingsSelectTriggerCompact"
            data-disabled={codexRunModeBusy || codexRunMode === null}
          >
            <Select.Value>{selectedCodexRunModeLabel}</Select.Value>
            <Select.Icon>
              <ChevronDown size={13} strokeWidth={2.2} color="var(--text-hint)" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content position="popper" sideOffset={4} className="nz-settingsSelectContent">
              <Select.Viewport className="nz-settingsSelectViewport">
                {codexRunModeOptions.map((option) => {
                  const optionDisabled = option.value === "structured" && structuredDisabled;
                  const selected = option.value === codexRunMode;

                  return (
                    <Select.Item
                      key={option.value}
                      value={option.value}
                      className={selected ? "radix-select-item nz-settingsSelectOptionSelected" : "radix-select-item nz-settingsSelectOption"}
                      disabled={optionDisabled}

                    >
                      <Select.ItemText>{option.label}</Select.ItemText>
                      <Select.ItemIndicator className="nz-settingsSelectIndicator">
                        <Check size={13} className="nz-settingsSelectCheck" />
                      </Select.ItemIndicator>
                    </Select.Item>
                  );
                })}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <span className="nz-settingFieldHint">{codexRunModeHint}</span>
        {structuredDisabled && (
          <div className="nz-settingsFieldWarning" role="alert">
            <AlertTriangle size={13} strokeWidth={2} className="nz-settingsFieldWarningIcon" />
            <span>{t("appSettings.codexRunModeFloorWarning")}</span>
          </div>
        )}
      </div>
      <PromptPredictionSetting />
      <div className="nz-settingFieldSpaced">
        <label className="nz-settingFieldLabel">{t("appSettings.codexAskInWorkspaceAutoApprove")}</label>
        <button
          type="button"
          role="switch"
          aria-checked={codexAskInWorkspaceAutoApproveOn}
          aria-label={t("appSettings.codexAskInWorkspaceAutoApprove")}
          disabled={codexAskInWorkspaceAutoApproveBusy}
          data-checked={codexAskInWorkspaceAutoApproveOn}
          data-disabled={codexAskInWorkspaceAutoApproveBusy}
          onClick={() => void handleCodexAskInWorkspaceAutoApproveToggle()}
          className="app-settings-toggle"
        >
          <span className="app-settings-toggle-label">{t("appSettings.codexAskInWorkspaceAutoApproveToggle")}</span>
          <span className="app-settings-toggle-track">
            <span className="app-settings-toggle-knob" />
          </span>
        </button>
        <span className="nz-settingFieldHint">{t("appSettings.codexAskInWorkspaceAutoApproveHint")}</span>
      </div>
      </section>
      <section className="nz-generalSection" aria-labelledby="general-notifications">
        <h3 id="general-notifications" className="nz-generalSectionTitle">{t("appSettings.group.notifications")}</h3>
      <div className="nz-settingFieldSpaced">
        <label className="nz-settingFieldLabel">{t("appSettings.attentionBadge")}</label>
        <button
          type="button"
          role="switch"
          aria-checked={attentionBadge}
          aria-label={t("appSettings.attentionBadge")}
          onClick={() => onAttentionBadgeChange(!attentionBadge)}
          className="app-settings-toggle" data-checked={attentionBadge}
        >
          <span className="app-settings-toggle-label">{t("appSettings.attentionBadgeToggle")}</span>
          <span className="app-settings-toggle-track">
            <span className="app-settings-toggle-knob" />
          </span>
        </button>
        <span className="nz-settingFieldHint">{t("appSettings.attentionBadgeHint")}</span>
      </div>
      <div className="nz-settingFieldSpaced">
        <label className="nz-settingFieldLabel">{t("appSettings.systemNotifications")}</label>
        <button
          type="button"
          role="switch"
          aria-checked={systemNotificationsOn}
          aria-label={t("appSettings.systemNotifications")}
          disabled={systemNotificationsBusy}
          data-checked={systemNotificationsOn}
          data-disabled={systemNotificationsBusy}
          onClick={() => void handleSystemNotificationsToggle()}
          className="app-settings-toggle"
        >
          <span className="app-settings-toggle-label">
            {t("appSettings.systemNotificationsToggle")}
          </span>
          <span className="app-settings-toggle-track">
            <span className="app-settings-toggle-knob" />
          </span>
        </button>
        <span className="nz-settingFieldHint">{t("appSettings.systemNotificationsHint")}</span>
      </div>
      </section>
      <section className="nz-generalSection" aria-labelledby="general-terminal">
        <h3 id="general-terminal" className="nz-generalSectionTitle">{t("appSettings.group.terminal")}</h3>
      <div className="nz-settingFieldSpaced">
        <label className="nz-settingFieldLabel">{t("appSettings.terminalScrollback")}</label>
        <div className="nz-fontSizeControls">
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
            className="nz-settingsNumberInput"
          />
          <span className="nz-fontSizeUnit">{t("appSettings.terminalScrollbackUnit")}</span>
        </div>
        <span className="nz-settingFieldHint">{t("appSettings.terminalScrollbackHint")}</span>
        {terminalScrollback > 3000 && (
          <div className="nz-settingsFieldWarning" role="alert">
            <AlertTriangle size={13} strokeWidth={2} className="nz-settingsFieldWarningIcon" />
            <span>{t("appSettings.terminalScrollbackWarning")}</span>
          </div>
        )}
      </div>
      <div className="nz-settingFieldSpaced">
        <label className="nz-settingFieldLabel">{t("appSettings.copyOnSelect")}</label>
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
        <span className="nz-settingFieldHint">{t("appSettings.copyOnSelectHint")}</span>
      </div>
      <div className="nz-settingFieldSpaced">
        <label className="nz-settingFieldLabel">{t("appSettings.sideloadedConpty")}</label>
        <button
          type="button"
          role="switch"
          aria-checked={conptyOn}
          aria-label={t("appSettings.sideloadedConpty")}
          disabled={conptyDisabled}
          onClick={() => void handleSideloadedConptyToggle()}
          className="app-settings-toggle" data-checked={conptyOn} data-disabled={conptyDisabled}
        >
          <span className="app-settings-toggle-label">{t("appSettings.sideloadedConptyToggle")}</span>
          <span className="app-settings-toggle-track">
            <span className="app-settings-toggle-knob" />
          </span>
        </button>
        <span className="nz-settingFieldHint">{conptyHint}</span>
      </div>
      </section>
    </div>
  );
}
