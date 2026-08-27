import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { isAgentEnabled, enabledAgentTypes } from "../../types";
import {
  APP_SETTINGS_CHANGED_EVENT,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AgentKey,
} from "./types";

function enabledField(agent: AgentKey): keyof AppSettings {
  if (agent === "claude") return "claude_enabled";
  if (agent === "codex") return "codex_enabled";
  return "dsh_enabled";
}

/** 设置页各 Agent 顶部的「启用/禁用」开关。禁用后从发起任务入口隐藏，但保留设置入口。 */
export function AgentEnabledSection({ agentKey }: { agentKey: AgentKey }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      invoke<AppSettings>("load_app_settings")
        .then((loaded) => {
          if (!cancelled) setSettings(loaded);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const handler = () => load();
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, handler);
    };
  }, []);

  const field = enabledField(agentKey);
  const enabled = isAgentEnabled(settings, agentKey);
  // 仅剩一个启用且就是当前项时，禁止关闭（避免发起任务的 Agent 选择器为空）。
  const isLastEnabled = enabled && enabledAgentTypes(settings).length === 1;
  const disabled = loading || saving || isLastEnabled;

  async function handleToggle() {
    const next = !enabled;
    setSaving(true);
    setError(null);
    const prev = settings;
    setSettings((prevSettings) => ({ ...prevSettings, [field]: next }));
    try {
      const nextSettings = await invoke<AppSettings>("save_agent_enabled", {
        agent: agentKey,
        enabled: next,
      });
      setSettings(nextSettings);
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    } catch (e) {
      setSettings(prev);
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
      {error && <div style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</div>}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          {t("appSettings.agentEnabled")}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("appSettings.agentEnabled")}
          disabled={disabled}
          onClick={() => void handleToggle()}
          style={disabled ? { ...s.agentPathToggleRow, ...s.agentPathToggleRowDisabled } : s.agentPathToggleRow}
        >
          <span style={s.agentPathToggleLabel}>{t("appSettings.agentEnabledToggleLabel")}</span>
          <span style={enabled ? s.shortcutSwitchTrackOn : s.shortcutSwitchTrack}>
            <span style={enabled ? s.shortcutSwitchThumbOn : s.shortcutSwitchThumb} />
          </span>
        </button>
      </div>
      <span style={{ fontSize: 11, color: "var(--text-hint)", marginTop: 0 }}>
        {isLastEnabled
          ? t("appSettings.agentEnabledLastOne")
          : t("appSettings.agentEnabledHint")}
      </span>
    </div>
  );
}
