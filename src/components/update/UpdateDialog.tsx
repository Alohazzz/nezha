import { useMemo } from "react";
import { AlertTriangle, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n";
import type { UpdateInfo } from "../../types";
import type { UpdatePhase } from "../../hooks/useUpdate";
import s from "../../styles";

const RELEASES_URL = "https://github.com/Alohazzz/nezha/releases";

// ── 局部子组件：保持根组件小巧、便于维护 ───────────────────────────────────────

function VersionRow({ info }: { info: UpdateInfo }) {
  const { t } = useI18n();
  return (
    <div style={s.updateVersionRow}>
      <span style={s.updateNewVersion}>{t("update.newVersion", { version: info.version })}</span>
      <span style={s.updateCurrentVersion}>
        {t("update.currentVersion", { version: info.currentVersion })}
      </span>
    </div>
  );
}

function MetaRow({ info }: { info: UpdateInfo }) {
  const { language } = useI18n();
  const label = language === "zh" ? "发布于" : "Published";
  const date = info.publishedAt ? new Date(info.publishedAt).toLocaleDateString() : "";
  return <div style={s.updateMetaText}>{date ? `${label} ${date}` : "—"}</div>;
}

function ReleaseBody({ body }: { body: string | null }) {
  const { t } = useI18n();
  if (!body) return null;
  return (
    <div>
      <div style={s.updateBodyLabel}>{t("update.releaseNotes")}</div>
      <pre style={s.updateBody}>{body}</pre>
    </div>
  );
}

function ProgressBar({ progress }: { progress: number }) {
  const { t } = useI18n();
  const pct = Math.round(progress * 100);
  return (
    <div>
      <div style={s.updateProgressTrack}>
        <div style={{ ...s.updateProgressFill, width: `${pct}%` }} />
      </div>
      <div style={s.updateProgressLabel}>{t("update.downloadProgress", { percent: pct })}</div>
    </div>
  );
}

export function UpdateDialog({
  info,
  phase,
  error,
  progress,
  activeCount,
  checking,
  onClose,
  onDownload,
  onInstall,
}: {
  info: UpdateInfo | null;
  phase: UpdatePhase;
  error: string | null;
  progress: number;
  activeCount: number;
  checking: boolean;
  onClose: () => void;
  onDownload: () => void;
  onInstall: (force: boolean) => void;
}) {
  const { t } = useI18n();
  const canAutoInstall = useMemo(() => Boolean(info?.asset?.supported), [info]);

  const renderBody = () => {
    if (phase === "checking" || (checking && phase === "upToDate")) {
      return <div style={s.updateHint}>{t("update.checking")}</div>;
    }
    if (phase === "error") {
      return <div style={s.updateError}>{error ?? t("update.checkFailed", { error: "" })}</div>;
    }
    if (phase === "upToDate") {
      return (
        <div style={s.updateUpToDateWrap}>
          <div style={s.updateUpToDateTitle}>{t("update.upToDate")}</div>
          <div style={s.updateMuted}>{t("update.upToDateDesc")}</div>
        </div>
      );
    }
    if (!info) {
      return <div style={s.updateHint}>{t("update.checking")}</div>;
    }

    return (
      <>
        <VersionRow info={info} />
        <MetaRow info={info} />
        <ReleaseBody body={info.body} />
        {phase === "downloading" && <ProgressBar progress={progress} />}
        {phase === "ready" && activeCount > 0 && (
          <div style={s.updateWarning}>
            <AlertTriangle size={14} strokeWidth={2} color="var(--color-warning)" />
            <span>{t("update.runningTaskWarning", { count: activeCount })}</span>
          </div>
        )}
        {phase === "installing" && (
          <div style={s.updateHint}>{t("update.installReady")}</div>
        )}
      </>
    );
  };

  const renderFooter = () => {
    if (phase === "error") {
      return (
        <div style={s.updateButtons}>
          <button style={s.updateSecondaryBtn} onClick={onClose} data-testid="update-close">
            {t("common.close")}
          </button>
        </div>
      );
    }
    if (!info || phase === "checking" || phase === "upToDate") {
      return null;
    }

    if (!canAutoInstall || !info.asset) {
      return (
        <div style={s.updateButtons}>
          <span style={s.updateMetaText}>{t("update.incompatible")}</span>
          <button style={s.updateSecondaryBtn} onClick={onClose}>
            {t("common.close")}
          </button>
          <button
            style={s.updatePrimaryBtn}
            onClick={() => void openUrl(RELEASES_URL)}
            data-testid="update-open-releases"
          >
            {t("update.openReleases")}
          </button>
        </div>
      );
    }

    if (phase === "downloading") {
      return (
        <div style={s.updateButtons}>
          <button style={s.updateSecondaryBtn} onClick={onClose}>
            {t("common.close")}
          </button>
          <button style={{ ...s.updatePrimaryBtn, ...s.updatePrimaryDisabled }} disabled>
            {t("update.downloading")}
          </button>
        </div>
      );
    }

    if (phase === "available") {
      return (
        <div style={s.updateButtons}>
          <button style={s.updateSecondaryBtn} onClick={onClose}>
            {t("common.close")}
          </button>
          <button style={s.updatePrimaryBtn} onClick={onDownload} data-testid="update-download">
            {t("update.downloadInstall")}
          </button>
        </div>
      );
    }

    if (phase === "ready") {
      const force = activeCount > 0;
      return (
        <div style={s.updateButtons}>
          <button style={s.updateSecondaryBtn} onClick={onClose}>
            {t("common.close")}
          </button>
          <button
            style={s.updatePrimaryBtn}
            onClick={() => onInstall(force)}
            data-testid="update-install"
          >
            {force ? t("update.forceInstall") : t("update.installNow")}
          </button>
        </div>
      );
    }

    if (phase === "installing") {
      return (
        <div style={s.updateButtons}>
          <button style={{ ...s.updatePrimaryBtn, ...s.updatePrimaryDisabled }} disabled>
            {t("update.installReady")}
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div style={s.modalOverlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.updateDialogCard}>
        <div style={s.updateDialogHeader}>
          <span style={s.updateDialogTitle}>{t("update.title")}</span>
          <button style={s.modalCloseBtn} onClick={onClose} title={t("common.close")}>
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <div style={s.updateDialogContent}>{renderBody()}</div>
        <div style={s.updateFooter}>{renderFooter()}</div>
      </div>
    </div>
  );
}
