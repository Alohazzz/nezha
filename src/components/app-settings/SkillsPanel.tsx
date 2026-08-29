import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, GitBranch, RotateCcw } from "lucide-react";
import { useI18n } from "../../i18n";
import type { Project, SkillHubConfig, SetSkillHubResult } from "../../types";
import { SKILL_HUB_CHANGED_EVENT, type AppSettings } from "./types";
import s from "../../styles";

function formatSyncTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

/** 技能库来源配置：本地目录 / git 远端（URL + 可选分支）。 */
export function SkillsPanel() {
  const { t } = useI18n();
  const [config, setConfig] = useState<SkillHubConfig | null>(null);
  const [hubProjectName, setHubProjectName] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<"path" | "git">("path");
  const [urlText, setUrlText] = useState("");
  const [branchText, setBranchText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoWriteback, setAutoWriteback] = useState<boolean | null>(null);
  const [writebackBusy, setWritebackBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>("load_app_settings")
      .then((settings) => {
        if (!cancelled) setAutoWriteback(settings.knowledge?.autoWriteback ?? false);
      })
      .catch(() => {
        if (!cancelled) setAutoWriteback(false);
      })
      .finally(() => {
        if (!cancelled) setWritebackBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    invoke<SkillHubConfig>("get_skill_hub_config")
      .then((cfg) => {
        setConfig(cfg ?? null);
        if (cfg?.source?.sourceType === "git") {
          setSourceType("git");
          setUrlText(cfg.source.url ?? "");
          setBranchText(cfg.source.branch ?? "");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!config?.hubProjectId) {
      setHubProjectName(null);
      return;
    }
    invoke<Project[]>("load_projects")
      .then((projects) => {
        if (cancelled) return;
        const hub = projects.find((p) => p.id === config.hubProjectId);
        setHubProjectName(hub?.name ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [config?.hubProjectId]);

  const applyResult = useCallback((result: SetSkillHubResult) => {
    setConfig(result.config);
    setHubProjectName(result.project.name);
    window.dispatchEvent(
      new CustomEvent(SKILL_HUB_CHANGED_EVENT, {
        detail: { projects: result.projects },
      }),
    );
  }, []);

  const handlePick = useCallback(async () => {
    setError(null);
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    setBusy(true);
    try {
      const result = await invoke<SetSkillHubResult>("set_skill_source", {
        sourceType: "path",
        path: selected as string,
      });
      applyResult(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [applyResult]);

  const handleSaveGit = useCallback(async () => {
    const url = urlText.trim();
    if (!url) {
      setError(t("skill.settings.gitUrlRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<SetSkillHubResult>("set_skill_source", {
        sourceType: "git",
        url,
        branch: branchText.trim() || null,
      });
      applyResult(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [urlText, branchText, applyResult, t]);

  const handleClear = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("clear_skill_hub");
      setConfig(null);
      setHubProjectName(null);
      setSourceType("path");
      setUrlText("");
      setBranchText("");
      window.dispatchEvent(new CustomEvent(SKILL_HUB_CHANGED_EVENT));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleWritebackToggle = useCallback(async () => {
    if (writebackBusy || autoWriteback === null) return;
    const enabled = !autoWriteback;
    setWritebackBusy(true);
    setError(null);
    try {
      const next = await invoke<AppSettings>("save_knowledge_auto_writeback", { enabled });
      setAutoWriteback(next.knowledge?.autoWriteback ?? enabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setWritebackBusy(false);
    }
  }, [writebackBusy, autoWriteback]);

  const hubPath = config?.hubPath ?? "";
  const lastSyncedAt = config?.lastSyncedAt;
  const commit = config?.lastSyncedCommit;
  const syncError = config?.lastSyncError;

  return (
    <div style={s.skillsPanelBody}>
      <div style={s.skillsPanelField}>
        <label style={s.skillsPanelLabel}>{t("skill.settings.sourceType")}</label>
        <div style={s.skillsPanelSourceRow}>
          <label style={s.skillsPanelRadioLabel}>
            <input
              type="radio"
              name="skillSource"
              checked={sourceType === "path"}
              onChange={() => setSourceType("path")}
              disabled={busy}
            />
            {t("skill.settings.sourcePath")}
          </label>
          <label style={s.skillsPanelRadioLabel}>
            <input
              type="radio"
              name="skillSource"
              checked={sourceType === "git"}
              onChange={() => setSourceType("git")}
              disabled={busy}
            />
            {t("skill.settings.sourceGit")}
          </label>
        </div>
      </div>

      {sourceType === "path" ? (
        <div style={s.skillsPanelField}>
          <label style={s.skillsPanelLabel}>{t("skill.settings.hubPath")}</label>
          <div style={s.skillsPanelPathRow}>
            <div style={s.skillsPanelPathBox}>
              {hubPath ? (
                <span style={s.skillsPanelPathText}>{hubPath}</span>
              ) : (
                <span style={s.skillsPanelPathEmpty}>{t("skill.settings.notConfigured")}</span>
              )}
            </div>
            <button
              type="button"
              style={s.skillsPanelPickBtn}
              onClick={handlePick}
              disabled={busy}
            >
              <FolderOpen size={13} strokeWidth={2} />
              {t("skill.settings.choose")}
            </button>
            {hubPath ? (
              <button
                type="button"
                style={s.skillsPanelClearBtn}
                onClick={handleClear}
                disabled={busy}
                title={t("skill.settings.reset")}
              >
                <RotateCcw size={13} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={s.skillsPanelField}>
          <label style={s.skillsPanelLabel}>{t("skill.settings.gitUrl")}</label>
          <div style={s.skillsPanelGitRow}>
            <input
              style={s.skillsPanelInput}
              value={urlText}
              onChange={(event) => setUrlText(event.target.value)}
              placeholder={t("skill.settings.gitUrlPlaceholder")}
              spellCheck={false}
              disabled={busy}
            />
            <button
              type="button"
              style={busy ? s.skillsPanelSaveBtnDisabled : s.skillsPanelSaveBtn}
              onClick={handleSaveGit}
              disabled={busy}
            >
              <GitBranch size={13} strokeWidth={2} />
              {busy ? t("skill.settings.saving") : t("skill.settings.saveAndSync")}
            </button>
          </div>
          <div style={s.skillsPanelGitRow}>
            <input
              style={s.skillsPanelInput}
              value={branchText}
              onChange={(event) => setBranchText(event.target.value)}
              placeholder={t("skill.settings.branch")}
              spellCheck={false}
              disabled={busy}
            />
          </div>
        </div>
      )}

      {hubPath ? (
        <div style={s.skillsPanelStatusRow}>
          <span style={s.skillsPanelStatusLabel}>{t("skill.settings.resolvedPath")}</span>
          <span style={s.skillsPanelStatusValue}>{hubPath}</span>
        </div>
      ) : null}

      {hubPath ? (
        <div style={s.skillsPanelStatusRow}>
          <span style={s.skillsPanelStatusLabel}>{t("skill.settings.lastSync")}</span>
          <span style={s.skillsPanelStatusValue}>
            {lastSyncedAt ? formatSyncTime(lastSyncedAt) : t("skill.settings.neverSynced")}
          </span>
          {commit ? (
            <>
              <span style={s.skillsPanelStatusLabel}>{t("skill.settings.commit")}</span>
              <span style={s.skillsPanelStatusValue}>{commit.slice(0, 12)}</span>
            </>
          ) : null}
          {syncError ? (
            <span style={s.skillsPanelStatusError}>
              {t("skill.settings.syncFailed", { error: syncError })}
            </span>
          ) : null}
        </div>
      ) : null}

      {hubProjectName ? (
        <div style={s.skillsPanelMetaRow}>
          <span style={s.skillsPanelMetaLabel}>{t("skill.settings.hubProject")}</span>
          <span style={s.skillsPanelMetaValue}>{hubProjectName}</span>
        </div>
      ) : null}

      <div style={s.settingFieldSpaced}>
        <label style={s.settingFieldLabel}>{t("appSettings.knowledgeAutoWriteback")}</label>
        <button
          type="button"
          role="switch"
          aria-checked={autoWriteback === true}
          aria-label={t("appSettings.knowledgeAutoWriteback")}
          disabled={writebackBusy}
          data-checked={autoWriteback === true}
          data-disabled={writebackBusy}
          onClick={() => void handleWritebackToggle()}
          className="app-settings-toggle"
        >
          <span className="app-settings-toggle-label">
            {t("appSettings.knowledgeAutoWritebackToggle")}
          </span>
          <span className="app-settings-toggle-track">
            <span className="app-settings-toggle-knob" />
          </span>
        </button>
        <span style={s.settingFieldHint}>{t("appSettings.knowledgeAutoWritebackHint")}</span>
      </div>

      {error ? <div style={s.skillsPanelError}>{error}</div> : null}
    </div>
  );
}
