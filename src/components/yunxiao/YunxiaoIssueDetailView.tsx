import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronLeft, ExternalLink, Play, Sparkles } from "lucide-react";
import type { AgentType, Task, YunxiaoWorkitem } from "../../types";
import { EMPTY_YUNXIAO_SETTINGS, type YunxiaoSettings } from "../app-settings/types";
import {
  buildYunxiaoIssueLink,
  getLastYunxiaoAgent,
  getYunxiaoPriority,
  setLastYunxiaoAgent,
} from "../../utils/yunxiao";
import {
  buildSupplementedPrompt,
  categoryToFormKind,
  discussionSkillForCategory,
  ISSUE_FORM_FIELDS,
} from "./issueForms";
import { useI18n } from "../../i18n";
import { useToast } from "../Toast";
import s from "../../styles";

const AGENTS: AgentType[] = ["claude", "codex", "dsh"];

function agentLabel(agent: AgentType): string {
  return agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "DSH";
}

function skillLabelKey(skill: "grilling" | "diagnosing-bugs" | "none"): string {
  if (skill === "diagnosing-bugs") return "yunxiao.skill.diagnosingBugs";
  if (skill === "grilling") return "yunxiao.skill.grilling";
  return "yunxiao.skill.none";
}

export function YunxiaoIssueDetailView({
  task,
  projectPath,
  onBack,
  onFinalize,
  onStartDiscussion,
}: {
  task: Task;
  projectPath: string;
  onBack: () => void;
  onFinalize: (taskId: string, prompt: string) => void;
  onStartDiscussion: (taskId: string, prompt: string, agent: AgentType) => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();

  const workitemId = task.yunxiaoWorkitemId ?? "";
  // 定稿基线：任务首次打开时的原始 prompt；重复预填/定稿不会把已补全内容再包一层。
  const originalPromptRef = useRef(task.prompt);
  const [openedTaskId, setOpenedTaskId] = useState(task.id);
  if (openedTaskId !== task.id) {
    setOpenedTaskId(task.id);
    originalPromptRef.current = task.prompt;
  }
  const [settings, setSettings] = useState<YunxiaoSettings>(EMPTY_YUNXIAO_SETTINGS);
  const [detail, setDetail] = useState<YunxiaoWorkitem | null>(null);
  const [detailState, setDetailState] = useState<"loading" | "loaded" | "failed">("loading");
  const [values, setValues] = useState<Record<string, string>>({});
  const [prefillState, setPrefillState] = useState<"idle" | "loading" | "failed">("idle");
  const [finalized, setFinalized] = useState(false);
  const [agent, setAgent] = useState<AgentType>(
    () => getLastYunxiaoAgent(task.projectId) ?? task.agent,
  );

  const link = useMemo(
    () =>
      settings.projectId && workitemId
        ? buildYunxiaoIssueLink(settings.projectId, workitemId)
        : "",
    [settings.projectId, workitemId],
  );
  const formKind = useMemo(() => categoryToFormKind(detail?.categoryId), [detail?.categoryId]);
  const skill = useMemo(
    () => discussionSkillForCategory(detail?.categoryId),
    [detail?.categoryId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const appSettings = await invoke<{ yunxiao?: YunxiaoSettings }>("load_app_settings");
        if (cancelled) return;
        const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
        setSettings(yunxiao);
        if (!yunxiao.token || !yunxiao.organizationId || !workitemId) {
          setDetailState("failed");
          return;
        }
        const item = await invoke<YunxiaoWorkitem>("yunxiao_get_workitem", {
          token: yunxiao.token,
          organizationId: yunxiao.organizationId,
          workitemId,
        });
        if (cancelled) return;
        setDetail(item);
        setDetailState("loaded");
      } catch (e) {
        if (cancelled) return;
        console.error("[yunxiao-detail] load failed:", e);
        setDetailState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workitemId]);

  const issueText = useMemo(() => {
    if (detail) {
      return [detail.serialNumber, detail.subject, detail.description ?? ""]
        .filter(Boolean)
        .join("\n\n");
    }
    return task.prompt;
  }, [detail, task.prompt]);

  const priority = detail ? getYunxiaoPriority(detail) : undefined;
  const createdLabel = detail?.gmtCreate
    ? new Date(detail.gmtCreate).toLocaleString()
    : undefined;

  const changeField = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFinalized(false);
  }, []);

  const cycleAgent = useCallback(() => {
    setAgent((prev) => {
      const next = AGENTS[(AGENTS.indexOf(prev) + 1) % AGENTS.length];
      setLastYunxiaoAgent(task.projectId, next);
      return next;
    });
  }, [task.projectId]);

  const handlePrefill = useCallback(async () => {
    if (prefillState === "loading") return;
    setPrefillState("loading");
    try {
      const result = await invoke<{ fields: Record<string, string> }>(
        "generate_issue_supplement",
        {
          projectPath,
          agent,
          category: formKind === "bug" ? "Bug" : "Req",
          issueText,
          link,
        },
      );
      setValues((prev) => ({ ...prev, ...result.fields }));
      setPrefillState("idle");
    } catch (e) {
      setPrefillState("failed");
      showToast(t("yunxiao.form.prefillFailed", { error: String(e) }), "error");
    }
  }, [prefillState, projectPath, agent, formKind, issueText, link, showToast, t]);

  const handleFinalize = useCallback(() => {
    const prompt = buildSupplementedPrompt(formKind, values, originalPromptRef.current, link);
    onFinalize(task.id, prompt);
    setFinalized(true);
    showToast(t("yunxiao.form.finalizeSuccess"), "success");
  }, [formKind, values, task.id, link, onFinalize, showToast, t]);

  const handleStartDiscussion = useCallback(async () => {
    // 定稿后 task.prompt 已是「补全内容 + 原文 + 云效链接」，直接作为讨论基线；
    // 再按类型从后端取 Skill 指令追加，保证 Req→grilling / Bug→diagnosing-bugs。
    const base = task.prompt;
    let prompt = base;
    try {
      const category = detail?.categoryId ?? (formKind === "bug" ? "Bug" : "Req");
      const instructions = await invoke<string>("get_issue_discussion_instructions", {
        category,
      });
      if (instructions.trim()) {
        prompt = `${base}\n\n---\n${instructions.trim()}`;
      }
    } catch (e) {
      console.error("[yunxiao-detail] fetch skill instructions failed:", e);
    }
    onStartDiscussion(task.id, prompt, agent);
  }, [task.id, task.prompt, detail?.categoryId, formKind, onStartDiscussion, agent]);

  const hasAnyValue = Object.values(values).some((v) => v.trim().length > 0);

  return (
    <div style={s.yunxiaoDetailPane}>
      <div style={s.yunxiaoHeader}>
        <button type="button" style={s.yunxiaoBackBtn} onClick={onBack} title={t("yunxiao.detail.back")}>
          <ChevronLeft size={15} strokeWidth={2} />
        </button>
        <div>
          <div style={s.yunxiaoHeaderTitle}>{task.name ?? t("yunxiao.detail.issueSection")}</div>
          <div style={s.yunxiaoHeaderMeta}>
            {task.yunxiaoSerialNumber ? `${task.yunxiaoSerialNumber} · ` : ""}
            {t(formKind === "bug" ? "yunxiao.categoryBug" : "yunxiao.categoryReq")}
          </div>
        </div>
        <div style={s.yunxiaoHeaderActions}>
          {link && (
            <button
              type="button"
              style={s.yunxiaoGhostBtn}
              onClick={() => openUrl(link).catch(() => {})}
            >
              <ExternalLink size={12} strokeWidth={2} />
              {t("yunxiao.openInYunxiao")}
            </button>
          )}
        </div>
      </div>

      <div style={s.yunxiaoDetailBody}>
        <section style={s.yunxiaoDetailSection}>
          <div style={s.yunxiaoDetailSectionTitle}>{t("yunxiao.detail.issueSection")}</div>
          {detailState === "loading" ? (
            <div style={s.yunxiaoDetailSectionHint}>{t("yunxiao.detail.issueLoading")}</div>
          ) : (
            <>
              {detail && (
                <div style={s.yunxiaoDetailMetaRow}>
                  {detail.status?.displayName && (
                    <span style={s.yunxiaoMetaBadge}>{detail.status.displayName}</span>
                  )}
                  {priority && <span style={s.yunxiaoMetaBadge}>{priority}</span>}
                  {detail.assignedTo?.name && (
                    <span style={s.yunxiaoMetaBadge}>{detail.assignedTo.name}</span>
                  )}
                  {createdLabel && <span>{createdLabel}</span>}
                </div>
              )}
              <div style={s.yunxiaoDetailIssueText}>
                {detail
                  ? detail.description?.trim() || detail.subject
                  : task.prompt}
              </div>
              {detailState === "failed" && (
                <div style={s.yunxiaoDetailError}>{t("yunxiao.detail.issueLoadFailed")}</div>
              )}
            </>
          )}
        </section>

        <section style={s.yunxiaoDetailSection}>
          <div style={s.yunxiaoDetailSectionTitle}>{t("yunxiao.form.title")}</div>
          <div style={s.yunxiaoDetailSectionHint}>{t("yunxiao.form.finalizeHint")}</div>
          <div style={s.yunxiaoFormFields}>
            {ISSUE_FORM_FIELDS[formKind].map((field) => (
              <label key={field.key} style={s.yunxiaoFormField}>
                <span style={s.yunxiaoFormFieldLabel}>{t(field.labelKey)}</span>
                {field.key === "subject" ? (
                  <input
                    style={s.yunxiaoFormInput}
                    value={values[field.key] ?? ""}
                    onChange={(e) => changeField(field.key, e.target.value)}
                  />
                ) : (
                  <textarea
                    style={s.yunxiaoFormTextarea}
                    value={values[field.key] ?? ""}
                    onChange={(e) => changeField(field.key, e.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
          {prefillState === "failed" && (
            <div style={s.yunxiaoDetailError}>{t("yunxiao.form.prefillFailedHint")}</div>
          )}
          <div style={s.yunxiaoFormActions}>
            <button
              type="button"
              style={prefillState === "loading" ? s.yunxiaoGhostBtnDisabled : s.yunxiaoGhostBtn}
              disabled={prefillState === "loading"}
              onClick={handlePrefill}
            >
              <Sparkles size={12} strokeWidth={2} />
              {prefillState === "loading"
                ? t("yunxiao.form.prefilling")
                : t("yunxiao.form.aiPrefill")}
            </button>
            <button
              type="button"
              style={
                hasAnyValue && prefillState !== "loading"
                  ? s.yunxiaoPrimaryBtn
                  : s.yunxiaoPrimaryBtnDisabled
              }
              disabled={!hasAnyValue || prefillState === "loading"}
              onClick={handleFinalize}
            >
              {finalized ? t("yunxiao.form.finalized") : t("yunxiao.form.finalize")}
            </button>
          </div>
        </section>

        <section style={s.yunxiaoDetailSection}>
          <div style={s.yunxiaoDetailSectionTitle}>{t("yunxiao.discussion.title")}</div>
          <div style={s.yunxiaoDetailMetaRow}>
            <span style={s.yunxiaoDetailSectionHint}>{t("yunxiao.discussion.agent")}</span>
            <button type="button" style={s.yunxiaoAgentBadge} onClick={cycleAgent}>
              {agentLabel(agent)}
            </button>
            <span style={s.yunxiaoSkillBadge}>{t(skillLabelKey(skill))}</span>
          </div>
          {!finalized && (
            <div style={s.yunxiaoDetailError}>{t("yunxiao.discussion.finalizeFirst")}</div>
          )}
          <div style={s.yunxiaoFormActions}>
            <button
              type="button"
              style={finalized ? s.yunxiaoPrimaryBtn : s.yunxiaoPrimaryBtnDisabled}
              disabled={!finalized}
              onClick={handleStartDiscussion}
            >
              <Play size={11} strokeWidth={2} fill="currentColor" />
              {t("yunxiao.discussion.start")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
