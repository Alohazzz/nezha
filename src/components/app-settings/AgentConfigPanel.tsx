import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Pencil } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { AgentModelCatalogSection } from "./AgentModelCatalogSection";
import { AgentPathSection } from "./AgentPathSection";
import type { AgentKey } from "./types";
import type { ThemeVariant } from "../../types";

import type { Highlighter } from "shiki";
let _highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!_highlighterPromise) {
    _highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: ["github-dark", "github-light", "solarized-light"],
        langs: ["json", "toml"],
      }),
    );
  }
  return _highlighterPromise!;
}

type FileState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "loaded"; content: string };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function AgentConfigPanel({
  agentKey,
  filePath,
  lang,
  themeVariant,
}: {
  agentKey: AgentKey;
  filePath: string;
  lang: string;
  themeVariant: ThemeVariant;
}) {
  const shikiTheme =
    themeVariant === "dark" || themeVariant === "midnight"
      ? "github-dark"
      : themeVariant === "eyecare"
        ? "solarized-light"
        : "github-light";
  const { t } = useI18n();
  const [resolvedFilePath, setResolvedFilePath] = useState(filePath);
  const [fileState, setFileState] = useState<FileState>({ status: "loading" });
  const [original, setOriginal] = useState("");
  const [editing, setEditing] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [highlightError, setHighlightError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Load file
  useEffect(() => {
    setResolvedFilePath(filePath);
    invoke<string>("get_agent_config_file_path", { agent: agentKey })
      .then((resolvedPath) => setResolvedFilePath(resolvedPath))
      .catch(() => setResolvedFilePath(filePath));
  }, [agentKey, filePath]);

  useEffect(() => {
    setFileState({ status: "loading" });
    setEditing(false);
    setHighlighted(null);
    setHighlightError(null);
    setError(null);
    setSaved(false);
    invoke<string | null>("read_agent_config_file", { agent: agentKey })
      .then((c) => {
        if (c === null) {
          setFileState({ status: "missing" });
        } else {
          setFileState({ status: "loaded", content: c });
          setOriginal(c);
        }
      })
      .catch((e) => setError(String(e)));
  }, [agentKey]);

  // Re-highlight when content or theme changes
  useEffect(() => {
    if (fileState.status !== "loaded") return;
    let cancelled = false;
    setHighlighted(null);
    setHighlightError(null);
    getHighlighter()
      .then((hl) => {
        const html = hl.codeToHtml(fileState.content, {
          lang,
          theme: shikiTheme,
        });
        if (!cancelled) {
          setHighlighted(html);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setHighlightError(String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileState, lang, shikiTheme]);

  async function handleSave() {
    if (fileState.status !== "loaded") return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await invoke("write_agent_config_file", { agent: agentKey, content: fileState.content });
      setOriginal(fileState.content);
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setFileState({ status: "loaded", content: original });
    setEditing(false);
  }

  const isDirty = fileState.status === "loaded" && fileState.content !== original;

  return (
    <>
      <div style={s.agentConfigBody}>
        {!editing && (
          <>
            <AgentPathSection agentKey={agentKey} />
            <AgentModelCatalogSection agentKey={agentKey} />

            <div style={s.agentConfigDivider} />

            <div style={s.agentConfigSectionTitle}>{t("appSettings.configFile")}</div>
          </>
        )}

        {/* File path + edit button row */}
        <div style={s.agentConfigPathRow}>
          <div style={s.agentConfigPath}>{resolvedFilePath}</div>
          {fileState.status === "loaded" && !editing && (
            <button style={s.agentConfigEditButton} onClick={() => setEditing(true)}>
              <Pencil size={12} />
              {t("common.edit")}
            </button>
          )}
          {saved && (
            <span style={s.agentConfigSaved}>
              <Check size={12} /> {t("common.saved")}
            </span>
          )}
        </div>

        {error && <div style={s.agentConfigError}>{error}</div>}

        {highlightError && fileState.status === "loaded" && !editing && (
          <div style={s.agentConfigHint}>
            {t("appSettings.syntaxHighlightUnavailable")}
          </div>
        )}

        {fileState.status === "loading" && !error && (
          <div style={s.agentConfigLoading}>{t("common.loading")}</div>
        )}

        {fileState.status === "missing" && (
          <div style={s.agentConfigMissing}>
            {t("appSettings.configFileNotFound", { path: resolvedFilePath })}
          </div>
        )}

        {fileState.status === "loaded" && !editing && (
          highlighted ? (
            <div
              className="file-viewer-code"
              style={s.agentConfigCode}
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          ) : (
            <pre
              style={s.agentConfigPlainCode}
              dangerouslySetInnerHTML={{ __html: escapeHtml(fileState.content) }}
            />
          )
        )}

        {fileState.status === "loaded" && editing && (
          <textarea
            autoFocus
            style={s.agentConfigTextarea}
            value={fileState.content}
            onChange={(e) => setFileState({ status: "loaded", content: e.target.value })}
            spellCheck={false}
          />
        )}
      </div>

      {editing && (
        <div style={s.settingsFooter}>
          <button style={s.modalCancelBtn} onClick={handleCancel}>
            {t("common.cancel")}
          </button>
          <button
            style={saving || !isDirty ? s.modalSaveBtnDisabled : s.modalSaveBtn}
            onClick={handleSave}
            disabled={saving || !isDirty}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      )}
    </>
  );
}
