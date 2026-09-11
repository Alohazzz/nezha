import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ExternalLink, Loader2, Play, X, Zap } from "lucide-react";
import type {
  AgentType,
  PermissionMode,
  YunxiaoWorkitem,
} from "../../types";
import {
  isAgentEnabled,
  firstEnabledAgent,
  cycleEnabledAgent,
  type AgentEnabledState,
} from "../../types";
import type { AppSettings, YunxiaoSettings } from "../app-settings/types";
import {
  buildYunxiaoIssueLink,
  getLastYunxiaoAgent,
  getLastYunxiaoPermission,
  normalizeIssueDescription,
  setLastYunxiaoAgent,
  setLastYunxiaoPermission,
} from "../../utils/yunxiao";
import { useI18n } from "../../i18n";
import s from "../../styles";

function agentLabel(agent: AgentType): string {
  return agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "DSH";
}

function typeLabel(categoryId: string | undefined, t: (k: string) => string): string {
  const category = (categoryId ?? "").trim().toLowerCase();
  if (category === "bug") return t("yunxiao.categoryBug");
  if (category === "req") return t("yunxiao.categoryReq");
  if (category === "task") return t("yunxiao.categoryTask");
  return t("yunxiao.direct.typeUnknown");
}

function isBugCategory(categoryId: string | undefined): boolean {
  return (categoryId ?? "").trim().toLowerCase() === "bug";
}

/** 「直接开始」确认项：弹窗不建任务、不下图，确认后才由 App 层建任务并启动。 */
export interface DirectLaunchOptions {
  notes: string;
  agent: AgentType;
  permissionMode: PermissionMode;
  /** 需求类议题「先澄清再执行」；Bug 议题恒为 false（Bug 走 diagnosing-bugs 取证）。 */
  clarifyFirst: boolean;
}

/**
 * 「直接开始」对话框：拉一次议题详情做只读预览（失败不阻断）→ 发起人补充 +
 * 工作流选择（Bug 锁定 diagnosing-bugs；非 Bug 可选先 grilling 澄清）→ 确认后
 * 交由 App 层建任务、下图、拼 prompt 并启动。取消零副作用。
 */
export function DirectLaunchDialog({
  issue,
  targetProjectId,
  projectName,
  settings,
  onStart,
  onClose,
}: {
  issue: YunxiaoWorkitem;
  targetProjectId: string;
  projectName: string;
  settings: YunxiaoSettings;
  onStart: (options: DirectLaunchOptions) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [detail, setDetail] = useState<YunxiaoWorkitem | null>(null);
  const [detailState, setDetailState] = useState<"loading" | "done" | "failed">("loading");
  const [agentSettings, setAgentSettings] = useState<AgentEnabledState | null>(null);
  const [agent, setAgent] = useState<AgentType>(
    () => getLastYunxiaoAgent(targetProjectId) ?? "codex",
  );
  const [permission, setPermission] = useState<PermissionMode>(
    () => getLastYunxiaoPermission(targetProjectId) ?? "ask",
  );
  const [notes, setNotes] = useState("");
  const [clarifyFirst, setClarifyFirst] = useState(false);
  const [starting, setStarting] = useState(false);

  // 类别：详情未就绪时先退回列表行持有的 categoryId（列表接口通常已带）。
  const categoryId = detail?.categoryId ?? issue.categoryId;
  const bug = isBugCategory(categoryId);

  // 1) 打开即拉一次详情做只读预览；失败不阻断（真正阻断留给确认后的建任务阶段）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const item = await invoke<YunxiaoWorkitem>("yunxiao_get_workitem", {
          token: settings.token,
          organizationId: settings.organizationId,
          workitemId: issue.id,
        });
        if (cancelled) return;
        setDetail(item);
        setDetailState("done");
      } catch {
        if (cancelled) return;
        setDetailState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.token, settings.organizationId, issue.id]);

  // 2) Agent 启用状态 + 已禁用 Agent 回退。
  useEffect(() => {
    invoke<AppSettings>("load_app_settings")
      .then((appSettings) => {
        setAgentSettings(appSettings);
        setAgent((prev) => (isAgentEnabled(appSettings, prev) ? prev : firstEnabledAgent(appSettings)));
      })
      .catch(() => undefined);
  }, []);

  // 详情就绪后确认是 Bug 议题时清掉勾选，避免残留状态透传。
  useEffect(() => {
    if (bug && clarifyFirst) setClarifyFirst(false);
  }, [bug, clarifyFirst]);

  const cycleAgent = useCallback(() => {
    setAgent((prev) => {
      const next = cycleEnabledAgent(prev, agentSettings);
      setLastYunxiaoAgent(targetProjectId, next);
      return next;
    });
  }, [agentSettings, targetProjectId]);

  const cyclePermission = useCallback(() => {
    setPermission((prev) => {
      const order: PermissionMode[] = ["ask", "auto_edit", "full_access"];
      const next = order[(order.indexOf(prev) + 1) % order.length];
      setLastYunxiaoPermission(targetProjectId, next);
      return next;
    });
  }, [targetProjectId]);

  const handleStart = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      await onStart({
        notes,
        agent,
        permissionMode: permission,
        clarifyFirst: bug ? false : clarifyFirst,
      });
    } catch {
      // 失败已由 App 层 toast + 任务置 failed 呈现；这里只解锁按钮允许重试。
      setStarting(false);
    }
  }, [starting, onStart, notes, agent, permission, clarifyFirst, bug]);

  const permissionLabel = useMemo(() => {
    if (permission === "full_access") return t("yunxiao.discussion.permYolo");
    if (permission === "auto_edit") return t("yunxiao.discussion.permAuto");
    return t("yunxiao.discussion.permAsk");
  }, [permission, t]);

  const description = detail ? normalizeIssueDescription(detail.description) : "";
  const link = settings.projectId ? buildYunxiaoIssueLink(settings.projectId, issue.id) : "";

  return (
    <div style={s.bbDialogOverlay}>
      <div style={s.planLaunchDialog}>
        <div style={s.planLaunchHead}>
          <div>
            <div style={s.bbDialogTitle}>
              <Zap size={13} strokeWidth={2.2} fill="currentColor" /> {t("yunxiao.direct.dialogTitle")}
            </div>
            <div style={s.planLaunchMeta}>
              {issue.serialNumber} · {t("yunxiao.importToProject")}：{projectName}
            </div>
          </div>
          <button
            type="button"
            style={s.yunxiaoIconBtn}
            onClick={onClose}
            disabled={starting}
            title={t("plan.launch.close")}
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div style={s.planLaunchList}>
          <div style={s.directLaunchDetail}>
            <div style={s.directLaunchDetailHead}>
              <span
                style={bug ? s.directLaunchTypeBadgeBug : s.directLaunchTypeBadge}
              >
                {typeLabel(categoryId, t)}
              </span>
              <span style={s.directLaunchDetailTitle}>{issue.subject}</span>
            </div>
            {detailState === "loading" && (
              <div style={s.directLaunchDetailHint}>
                <Loader2 size={12} className="spin" /> {t("yunxiao.direct.detailLoading")}
              </div>
            )}
            {detailState === "failed" && (
              <div style={s.directLaunchDetailWarn}>
                <AlertTriangle size={12} /> {t("yunxiao.direct.detailFailed")}
              </div>
            )}
            {detailState === "done" && (
              <>
                {description ? (
                  <div style={s.directLaunchDescription}>{description}</div>
                ) : (
                  <div style={s.directLaunchDetailHint}>{t("yunxiao.direct.noDescription")}</div>
                )}
                {!!detail?.imageCount && (
                  <div style={s.directLaunchDetailHint}>
                    {t("yunxiao.images.hint", { count: detail.imageCount })}
                  </div>
                )}
              </>
            )}
            {link && (
              <button
                type="button"
                style={s.directLaunchLink}
                onClick={() => openUrl(link).catch(() => {})}
              >
                <ExternalLink size={12} strokeWidth={2} />
                {t("yunxiao.openInYunxiao")}
              </button>
            )}
          </div>
        </div>

        <div style={s.planLaunchNotes}>
          <label style={s.yunxiaoFieldLabel}>{t("yunxiao.direct.notesLabel")}</label>
          <textarea
            style={s.planLaunchNotesInput}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("yunxiao.direct.notesPlaceholder")}
            rows={3}
          />
        </div>

        <div style={s.directLaunchWorkflow}>
          {bug ? (
            <div style={s.directLaunchFlowBug}>
              {t("yunxiao.direct.flowBug")}
            </div>
          ) : (
            <>
              <label style={s.directLaunchCheckboxLabel}>
                <input
                  type="checkbox"
                  checked={clarifyFirst}
                  onChange={(e) => setClarifyFirst(e.target.checked)}
                />
                {t("yunxiao.direct.clarifyLabel")}
              </label>
              <div style={s.directLaunchFlowHint}>
                {clarifyFirst
                  ? t("yunxiao.direct.flowClarify")
                  : t("yunxiao.direct.flowDirect")}
              </div>
            </>
          )}
        </div>

        <div style={s.planLaunchSettings}>
          <span style={s.yunxiaoDetailSectionHint}>{t("yunxiao.discussion.agent")}</span>
          <button type="button" style={s.yunxiaoAgentBadge} onClick={cycleAgent}>
            {agentLabel(agent)}
          </button>
          {agent !== "dsh" && (
            <button type="button" style={s.yunxiaoAgentBadge} onClick={cyclePermission}>
              {permissionLabel}
            </button>
          )}
        </div>

        <div style={s.bbDialogActions}>
          <button type="button" style={s.bbBtnGhost} onClick={onClose} disabled={starting}>
            {t("plan.launch.cancel")}
          </button>
          <button
            type="button"
            style={starting ? s.bbBtnPrimaryDisabled : s.bbBtnPrimary}
            disabled={starting}
            onClick={() => void handleStart()}
          >
            {starting ? <Loader2 size={13} className="spin" /> : <Play size={13} strokeWidth={2.2} fill="currentColor" />}
            {starting ? t("plan.launch.starting") : t("yunxiao.direct.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
