import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Plus, Sparkles, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";
import {
  APP_SETTINGS_CHANGED_EVENT,
  type AgentKey,
  type AgentModelCatalog,
  type AgentModelOption,
  type AppSettings,
} from "./types";

interface EditableModel extends AgentModelOption {
  key: string;
}

function getCatalog(settings: AppSettings, agent: AgentKey): AgentModelCatalog {
  return agent === "claude" ? settings.claude_model_catalog : settings.codex_model_catalog;
}

function serializeModels(models: AgentModelOption[]): string {
  return JSON.stringify(
    models.map((model) => ({
      model: model.model.trim(),
      label: model.label?.trim() || undefined,
      reasoningEfforts: model.reasoningEfforts.map((effort) => effort.trim()).filter(Boolean),
      defaultReasoningEffort: model.defaultReasoningEffort,
    })),
  );
}

export function AgentModelCatalogSection({ agentKey }: { agentKey: AgentKey }) {
  const { t } = useI18n();
  const nextKeyRef = useRef(0);
  const [models, setModels] = useState<EditableModel[]>([]);
  const [originalModels, setOriginalModels] = useState<AgentModelOption[]>([]);
  const [catalog, setCatalog] = useState<AgentModelCatalog>({
    models: [],
    initialized: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toEditable = useCallback(
    (options: AgentModelOption[]): EditableModel[] =>
      options.map((option) => ({
        ...option,
        reasoningEfforts: [...option.reasoningEfforts],
        key: `${agentKey}-${nextKeyRef.current++}`,
      })),
    [agentKey],
  );

  const applySettings = useCallback(
    (settings: AppSettings) => {
      const nextCatalog = getCatalog(settings, agentKey);
      setCatalog(nextCatalog);
      setModels(toEditable(nextCatalog.models));
      setOriginalModels(nextCatalog.models);
    },
    [agentKey, toEditable],
  );

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    invoke<AppSettings>("load_app_settings")
      .then(applySettings)
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, [applySettings]);

  useEffect(() => {
    load();
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, load);
    return () => window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, load);
  }, [load]);

  const invalidModelIndexes = useMemo(() => {
    const invalid = new Set<number>();
    const seen = new Map<string, number>();
    models.forEach((option, index) => {
      const model = option.model.trim();
      const hasControlCharacter = Array.from(model).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      });
      if (!model || hasControlCharacter) {
        invalid.add(index);
        return;
      }
      const prior = seen.get(model);
      if (prior !== undefined) {
        invalid.add(prior);
        invalid.add(index);
      } else {
        seen.set(model, index);
      }
    });
    return invalid;
  }, [models]);

  const normalizedModels = useMemo<AgentModelOption[]>(
    () =>
      models.map(({ key: _key, ...option }) => ({
        ...option,
        model: option.model.trim(),
        label: option.label?.trim() || undefined,
        reasoningEfforts: option.reasoningEfforts.map((effort) => effort.trim()).filter(Boolean),
      })),
    [models],
  );
  const dirty = serializeModels(normalizedModels) !== serializeModels(originalModels);
  const canSave = dirty && invalidModelIndexes.size === 0 && !saving && !initializing;

  function updateModel(index: number, patch: Partial<AgentModelOption>) {
    setModels((current) =>
      current.map((option, optionIndex) =>
        optionIndex === index ? { ...option, ...patch } : option,
      ),
    );
    setSaved(false);
  }

  async function persistModels(dispatchChange: boolean): Promise<AppSettings> {
    if (invalidModelIndexes.size > 0) {
      throw new Error(t("appSettings.models.invalid"));
    }
    const settings = await invoke<AppSettings>("save_agent_model_catalog", {
      agent: agentKey,
      models: normalizedModels,
    });
    applySettings(settings);
    if (dispatchChange) {
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    }
    return settings;
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await persistModels(true);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function handleInitialize() {
    if (agentKey !== "codex" || catalog.initialized || invalidModelIndexes.size > 0) return;
    setInitializing(true);
    setError(null);
    setSaved(false);
    try {
      if (dirty) {
        await persistModels(false);
      }
      const settings = await invoke<AppSettings>("initialize_agent_model_catalog", {
        agent: agentKey,
      });
      applySettings(settings);
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setInitializing(false);
    }
  }

  return (
    <section style={s.agentModelSection}>
      <div style={s.agentModelHeader}>
        <div style={s.agentModelHeadingGroup}>
          <span style={s.agentModelTitle}>{t("appSettings.models.title")}</span>
          <span style={s.agentModelDescription}>{t("appSettings.models.description")}</span>
        </div>
        <div style={s.agentModelActions}>
          {agentKey === "codex" && !catalog.initialized && (
            <button
              type="button"
              style={
                initializing || loading || invalidModelIndexes.size > 0
                  ? s.agentModelSecondaryButtonDisabled
                  : s.agentModelSecondaryButton
              }
              disabled={initializing || loading || invalidModelIndexes.size > 0}
              onClick={handleInitialize}
            >
              <Sparkles size={12} />
              {initializing
                ? t("appSettings.models.initializing")
                : t("appSettings.models.initialize")}
            </button>
          )}
          <button
            type="button"
            style={s.agentModelSecondaryButton}
            onClick={() => {
              setModels((current) => [
                ...current,
                {
                  key: `${agentKey}-${nextKeyRef.current++}`,
                  model: "",
                  reasoningEfforts: [],
                },
              ]);
              setSaved(false);
            }}
          >
            <Plus size={12} />
            {t("appSettings.models.add")}
          </button>
          <button
            type="button"
            style={canSave ? s.agentModelPrimaryButton : s.agentModelPrimaryButtonDisabled}
            disabled={!canSave}
            onClick={handleSave}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>

      {agentKey === "claude" && (
        <div style={s.agentModelDescription}>{t("appSettings.models.claudeManual")}</div>
      )}
      {catalog.initialized && (
        <div style={s.agentModelStatus}>
          <Check size={12} />
          {t("appSettings.models.initialized", {
            version: catalog.sourceVersion || t("appSettings.models.unknownVersion"),
          })}
        </div>
      )}
      {saved && (
        <div style={s.agentModelStatus}>
          <Check size={12} />
          {t("common.saved")}
        </div>
      )}
      {error && <div style={s.agentModelError}>{error}</div>}
      {invalidModelIndexes.size > 0 && (
        <div style={s.agentModelError}>{t("appSettings.models.invalid")}</div>
      )}

      {!loading && models.length === 0 ? (
        <div style={s.agentModelEmpty}>{t("appSettings.models.empty")}</div>
      ) : (
        <div style={s.agentModelList}>
          {models.map((option, index) => (
            <div key={option.key} style={s.agentModelCard}>
              <label style={s.agentModelField}>
                <span style={s.agentModelLabel}>{t("appSettings.models.id")}</span>
                <input
                  style={
                    invalidModelIndexes.has(index) ? s.agentModelInputInvalid : s.agentModelInput
                  }
                  value={option.model}
                  maxLength={1024}
                  spellCheck={false}
                  placeholder={t("appSettings.models.idPlaceholder")}
                  onChange={(event) => updateModel(index, { model: event.target.value })}
                />
              </label>
              <label style={s.agentModelField}>
                <span style={s.agentModelLabel}>{t("appSettings.models.label")}</span>
                <input
                  style={s.agentModelInput}
                  value={option.label ?? ""}
                  maxLength={256}
                  placeholder={t("appSettings.models.labelPlaceholder")}
                  onChange={(event) => updateModel(index, { label: event.target.value })}
                />
              </label>
              <button
                type="button"
                style={s.agentModelDeleteButton}
                title={t("appSettings.models.remove")}
                onClick={() => {
                  setModels((current) => current.filter((_, optionIndex) => optionIndex !== index));
                  setSaved(false);
                }}
              >
                <Trash2 size={13} />
              </button>
              <label style={s.agentModelFieldWide}>
                <span style={s.agentModelLabel}>
                  {option.defaultReasoningEffort
                    ? t("appSettings.models.effortsWithDefault", {
                        effort: option.defaultReasoningEffort,
                      })
                    : t("appSettings.models.efforts")}
                </span>
                <input
                  style={s.agentModelInput}
                  value={option.reasoningEfforts.join(", ")}
                  maxLength={1024}
                  spellCheck={false}
                  placeholder={t("appSettings.models.effortsPlaceholder")}
                  onChange={(event) =>
                    updateModel(index, {
                      reasoningEfforts: event.target.value.split(",").map((value) => value.trim()),
                    })
                  }
                />
              </label>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
