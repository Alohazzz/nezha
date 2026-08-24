import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown } from "lucide-react";
import * as Select from "@radix-ui/react-select";
import { useI18n } from "../../i18n";
import s from "../../styles";
import {
  APP_SETTINGS_CHANGED_EVENT,
  type AgentKey,
  type AgentModelOption,
  type AppSettings,
} from "./types";

/**
 * 哨兵值：跟随 Agent 默认 / 跟随模型默认。
 * 含控制字符，与后端对模型 ID / 思考深度的校验（禁止控制字符）互斥，绝不冲突。
 */
const FOLLOW_DEFAULT = "\u0000follow-default";
const FOLLOW_MODEL_DEFAULT = "\u0000follow-model-default";

function getLightModel(settings: AppSettings, agent: AgentKey): string | null {
  return agent === "claude" ? settings.claude_light_model : settings.codex_light_model;
}

function getLightEffort(settings: AppSettings, agent: AgentKey): string | null {
  return agent === "claude"
    ? settings.claude_light_reasoning_effort
    : settings.codex_light_reasoning_effort;
}

function getCatalogModels(settings: AppSettings, agent: AgentKey): AgentModelOption[] {
  const catalog = agent === "claude" ? settings.claude_model_catalog : settings.codex_model_catalog;
  return catalog.models;
}

/** 设置面板中「轻量 AI 调用模型 / 思考深度」选择器（Claude 与 Codex 分栏各一份）。 */
export function LightModelSection({ agentKey }: { agentKey: AgentKey }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<AppSettings>("load_app_settings")
      .then(setSettings)
      .catch((reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, load);
    return () => window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, load);
  }, [load]);

  const models = settings ? getCatalogModels(settings, agentKey) : [];
  const currentModel = settings ? getLightModel(settings, agentKey) : null;
  const currentEffort = settings ? getLightEffort(settings, agentKey) : null;
  const selectedModel = models.find((option) => option.model === currentModel) ?? null;

  const persist = useCallback(
    async (model: string | null, effort: string | null) => {
      if (saving) return;
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        const next = await invoke<AppSettings>("save_light_model_config", {
          agent: agentKey,
          model,
          reasoningEffort: effort,
        });
        setSettings(next);
        window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2000);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setSaving(false);
      }
    },
    [agentKey, saving],
  );

  const handleModelChange = (value: string) => {
    if (value === FOLLOW_DEFAULT) {
      void persist(null, null);
      return;
    }
    const option = models.find((candidate) => candidate.model === value);
    const effort =
      option && currentEffort && option.reasoningEfforts.includes(currentEffort)
        ? currentEffort
        : null;
    void persist(value, effort);
  };

  const handleEffortChange = (value: string) => {
    void persist(currentModel, value === FOLLOW_MODEL_DEFAULT ? null : value);
  };

  const modelValue = currentModel ?? FOLLOW_DEFAULT;
  const effortValue = currentEffort ?? FOLLOW_MODEL_DEFAULT;
  const effortDisabled =
    currentModel === null || (selectedModel?.reasoningEfforts.length ?? 0) === 0;

  return (
    <section style={s.agentModelSection}>
      <div style={s.agentModelHeadingGroup}>
        <span style={s.agentModelTitle}>{t("appSettings.lightModel.title")}</span>
        <span style={s.agentModelDescription}>{t("appSettings.lightModel.description")}</span>
      </div>

      <div style={s.settingField}>
        <label style={s.settingFieldLabel} htmlFor={`light-model-${agentKey}`}>
          {t("appSettings.lightModel.modelField")}
        </label>
        <Select.Root value={modelValue} onValueChange={handleModelChange}>
          <Select.Trigger
            id={`light-model-${agentKey}`}
            aria-label={t("appSettings.lightModel.modelField")}
            style={s.settingsSelectTriggerCompact}
          >
            <Select.Value>
              {currentModel
                ? selectedModel?.label || currentModel
                : t("appSettings.lightModel.followDefault")}
            </Select.Value>
            <Select.Icon>
              <ChevronDown size={13} strokeWidth={2.2} color="var(--text-hint)" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content position="popper" sideOffset={4} style={s.settingsSelectContent}>
              <Select.Viewport style={s.settingsSelectViewport}>
                <Select.Item
                  value={FOLLOW_DEFAULT}
                  className="radix-select-item"
                  style={
                    currentModel === null ? s.settingsSelectOptionSelected : s.settingsSelectOption
                  }
                >
                  <Select.ItemText>{t("appSettings.lightModel.followDefault")}</Select.ItemText>
                  <Select.ItemIndicator style={s.settingsSelectIndicator}>
                    <Check size={13} style={s.settingsSelectCheck} />
                  </Select.ItemIndicator>
                </Select.Item>
                {models.map((option) => {
                  const selected = option.model === currentModel;
                  return (
                    <Select.Item
                      key={option.model}
                      value={option.model}
                      className="radix-select-item"
                      style={selected ? s.settingsSelectOptionSelected : s.settingsSelectOption}
                    >
                      <Select.ItemText>{option.label || option.model}</Select.ItemText>
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
        <span style={s.settingFieldHint}>{t("appSettings.lightModel.modelHint")}</span>
      </div>

      <div style={s.settingField}>
        <label style={s.settingFieldLabel} htmlFor={`light-effort-${agentKey}`}>
          {t("appSettings.lightModel.effortField")}
        </label>
        <Select.Root
          value={effortValue}
          onValueChange={handleEffortChange}
          disabled={effortDisabled}
        >
          <Select.Trigger
            id={`light-effort-${agentKey}`}
            aria-label={t("appSettings.lightModel.effortField")}
            style={s.settingsSelectTriggerCompact}
          >
            <Select.Value>
              {currentEffort ?? t("appSettings.lightModel.followModelDefault")}
            </Select.Value>
            <Select.Icon>
              <ChevronDown size={13} strokeWidth={2.2} color="var(--text-hint)" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content position="popper" sideOffset={4} style={s.settingsSelectContent}>
              <Select.Viewport style={s.settingsSelectViewport}>
                <Select.Item
                  value={FOLLOW_MODEL_DEFAULT}
                  className="radix-select-item"
                  style={
                    currentEffort === null ? s.settingsSelectOptionSelected : s.settingsSelectOption
                  }
                >
                  <Select.ItemText>
                    {t("appSettings.lightModel.followModelDefault")}
                  </Select.ItemText>
                  <Select.ItemIndicator style={s.settingsSelectIndicator}>
                    <Check size={13} style={s.settingsSelectCheck} />
                  </Select.ItemIndicator>
                </Select.Item>
                {(selectedModel?.reasoningEfforts ?? []).map((effort) => {
                  const selected = effort === currentEffort;
                  return (
                    <Select.Item
                      key={effort}
                      value={effort}
                      className="radix-select-item"
                      style={selected ? s.settingsSelectOptionSelected : s.settingsSelectOption}
                    >
                      <Select.ItemText>{effort}</Select.ItemText>
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
        <span style={s.settingFieldHint}>{t("appSettings.lightModel.effortHint")}</span>
      </div>

      {saved && (
        <div style={s.agentModelStatus}>
          <Check size={12} />
          {t("common.saved")}
        </div>
      )}
      {error && <div style={s.agentModelError}>{error}</div>}
    </section>
  );
}
