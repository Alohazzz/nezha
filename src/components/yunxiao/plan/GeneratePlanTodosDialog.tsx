import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Loader2, X } from "lucide-react";
import type {
  AgentType,
  AgentEnabledState,
  PermissionMode,
  Plan,
  PlanIssue,
  Task,
} from "../../../types";
import { isAgentEnabled, firstEnabledAgent, cycleEnabledAgent } from "../../../types";
import {
  getLastYunxiaoAgent,
  getLastYunxiaoPermission,
  setLastYunxiaoAgent,
  setLastYunxiaoPermission,
} from "../../../utils/yunxiao";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

interface RowState {
  issue: PlanIssue;
  /** removed = 用户剔除；conflict = 议题已被单独导入（自动排除）。 */
  excluded: "none" | "removed" | "conflict";
}

function agentLabel(agent: AgentType): string {
  return agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "DSH";
}

/**
 * 「生成待办」确认页：调整执行顺序（上移/下移）、剔除议题（冲突议题自动排除）、
 * 配置 Agent/权限；确认后直接生成 N 个普通待办（跑在当前工作区，不自动建批）。
 */
export function GeneratePlanTodosDialog({
  plan,
  tasks,
  onCreateTodos,
  onClose,
}: {
  plan: Plan;
  tasks: Task[];
  onCreateTodos: (input: {
    planId: string;
    issues: PlanIssue[];
    agent: AgentType;
    permissionMode: PermissionMode;
  }) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [rows, setRows] = useState<RowState[]>(() =>
    plan.issues.map((issue) => ({
      issue,
      excluded: tasks.some((task) => task.yunxiaoWorkitemId === issue.workitemId)
        ? ("conflict" as const)
        : ("none" as const),
    })),
  );
  const [agentSettings, setAgentSettings] = useState<AgentEnabledState | null>(null);
  const [agent, setAgent] = useState<AgentType>(
    () => getLastYunxiaoAgent(plan.projectId) ?? "codex",
  );
  const [permission, setPermission] = useState<PermissionMode>(
    () => getLastYunxiaoPermission(plan.projectId) ?? "ask",
  );
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    invoke<AgentEnabledState>("load_app_settings")
      .then((appSettings) => {
        setAgentSettings(appSettings);
        setAgent((prev) =>
          isAgentEnabled(appSettings, prev) ? prev : firstEnabledAgent(appSettings),
        );
      })
      .catch(() => undefined);
  }, []);

  const activeRows = rows.filter((row) => row.excluded === "none");
  const conflictCount = rows.filter((row) => row.excluded === "conflict").length;
  const canCreate = !creating && activeRows.length > 0;

  const move = useCallback((index: number, delta: -1 | 1) => {
    setRows((prev) => {
      const activeIndices = prev
        .map((row, i) => (row.excluded === "none" ? i : -1))
        .filter((i) => i >= 0);
      const pos = activeIndices.indexOf(index);
      const target = pos + delta;
      if (target < 0 || target >= activeIndices.length) return prev;
      const a = activeIndices[pos];
      const b = activeIndices[target];
      const next = [...prev];
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
  }, []);

  const removeRow = useCallback((issueId: string) => {
    setRows((prev) =>
      prev.map((row) =>
        row.issue.workitemId === issueId && row.excluded === "none"
          ? { ...row, excluded: "removed" as const }
          : row,
      ),
    );
  }, []);

  const cycleAgent = useCallback(() => {
    setAgent((prev) => {
      const next = cycleEnabledAgent(prev, agentSettings);
      setLastYunxiaoAgent(plan.projectId, next);
      return next;
    });
  }, [agentSettings, plan.projectId]);

  const cyclePermission = useCallback(() => {
    setPermission((prev) => {
      const order: PermissionMode[] = ["ask", "auto_edit", "full_access"];
      const next = order[(order.indexOf(prev) + 1) % order.length];
      setLastYunxiaoPermission(plan.projectId, next);
      return next;
    });
  }, [plan.projectId]);

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const ok = await onCreateTodos({
        planId: plan.id,
        issues: activeRows.map((row) => row.issue),
        agent,
        permissionMode: permission,
      });
      if (!ok) setCreating(false);
    } catch {
      setCreating(false);
    }
  }, [canCreate, onCreateTodos, plan.id, activeRows, agent, permission]);

  const permissionLabel =
    permission === "full_access"
      ? t("yunxiao.discussion.permYolo")
      : permission === "auto_edit"
        ? t("yunxiao.discussion.permAuto")
        : t("yunxiao.discussion.permAsk");

  let activeIndex = -1;

  return (
    <div style={s.bbDialogOverlay}>
      <div style={s.planLaunchDialog}>
        <div style={s.planLaunchHead}>
          <div>
            <div style={s.bbDialogTitle}>{t("plan.generate.title")}</div>
            <div style={s.planLaunchMeta}>{t("plan.generate.hint")}</div>
          </div>
          <button type="button" style={s.yunxiaoIconBtn} onClick={onClose} title={t("plan.launch.close")}>
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div style={s.planLaunchList}>
          {rows.map((row) => {
            if (row.excluded === "removed") return null;
            const isActive = row.excluded === "none";
            if (isActive) activeIndex += 1;
            const currentIndex = activeIndex;
            return (
              <div
                key={row.issue.workitemId}
                style={isActive ? s.planLaunchItem : s.planLaunchItemExcluded}
              >
                <span style={s.planLaunchOrder}>{isActive ? currentIndex + 1 : "—"}</span>
                <div style={s.planLaunchItemBody}>
                  <div style={s.planLaunchItemTitle}>
                    <span style={s.yunxiaoIssueSerial}>{row.issue.serialNumber}</span>
                    {row.issue.subject}
                  </div>
                  {row.excluded === "conflict" && (
                    <div style={s.planLaunchItemNote}>{t("plan.generate.conflict")}</div>
                  )}
                </div>
                {isActive && (
                  <div style={s.planLaunchItemActions}>
                    <button
                      type="button"
                      style={s.planLaunchMiniBtn}
                      disabled={currentIndex === 0}
                      onClick={() => move(currentIndex, -1)}
                      title={t("plan.generate.moveUp")}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      style={s.planLaunchMiniBtn}
                      disabled={currentIndex === activeRows.length - 1}
                      onClick={() => move(currentIndex, 1)}
                      title={t("plan.generate.moveDown")}
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      type="button"
                      style={s.planLaunchMiniBtn}
                      onClick={() => removeRow(row.issue.workitemId)}
                      title={t("plan.launch.remove")}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {conflictCount > 0 && (
            <div style={s.planLaunchItemNote}>{t("plan.generate.conflictCount", { count: conflictCount })}</div>
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
          <button type="button" style={s.bbBtnGhost} onClick={onClose} disabled={creating}>
            {t("plan.launch.cancel")}
          </button>
          <button
            type="button"
            style={canCreate ? s.bbBtnPrimary : s.bbBtnPrimaryDisabled}
            disabled={!canCreate}
            onClick={() => void handleCreate()}
          >
            {creating && <Loader2 size={13} className="spin" />}
            {creating
              ? t("plan.generate.creating")
              : t("plan.generate.create", { count: activeRows.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
