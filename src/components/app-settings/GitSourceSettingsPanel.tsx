import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import s from "../../styles";
import {
  APP_SETTINGS_CHANGED_EVENT,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "./types";

/** 「Git 和源代码设置」面板：合并审核临时仓库基路径。 */
export function GitSourceSettingsPanel() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [original, setOriginal] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipNextChangeEventRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      invoke<AppSettings>("load_app_settings")
        .then((loaded) => {
          if (cancelled) return;
          setSettings(loaded);
          setOriginal(loaded);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const handler = () => {
      if (skipNextChangeEventRef.current) {
        skipNextChangeEventRef.current = false;
        return;
      }
      load();
    };
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, handler);
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await invoke<AppSettings>("save_codeup_settings", {
        worktreeBasePath: settings.codeup.worktreeBasePath,
      });
      setSettings(next);
      setOriginal(next);
      skipNextChangeEventRef.current = true;
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const isDirty = settings.codeup.worktreeBasePath !== original.codeup.worktreeBasePath;

  return (
    <div style={s.settingsBodyColumn}>
      {error && (
        <div style={s.settingsFieldWarning} role="alert">
          {error}
        </div>
      )}

      <div style={s.settingField}>
        <label style={s.settingFieldLabel}>{t("appSettings.codeupWorktreeBasePath")}</label>
        <div style={s.settingsFlexRow}>
          <input
            className="app-settings-input"
            style={s.modalInputFlex}
            value={settings.codeup.worktreeBasePath}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                codeup: { ...prev.codeup, worktreeBasePath: e.target.value },
              }))
            }
            placeholder="~/.nezha/codeup_worktrees"
            disabled={loading}
            spellCheck={false}
            aria-label={t("appSettings.codeupWorktreeBasePath")}
          />
          <button
            type="button"
            className="app-settings-save"
            data-disabled={saving || !isDirty}
            disabled={loading || saving || !isDirty}
            onClick={() => void handleSave()}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
        <span style={s.settingFieldHint}>{t("appSettings.codeupWorktreeBasePathHint")}</span>
        {saved && <span style={s.settingFieldHint}>{t("common.saved")}</span>}
      </div>
    </div>
  );
}
