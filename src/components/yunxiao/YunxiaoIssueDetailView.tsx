import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronLeft, ExternalLink, Play, Sparkles } from "lucide-react";
import type {
  AgentType,
  PermissionMode,
  Task,
  YunxiaoSupplement,
  YunxiaoIssueImagesPrepared,
  YunxiaoWorkitem,
} from "../../types";
import { EMPTY_YUNXIAO_SETTINGS, type YunxiaoSettings } from "../app-settings/types";
import {
  buildYunxiaoIssueLink,
  getLastYunxiaoAgent,
  getLastYunxiaoPermission,
  issueTag,
  normalizeIssueDescription,
  setLastYunxiaoPermission,
  setLastYunxiaoAgent,
} from "../../utils/yunxiao";
import {
  buildSupplementedPrompt,
  categoryToFormKind,
  discussionSkillForCategory,
  hasSupplementValues,
} from "./issueForms";
import { SupplementFields } from "./SupplementFields";
import { useI18n } from "../../i18n";
import { useToast } from "../Toast";
import s from "../../styles";

const AGENTS: AgentType[] = ["claude", "codex", "dsh"];
const PERMS: PermissionMode[] = ["ask", "auto_edit", "full_access"];
/** 表单草稿防抖落盘间隔（AGENTS.md：同一 projectId 连续写入需 300-500ms 防抖）。 */
const DRAFT_PERSIST_DEBOUNCE_MS = 400;

/** 定稿判定：显式 finalized 优先；旧数据缺省按「有字段即已定稿」兼容。 */
function isSupplementFinalized(supplement?: YunxiaoSupplement): boolean {
  return supplement?.finalized ?? hasSupplementValues(supplement?.fields);
}

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
  onDraftChange,
  onFinalize,
  onStartDiscussion,
}: {
  task: Task;
  projectPath: string;
  onBack: () => void;
  onDraftChange: (taskId: string, fields: Record<string, string>) => void;
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
  // values 的 ref 镜像：异步回调（预填完成）或组件卸载后仍能读到/写出最新草稿。
  const valuesRef = useRef(values);
  const [prefillState, setPrefillState] = useState<"idle" | "loading" | "failed">("idle");
  const [finalized, setFinalized] = useState<boolean>(() =>
    isSupplementFinalized(task.yunxiaoSupplement),
  );
  const [agent, setAgent] = useState<AgentType>(
    () => getLastYunxiaoAgent(task.projectId) ?? task.agent,
  );
  const [permission, setPermission] = useState<PermissionMode>(
    () => getLastYunxiaoPermission(task.projectId) ?? task.permissionMode,
  );
  // 待办切换时重置全部议题相关状态（否则组件实例复用导致表单/定稿态串台）。
  const [openedTaskId, setOpenedTaskId] = useState(task.id);
  const originalPromptRef = useRef(task.yunxiaoSupplement?.originalPrompt ?? task.prompt);
  if (openedTaskId !== task.id) {
    setOpenedTaskId(task.id);
    originalPromptRef.current = task.yunxiaoSupplement?.originalPrompt ?? task.prompt;
    setDetail(null);
    setValues(task.yunxiaoSupplement?.fields ?? {});
    valuesRef.current = task.yunxiaoSupplement?.fields ?? {};
    setPrefillState("idle");
    setFinalized(isSupplementFinalized(task.yunxiaoSupplement));
    setPermission(getLastYunxiaoPermission(task.projectId) ?? task.permissionMode);
    setAgent(getLastYunxiaoAgent(task.projectId) ?? task.agent);
  }

  // ── 草稿防抖落盘 ────────────────────────────────────────────────────────────
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<{ taskId: string; fields: Record<string, string> } | null>(null);

  const flushDraft = useCallback(() => {
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (pending) onDraftChange(pending.taskId, pending.fields);
  }, [onDraftChange]);

  const scheduleDraftPersist = useCallback(
    (taskId: string, fields: Record<string, string>) => {
      // 切到另一任务后立即编辑：先把上一个任务挂起的草稿落盘，避免被本次替换丢失。
      if (pendingDraftRef.current && pendingDraftRef.current.taskId !== taskId) {
        flushDraft();
      }
      pendingDraftRef.current = { taskId, fields };
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => {
        draftTimerRef.current = null;
        flushDraft();
      }, DRAFT_PERSIST_DEBOUNCE_MS);
    },
    [flushDraft],
  );

  const flushDraftRef = useRef(flushDraft);
  flushDraftRef.current = flushDraft;
  // 组件卸载（如打开文件预览导致主舞台切换）前，把未落盘的草稿写掉。
  useEffect(() => () => flushDraftRef.current(), []);

  // 草稿由 App 层异步写回 task（预填完成/防抖落盘）；本组件已挂载时把最新落盘字段
  // 同步回表单，覆盖「预填期间切走再切回，task 先于组件收到草稿」的时序。
  useEffect(() => {
    if (openedTaskId !== task.id) return;
    const fields = task.yunxiaoSupplement?.fields ?? {};
    if (JSON.stringify(fields) === JSON.stringify(valuesRef.current)) return;
    valuesRef.current = fields;
    setValues(fields);
    setFinalized(isSupplementFinalized(task.yunxiaoSupplement));
  }, [task.yunxiaoSupplement, task.id, openedTaskId]);

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

  const changeField = useCallback(
    (key: string, value: string) => {
      const next = { ...valuesRef.current, [key]: value };
      valuesRef.current = next;
      setValues(next);
      setFinalized(false);
      scheduleDraftPersist(task.id, next);
    },
    [task.id, scheduleDraftPersist],
  );

  const cycleAgent = useCallback(() => {
    setAgent((prev) => {
      const next = AGENTS[(AGENTS.indexOf(prev) + 1) % AGENTS.length];
      setLastYunxiaoAgent(task.projectId, next);
      return next;
    });
  }, [task.projectId]);

  const cyclePermission = useCallback(() => {
    setPermission((prev) => {
      const next = PERMS[(PERMS.indexOf(prev) + 1) % PERMS.length];
      setLastYunxiaoPermission(task.projectId, next);
      return next;
    });
  }, [task.projectId]);

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
      const next = { ...valuesRef.current, ...result.fields };
      valuesRef.current = next;
      setValues(next);
      // 立即落盘（不走防抖）：即使组件已因切到文件预览而卸载，App 层回调仍会写入。
      pendingDraftRef.current = { taskId: task.id, fields: next };
      flushDraft();
      setPrefillState("idle");
    } catch (e) {
      setPrefillState("failed");
      showToast(t("yunxiao.form.prefillFailed", { error: String(e) }), "error");
    }
  }, [prefillState, projectPath, agent, formKind, issueText, link, showToast, t, task.id, flushDraft]);

  const handleFinalize = useCallback(() => {
    // 先取消挂起的草稿写入，避免它以 finalized=false 覆盖本次定稿。
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    pendingDraftRef.current = null;
    const prompt = buildSupplementedPrompt(formKind, values, originalPromptRef.current, link);
    onFinalize(task.id, prompt, {
      fields: values,
      originalPrompt: originalPromptRef.current,
      finalized: true,
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
        taskId: task.id,
      });
      if (instructions.trim()) {
        prompt = `${base}\n\n---\n${instructions.trim()}`;
      }
    } catch (e) {
      console.error("[yunxiao-detail] fetch skill instructions failed:", e);
    }

    // 提交关联议题编号：Agent 直接 commit 时也必须带 #编号，
    // 云效按提交信息自动关联代码到议题，合并 worktree 前也会校验。
    const tag = task.yunxiaoSerialNumber ? issueTag(task.yunxiaoSerialNumber) : "";
    if (tag) {
      prompt = `${prompt}\n\n---\n所有 git commit message 必须包含议题编号 tag（${tag}，如 \`fix: 修复登录失效 ${tag}\`），云效按提交信息中的编号自动关联代码到议题。`;
    }

    // 议题图片：发起讨论时下载到附件目录，路径拼进 prompt 让 Agent 读原图。
    // 全部失败 → 阻断（图片是议题上下文的一部分）；部分失败 → 跳过并提示。
    if (settings.token && settings.organizationId && workitemId) {
      try {
        const images = await invoke<YunxiaoIssueImagesPrepared>("yunxiao_prepare_issue_images", {
          token: settings.token,
          organizationId: settings.organizationId,
          workitemId,
          projectPath,
          taskId: task.id,
        });
        if (images.total > 0) {
          if (images.paths.length > 0) {
            prompt = `${prompt}\n\n[Attached images]\n${images.paths.join("\n")}`;
          }
          if (images.failed === images.total) {
            showToast(
              t("yunxiao.images.allFailed", { error: images.errors[0] ?? "" }),
              "error",
            );
            return;
          }
          if (images.failed > 0) {
            showToast(
              t("yunxiao.images.partial", {
                failed: images.failed,
                downloaded: images.downloaded,
              }),
              "warning",
            );
          } else {
            showToast(t("yunxiao.images.prepared", { count: images.downloaded }), "success");
          }
        }
      } catch (e) {
        console.error("[yunxiao-detail] prepare issue images failed:", e);
        showToast(t("yunxiao.images.allFailed", { error: String(e) }), "error");
        return;
      }
    }
    onStartDiscussion(task.id, prompt, agent, permission);
  }, [
    task.id,
    task.prompt,
    task.yunxiaoSerialNumber,
    detail?.categoryId,
    formKind,
    onStartDiscussion,
    agent,
    permission,
    settings.token,
    settings.organizationId,
    workitemId,
    projectPath,
    showToast,
    t,
  ]);

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
          <SupplementFields
            formKind={formKind}
            values={values}
            projectPath={projectPath}
            onFieldChange={changeField}
          />
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
          {!!detail?.imageCount && (
            <div style={s.yunxiaoImageHint}>
              {t("yunxiao.images.hint", { count: detail.imageCount })}
            </div>
          )}
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
