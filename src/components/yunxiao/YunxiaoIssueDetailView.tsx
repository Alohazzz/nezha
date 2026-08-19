import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronLeft, ExternalLink, Play, Sparkles } from "lucide-react";
import type {
  AgentType,
  PermissionMode,
  Task,
  YunxiaoSupplement,
  YunxiaoWorkitem,
} from "../../types";
import { EMPTY_YUNXIAO_SETTINGS, type YunxiaoSettings } from "../app-settings/types";
import {
  buildYunxiaoIssueLink,
  getLastYunxiaoAgent,
  normalizeIssueDescription,
  setLastYunxiaoAgent,
} from "../../utils/yunxiao";
import {
  buildSupplementedPrompt,
  categoryToFormKind,
  discussionSkillForCategory,
  hasSupplementValues,
  ISSUE_FORM_FIELDS,
} from "./issueForms";
import { useI18n } from "../../i18n";
import { useToast } from "../Toast";
import s from "../../styles";

const AGENTS: AgentType[] = ["claude", "codex", "dsh"];
const PERMS: PermissionMode[] = ["ask", "auto_edit", "full_access"];

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
  onFinalize: (taskId: string, prompt: string, supplement: YunxiaoSupplement) => void;
  onStartDiscussion: (
    taskId: string,
    prompt: string,
    agent: AgentType,
    permissionMode: PermissionMode,
  ) => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();

  const workitemId = task.yunxiaoWorkitemId ?? "";
  const [settings, setSettings] = useState<YunxiaoSettings>(EMPTY_YUNXIAO_SETTINGS);
  const [detail, setDetail] = useState<YunxiaoWorkitem | null>(null);
  const [values, setValues] = useState<Record<string, string>>(
    () => task.yunxiaoSupplement?.fields ?? {},
  );
  const [prefillState, setPrefillState] = useState<"idle" | "loading" | "failed">("idle");
  const [finalized, setFinalized] = useState<boolean>(() =>
    hasSupplementValues(task.yunxiaoSupplement?.fields),
  );
  const [agent, setAgent] = useState<AgentType>(
    () => getLastYunxiaoAgent(task.projectId) ?? task.agent,
  );
  const [permission, setPermission] = useState<PermissionMode>(task.permissionMode);
  // 待办切换时重置全部议题相关状态（否则组件实例复用导致表单/定稿态串台）。
  const [openedTaskId, setOpenedTaskId] = useState(task.id);
  const originalPromptRef = useRef(task.yunxiaoSupplement?.originalPrompt ?? task.prompt);
  if (openedTaskId !== task.id) {
    setOpenedTaskId(task.id);
    originalPromptRef.current = task.yunxiaoSupplement?.originalPrompt ?? task.prompt;
    setDetail(null);
    setValues(task.yunxiaoSupplement?.fields ?? {});
    setPrefillState("idle");
    setFinalized(hasSupplementValues(task.yunxiaoSupplement?.fields));
    setPermission(task.permissionMode);
    setAgent(getLastYunxiaoAgent(task.projectId) ?? task.agent);
  }

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
          return;
        }
        const item = await invoke<YunxiaoWorkitem>("yunxiao_get_workitem", {
          token: yunxiao.token,
          organizationId: yunxiao.organizationId,
          workitemId,
        });
        if (cancelled) return;
        setDetail(item);
      } catch (e) {
        if (cancelled) return;
        console.error("[yunxiao-detail] load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workitemId]);

  const issueText = useMemo(() => {
    if (detail) {
      const description = normalizeIssueDescription(detail.description);
      return [detail.serialNumber, detail.subject, description]
        .filter(Boolean)
        .join("\n\n");
    }
    return task.prompt;
  }, [detail, task.prompt]);

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

  const cyclePermission = useCallback(() => {
    setPermission((prev) => PERMS[(PERMS.indexOf(prev) + 1) % PERMS.length]);
  }, []);

  const permissionLabel = useCallback(
    (mode: PermissionMode) => {
      if (mode === "full_access") return t("yunxiao.discussion.permYolo");
      if (mode === "auto_edit") return t("yunxiao.discussion.permAuto");
      return t("yunxiao.discussion.permAsk");
    },
    [t],
  );

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
    onFinalize(task.id, prompt, {
      fields: values,
      originalPrompt: originalPromptRef.current,
    });
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
    onStartDiscussion(task.id, prompt, agent, permission);
  }, [task.id, task.prompt, detail?.categoryId, formKind, onStartDiscussion, agent, permission]);

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
            {agent !== "dsh" && (
              <button type="button" style={s.yunxiaoAgentBadge} onClick={cyclePermission}>
                {permissionLabel(permission)}
              </button>
            )}
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
