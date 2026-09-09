import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronLeft, ExternalLink, Play, Zap } from "lucide-react";
import type {
  AgentType,
  PermissionMode,
  Task,
  YunxiaoWorkitem,
} from "../../types";
import {
  isAgentEnabled,
  firstEnabledAgent,
  cycleEnabledAgent,
  type AgentEnabledState,
} from "../../types";
import {
  EMPTY_YUNXIAO_SETTINGS,
  type AppSettings,
  type YunxiaoSettings,
} from "../app-settings/types";
import {
  buildYunxiaoIssueLink,
  getLastYunxiaoAgent,
  getLastYunxiaoPermission,
  setLastYunxiaoAgent,
  setLastYunxiaoPermission,
} from "../../utils/yunxiao";
import { useI18n } from "../../i18n";
import s from "../../styles";

const PERMS: PermissionMode[] = ["ask", "auto_edit", "full_access"];

function agentLabel(agent: AgentType): string {
  return agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "DSH";
}

/**
 * 云效绑定待办（补录议题 / 存量导入）的讨论入口视图：不再有补充表单与定稿，
 * 直接「发起讨论」——待办自身转化为方案讨论任务（建 plan、写 plan.md、方案预览、
 * 生成待办，全走联合分析链路）。
 */
export function YunxiaoTodoDiscussionView({
  task,
  starting,
  onBack,
  onStartDiscussion,
  onStartDirect,
}: {
  task: Task;
  /** App 层发起中标记（拉详情/图片期间按钮锁定，讨论与直接开始共用）。 */
  starting: boolean;
  onBack: () => void;
  onStartDiscussion: (
    taskId: string,
    notes: string,
    agent: AgentType,
    permissionMode: PermissionMode,
  ) => void;
  /** 「直接开始」：待办原地转为直接执行任务（无方案、无讨论）。 */
  onStartDirect: (
    taskId: string,
    notes: string,
    agent: AgentType,
    permissionMode: PermissionMode,
  ) => void;
}) {
  const { t } = useI18n();

  const workitemId = task.yunxiaoWorkitemId ?? "";
  const [settings, setSettings] = useState<YunxiaoSettings>(EMPTY_YUNXIAO_SETTINGS);
  const [detail, setDetail] = useState<YunxiaoWorkitem | null>(null);
  const [agent, setAgent] = useState<AgentType>(
    () => getLastYunxiaoAgent(task.projectId) ?? task.agent,
  );
  const [permission, setPermission] = useState<PermissionMode>(
    () => getLastYunxiaoPermission(task.projectId) ?? task.permissionMode,
  );
  const [agentSettings, setAgentSettings] = useState<AgentEnabledState | null>(null);
  // 发起人手动补充（背景/参考资料/已有方案），原样拼进讨论 prompt。
  const [notes, setNotes] = useState("");
  // 待办切换时重置议题相关状态（组件实例复用防串台）。
  const [openedTaskId, setOpenedTaskId] = useState(task.id);
  if (openedTaskId !== task.id) {
    setOpenedTaskId(task.id);
    setDetail(null);
    setPermission(getLastYunxiaoPermission(task.projectId) ?? task.permissionMode);
    setAgent(getLastYunxiaoAgent(task.projectId) ?? task.agent);
    setNotes("");
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const appSettings = await invoke<AppSettings>("load_app_settings");
        if (cancelled) return;
        const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
        setSettings(yunxiao);
        setAgentSettings(appSettings);
        if (!yunxiao.token || !yunxiao.organizationId || !workitemId) return;
        const item = await invoke<YunxiaoWorkitem>("yunxiao_get_workitem", {
          token: yunxiao.token,
          organizationId: yunxiao.organizationId,
          workitemId,
        });
        if (cancelled) return;
        setDetail(item);
      } catch (e) {
        if (cancelled) return;
        console.error("[yunxiao-todo-discussion] load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workitemId]);

  // 若当前 Agent 已禁用（记忆/任务自身指向禁用 Agent），回退到第一个启用的 Agent。
  useEffect(() => {
    if (isAgentEnabled(agentSettings, agent)) return;
    setAgent(firstEnabledAgent(agentSettings));
  }, [agent, agentSettings]);

  const link = useMemo(
    () =>
      settings.projectId && workitemId
        ? buildYunxiaoIssueLink(settings.projectId, workitemId)
        : "",
    [settings.projectId, workitemId],
  );

  const cycleAgent = useCallback(() => {
    setAgent((prev) => {
      const next = cycleEnabledAgent(prev, agentSettings);
      setLastYunxiaoAgent(task.projectId, next);
      return next;
    });
  }, [agentSettings, task.projectId]);

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

  const handleStart = useCallback(() => {
    if (starting) return;
    onStartDiscussion(task.id, notes, agent, permission);
  }, [starting, notes, agent, permission, onStartDiscussion, task.id]);

  const handleStartDirect = useCallback(() => {
    if (starting) return;
    onStartDirect(task.id, notes, agent, permission);
  }, [starting, notes, agent, permission, onStartDirect, task.id]);

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
            {t("yunxiao.todoDiscussion.subtitle")}
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
          <div style={s.yunxiaoIssuePromptPreview}>{task.prompt}</div>
          {!!detail?.imageCount && (
            <div style={s.yunxiaoImageHint}>
              {t("yunxiao.images.hint", { count: detail.imageCount })}
            </div>
          )}
        </section>

        <section style={s.yunxiaoDetailSection}>
          <div style={s.yunxiaoDetailSectionTitle}>{t("yunxiao.todoDiscussion.title")}</div>
          <div style={s.yunxiaoDetailSectionHint}>{t("yunxiao.todoDiscussion.hint")}</div>
          <div style={s.planLaunchNotes}>
            <label style={s.yunxiaoFieldLabel}>{t("plan.launch.notesLabel")}</label>
            <textarea
              style={s.planLaunchNotesInput}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("plan.launch.notesPlaceholder")}
              rows={3}
            />
          </div>
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
            {starting && <span style={s.planLaunchProgress}>{t("plan.launch.starting")}</span>}
          </div>
          <div style={s.yunxiaoFormActions}>
            <button
              type="button"
              style={starting ? s.yunxiaoPrimaryBtnDisabled : s.yunxiaoPrimaryBtn}
              disabled={starting}
              onClick={handleStart}
            >
              <Play size={11} strokeWidth={2} fill="currentColor" />
              {t("yunxiao.discussion.start")}
            </button>
            <button
              type="button"
              style={starting ? s.yunxiaoGhostBtnDisabled : s.yunxiaoGhostBtn}
              disabled={starting}
              onClick={handleStartDirect}
              title={t("yunxiao.direct.rowHint")}
            >
              <Zap size={11} strokeWidth={2.2} fill="currentColor" />
              {t("yunxiao.direct.start")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
