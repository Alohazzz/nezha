import { useCallback, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BookOpenText, ChevronLeft, ExternalLink, Link2, Play, Unlink } from "lucide-react";
import type { AgentType, PermissionMode, Plan, Task } from "../../../types";
import { buildYunxiaoIssueLink } from "../../../utils/yunxiao";
import { buildPlanDisplayName } from "../../../utils/plan";
import { SelectField } from "../SelectField";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

function agentLabel(agent: AgentType): string {
  return agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "DSH";
}

/** 方案执行待办视图：只读议题卡 + 关联方案条（可换绑/解绑）+ 预览 + 立即运行。 */
export function PlanTaskView({
  task,
  plan,
  plans,
  yunxiaoProjectId,
  onBack,
  onPreviewPlan,
  onRebindPlan,
  onUpdateTodo,
  onRunTodo,
}: {
  task: Task;
  plan: Plan | null;
  /** 本项目可选的关联方案（换绑下拉）。 */
  plans: Plan[];
  yunxiaoProjectId: string;
  onBack: () => void;
  onPreviewPlan: (planId: string) => void;
  onRebindPlan: (taskId: string, planId: string | null) => void | Promise<void>;
  onUpdateTodo: (
    taskId: string,
    updates: { prompt: string; agent: AgentType; permissionMode: PermissionMode },
  ) => void;
  onRunTodo: (task: Task) => void;
}) {
  const { t } = useI18n();
  const [rebinding, setRebinding] = useState(false);

  const link =
    yunxiaoProjectId && task.yunxiaoWorkitemId
      ? buildYunxiaoIssueLink(yunxiaoProjectId, task.yunxiaoWorkitemId)
      : "";

  const rebindOptions = plans
    .filter(
      (candidate) =>
        candidate.id !== plan?.id &&
        (candidate.status === "finalized" || candidate.status === "executing"),
    )
    .map((candidate) => ({
      value: candidate.id,
      label:
        candidate.name ||
        buildPlanDisplayName(candidate.issues.map((issue) => issue.serialNumber)),
    }));

  const handleCycleAgent = useCallback(() => {
    const order: AgentType[] = ["claude", "codex", "dsh"];
    const next = order[(order.indexOf(task.agent) + 1) % order.length];
    onUpdateTodo(task.id, {
      prompt: task.prompt,
      agent: next,
      permissionMode: task.permissionMode,
    });
  }, [task, onUpdateTodo]);

  const handleCyclePermission = useCallback(() => {
    const order: PermissionMode[] = ["ask", "auto_edit", "full_access"];
    const next = order[(order.indexOf(task.permissionMode) + 1) % order.length];
    onUpdateTodo(task.id, {
      prompt: task.prompt,
      agent: task.agent,
      permissionMode: next,
    });
  }, [task, onUpdateTodo]);

  const permissionLabel = useCallback(
    (mode: PermissionMode) => {
      if (mode === "full_access") return t("yunxiao.discussion.permYolo");
      if (mode === "auto_edit") return t("yunxiao.discussion.permAuto");
      return t("yunxiao.discussion.permAsk");
    },
    [t],
  );

  const handleRebind = useCallback(
    async (planId: string | null) => {
      setRebinding(true);
      try {
        await onRebindPlan(task.id, planId);
      } finally {
        setRebinding(false);
      }
    },
    [onRebindPlan, task.id],
  );

  return (
    <div style={s.yunxiaoDetailPane}>
      <div style={s.yunxiaoHeader}>
        <button type="button" style={s.yunxiaoBackBtn} onClick={onBack} title={t("yunxiao.detail.back")}>
          <ChevronLeft size={15} strokeWidth={2} />
        </button>
        <div>
          <div style={s.yunxiaoHeaderTitle}>{task.name ?? t("plan.task.title")}</div>
          <div style={s.yunxiaoHeaderMeta}>
            {task.yunxiaoSerialNumber ? `${task.yunxiaoSerialNumber} · ` : ""}
            {t("plan.task.subtitle")}
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
          <div style={s.yunxiaoDetailSectionTitle}>{t("plan.task.issueSection")}</div>
          {plan ? (
            <div style={s.planLinkedCard}>
              <div style={s.planLinkedHead}>
                <BookOpenText size={14} strokeWidth={2} />
                <span style={s.planLinkedName}>
                  {plan.name ||
                    buildPlanDisplayName(plan.issues.map((issue) => issue.serialNumber))}
                </span>
                {plan.batchId && <span style={s.yunxiaoMetaBadge}>{t("plan.preview.batchLinked")}</span>}
              </div>
              <div style={s.planPanelIssues}>
                {plan.issues.map((issue) => (
                  <span key={issue.workitemId} style={s.yunxiaoMetaBadge}>
                    {issue.serialNumber}
                  </span>
                ))}
              </div>
              <div style={s.planLinkedActions}>
                <button
                  type="button"
                  style={s.yunxiaoGhostBtn}
                  onClick={() => onPreviewPlan(plan.id)}
                >
                  <BookOpenText size={12} strokeWidth={2} />
                  {t("plan.task.preview")}
                </button>
                {rebindOptions.length > 0 && !rebinding && (
                  <div style={s.planRebindSelect}>
                    <Link2 size={12} strokeWidth={2} />
                    <SelectField
                      value=""
                      onChange={(value) => {
                        if (value) void handleRebind(value);
                      }}
                      options={rebindOptions}
                      placeholder={t("plan.task.rebind")}
                    />
                  </div>
                )}
                {!rebinding && (
                  <button
                    type="button"
                    style={s.knowledgeSecondaryBtn}
                    onClick={() => void handleRebind(null)}
                    title={t("plan.task.unbindHint")}
                  >
                    <Unlink size={12} strokeWidth={2} />
                    {t("plan.task.unbind")}
                  </button>
                )}
                {rebinding && <span style={s.planLaunchProgress}>{t("plan.task.rebinding")}</span>}
              </div>
            </div>
          ) : (
            <div style={s.planLinkedCard}>
              <div style={s.planLinkedHead}>
                <Unlink size={14} strokeWidth={2} />
                <span style={s.planLinkedName}>{t("plan.task.unlinked")}</span>
              </div>
              <div style={s.planLinkedActions}>
                {rebindOptions.length > 0 && (
                  <div style={s.planRebindSelect}>
                    <Link2 size={12} strokeWidth={2} />
                    <SelectField
                      value=""
                      onChange={(value) => {
                        if (value) void handleRebind(value);
                      }}
                      options={rebindOptions}
                      placeholder={t("plan.task.rebind")}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section style={s.yunxiaoDetailSection}>
          <div style={s.yunxiaoDetailSectionTitle}>{t("plan.task.runSection")}</div>
          <div style={s.yunxiaoDetailMetaRow}>
            <span style={s.yunxiaoDetailSectionHint}>{t("yunxiao.discussion.agent")}</span>
            <button type="button" style={s.yunxiaoAgentBadge} onClick={handleCycleAgent}>
              {agentLabel(task.agent)}
            </button>
            {task.agent !== "dsh" && (
              <button type="button" style={s.yunxiaoAgentBadge} onClick={handleCyclePermission}>
                {permissionLabel(task.permissionMode)}
              </button>
            )}
          </div>
          <div style={s.yunxiaoFormActions}>
            <button type="button" style={s.yunxiaoPrimaryBtn} onClick={() => onRunTodo(task)}>
              <Play size={11} strokeWidth={2} fill="currentColor" />
              {t("task.runNow")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
