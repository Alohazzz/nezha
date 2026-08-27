import { useEffect, useRef, useState } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  APP_SETTINGS_CHANGED_EVENT,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "./types";
import { AgentEnabledSection } from "./AgentEnabledSection";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  background: "var(--bg-input)",
  border: "1px solid var(--border-medium)",
  borderRadius: 7,
  color: "var(--text-primary)",
  fontSize: 12.5,
  fontFamily: "var(--font-mono)",
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: 5,
  display: "block",
};

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-hint)",
  marginTop: 3,
};

const actionButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 10px",
  background: "none",
  border: "1px solid var(--border-medium)",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--text-secondary)",
  cursor: "pointer",
};

/** DSH（DeepSeek Harness）设置：可执行文件路径 + 启动 profile（默认 cc-tui）。 */
export function DshSettingsSection() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [original, setOriginal] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
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

  async function handleDetect() {
    setDetecting(true);
    setError(null);
    try {
      const detected = await invoke<AppSettings>("detect_agent_paths");
      setSettings((prev) => ({ ...prev, dsh_path: detected.dsh_path }));
    } catch (e) {
      setError(String(e));
    } finally {
      setDetecting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await invoke<AppSettings>("save_dsh_settings", {
        dshPath: settings.dsh_path,
        dshProfile: settings.dsh_profile,
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

  const isDirty =
    settings.dsh_path !== original.dsh_path || settings.dsh_profile !== original.dsh_profile;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 18 }}>
      <AgentEnabledSection agentKey="dsh" />
      {error && <div style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</div>}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          {t("appSettings.installation")}
        </span>
        <button
          style={{
            ...actionButtonStyle,
            cursor: detecting ? "default" : "pointer",
            opacity: detecting ? 0.6 : 1,
          }}
          onClick={handleDetect}
          disabled={detecting}
        >
          <RefreshCw size={12} className={detecting ? "spin" : undefined} />
          {detecting ? t("appSettings.detecting") : t("appSettings.autoDetect")}
        </button>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>dsh 可执行文件</label>
        <input
          style={{ ...inputStyle, opacity: loading ? 0.65 : 1 }}
          value={settings.dsh_path}
          onChange={(e) => setSettings((prev) => ({ ...prev, dsh_path: e.target.value }))}
          placeholder="dsh"
          disabled={loading}
          spellCheck={false}
        />
        <span style={hintStyle}>DeepSeek Harness CLI 路径（留空则从 PATH 探测 `dsh`）</span>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>DSH profile</label>
        <input
          style={{ ...inputStyle, opacity: loading ? 0.65 : 1 }}
          value={settings.dsh_profile}
          onChange={(e) => setSettings((prev) => ({ ...prev, dsh_profile: e.target.value }))}
          placeholder="cc-tui"
          disabled={loading}
          spellCheck={false}
        />
        <span style={hintStyle}>启动时传给 `dsh --profile` 的 profile 名（默认 cc-tui）</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10 }}>
        {saved && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: "var(--success)",
            }}
          >
            <Check size={12} /> {t("common.saved")}
          </span>
        )}
        <button
          style={{
            padding: "5px 14px",
            fontSize: 12,
            background: "var(--primary-action-bg)",
            color: "var(--primary-action-fg)",
            border: "none",
            borderRadius: 6,
            cursor: saving || !isDirty ? "default" : "pointer",
            opacity: saving || !isDirty ? 0.5 : 1,
          }}
          onClick={handleSave}
          disabled={loading || saving || !isDirty}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
