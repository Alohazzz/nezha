import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { APP_SETTINGS_CHANGED_EVENT, type AppSettings } from "./types";

export function PromptPredictionSetting() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void invoke<AppSettings>("load_app_settings").then((settings) => {
      if (!cancelled) setEnabled(settings.codex_prompt_predictions_enabled === true);
    }).catch(() => {}).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const settings = await invoke<AppSettings>("save_codex_prompt_predictions_enabled", { enabled: !enabled });
      setEnabled(settings.codex_prompt_predictions_enabled);
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="nz-settingFieldSpaced">
      <button type="button" className="app-settings-toggle" role="switch" aria-checked={enabled} data-checked={enabled} data-disabled={busy}
        aria-label={t("codex.prediction.title")} disabled={busy} onClick={() => void save()}>
        <span className="app-settings-toggle-label">{t("codex.prediction.title")}</span>
        <span className="app-settings-toggle-track" data-on={enabled} aria-hidden="true">
          <span className="app-settings-toggle-knob" data-on={enabled} />
        </span>
      </button>
      <span className="nz-settingFieldHint">{t("codex.prediction.hint")}</span>
      {error && <span className="nz-settingsFieldWarning" role="alert">{error}</span>}
    </div>
  );
}
