import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, Loader2, Play, X } from "lucide-react";
import type {
  AgentType,
  PermissionMode,
  Plan,
  PlanIssue,
  YunxiaoIssueImagesPrepared,
  YunxiaoWorkitem,
} from "../../../types";
import { isAgentEnabled, firstEnabledAgent, cycleEnabledAgent, type AgentEnabledState } from "../../../types";
import { buildPlanDiscussionPrompt, buildPlanDisplayName } from "../../../utils/plan";
import type { YunxiaoSettings } from "../../app-settings/types";
import {
  buildYunxiaoIssueLink,
  getLastYunxiaoAgent,
  getLastYunxiaoPermission,
  setLastYunxiaoAgent,
  setLastYunxiaoPermission,
} from "../../../utils/yunxiao";
import { useI18n } from "../../../i18n";
import { useToast } from "../../Toast";
import s from "../../../styles";

/** 单议题拉取状态：pending → loading → done | failed；removed = 用户剔除。 */
type ItemStatus = "pending" | "loading" | "done" | "failed" | "removed";

interface LaunchItem {
  issue: YunxiaoWorkitem;
  status: ItemStatus;
  detail?: YunxiaoWorkitem;
  imagePaths: string[];
  imageWarning?: string;
  error?: string;
}

const FETCH_CONCURRENCY = 2;

function agentLabel(agent: AgentType): string {
  return agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "DSH";
}

/**
 * 发起联合分析对话框：创建 draft 方案 → 并发拉取详情 + 图片（挂方案目录）→
 * 确认（agent/权限、失败项重试/剔除）→ 组装讨论 prompt 并启动方案讨论任务。
 * 任何非「发起」路径关闭都视为取消：删除 draft 方案记录与已下载图片。
 */
export function PlanLaunchDialog({
  issues,
  targetProjectId,
  projectPath,
  projectName,
  settings,
  onCreatePlan,
  onStartDiscussion,
  onCancelPlan,
  onClose,
}: {
  issues: YunxiaoWorkitem[];
  targetProjectId: string;
  projectPath: string;
  projectName: string;
  settings: YunxiaoSettings;
  onCreatePlan: (targetProjectId: string, issues: PlanIssue[]) => Plan;
  onStartDiscussion: (planId: string, prompt: string, agent: AgentType, permissionMode: PermissionMode) => void;
  onCancelPlan: (planId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [items, setItems] = useState<LaunchItem[]>(() =>
    issues.map((issue) => ({ issue, status: "pending" as ItemStatus, imagePaths: [] })),
  );
  const itemsRef = useRef(items);
  const [retryNonce, setRetryNonce] = useState(0);
  const [agentSettings, setAgentSettings] = useState<AgentEnabledState | null>(null);
  const [agent, setAgent] = useState<AgentType>(
    () => getLastYunxiaoAgent(targetProjectId) ?? "codex",
  );
  const [permission, setPermission] = useState<PermissionMode>(
    () => getLastYunxiaoPermission(targetProjectId) ?? "ask",
  );
  const [starting, setStarting] = useState(false);
  const startedRef = useRef(false);

  const updateItem = useCallback((issueId: string, patch: Partial<LaunchItem>) => {
    setItems((prev) => {
      const next = prev.map((item) =>
        item.issue.id === issueId ? { ...item, ...patch } : item,
      );
      itemsRef.current = next;
      return next;
    });
  }, []);

  // 1) 打开即创建 draft 方案（图片与讨论任务挂其下）。
  useEffect(() => {
    const snapshots: PlanIssue[] = issues.map((issue) => ({
      workitemId: issue.id,
      serialNumber: issue.serialNumber,
      subject: issue.subject,
      category: issue.categoryId ?? "",
    }));
    setPlan(onCreatePlan(targetProjectId, snapshots));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agent 启用状态 + 已禁用 Agent 回退。
  useEffect(() => {
    invoke<AgentEnabledState>("load_app_settings")
      .then((appSettings) => {
        setAgentSettings(appSettings);
        setAgent((prev) => (isAgentEnabled(appSettings, prev) ? prev : firstEnabledAgent(appSettings)));
      })
      .catch(() => undefined);
  }, []);

  // 2) 并发拉取（池 = 2）：单条失败不阻断整批，可重试/剔除。
  useEffect(() => {
    if (!plan) return;
    let cancelled = false;
    const token = settings.token;
    const organizationId = settings.organizationId;
    const worker = async () => {
      while (!cancelled) {
        const next = itemsRef.current.find((item) => item.status === "pending");
        if (!next) return;
        updateItem(next.issue.id, { status: "loading" });
        try {
          const detail = await invoke<YunxiaoWorkitem>("yunxiao_get_workitem", {
            token,
            organizationId,
            workitemId: next.issue.id,
          });
          const images = await invoke<YunxiaoIssueImagesPrepared>(
            "yunxiao_prepare_issue_images",
            {
              token,
              organizationId,
              workitemId: next.issue.id,
              projectPath,
              planId: plan.id,
            },
          );
          if (cancelled) return;
          updateItem(next.issue.id, {
            status: "done",
            detail,
            imagePaths: images.paths,
            imageWarning:
              images.failed > 0
                ? t("plan.launch.imagePartial", {
                    failed: images.failed,
                    downloaded: images.downloaded,
                  })
                : undefined,
          });
        } catch (e) {
          if (cancelled) return;
          updateItem(next.issue.id, { status: "failed", error: String(e) });
        }
      }
    };
    void Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.id, retryNonce]);

  const doneItems = useMemo(
    () => items.filter((item) => item.status === "done" && item.detail),
    [items],
  );
  const working = items.some((item) => item.status === "loading" || item.status === "pending");
  const canStart = !working && !starting && doneItems.length > 0;

  const handleRetry = useCallback((issueId: string) => {
    setItems((prev) => {
      const next = prev.map((item) =>
        item.issue.id === issueId
          ? { ...item, status: "pending" as ItemStatus, error: undefined }
          : item,
      );
      itemsRef.current = next;
      return next;
    });
    setRetryNonce((nonce) => nonce + 1);
  }, []);

  const handleRemove = useCallback((issueId: string) => {
    updateItem(issueId, { status: "removed" });
  }, [updateItem]);

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

  const handleClose = useCallback(() => {
    // 非「发起」路径关闭 = 取消：清理 draft 方案。
    if (plan && !startedRef.current) {
      void onCancelPlan(plan.id);
    }
    onClose();
  }, [plan, onCancelPlan, onClose]);

  const handleStart = useCallback(async () => {
    if (!plan || starting || !canStart) return;
    setStarting(true);
    try {
      const instructions = await invoke<string>("get_plan_discussion_instructions", {
        projectPath,
        planId: plan.id,
      });
      const prompt = buildPlanDiscussionPrompt({
        issues: doneItems.map((item) => item.detail!),
        imagePathsByIssue: Object.fromEntries(
          doneItems.map((item) => [item.issue.id, item.imagePaths]),
        ),
        linksByIssue: Object.fromEntries(
          doneItems.map((item) => [
            item.issue.id,
            settings.projectId
              ? buildYunxiaoIssueLink(settings.projectId, item.issue.id)
              : "",
          ]),
        ),
        instructions,
      });
      startedRef.current = true;
      onStartDiscussion(plan.id, prompt, agent, permission);
    } catch (e) {
      setStarting(false);
      showToast(t("plan.launch.startFailed", { error: String(e) }), "error");
    }
  }, [
    plan,
    starting,
    canStart,
    projectPath,
    doneItems,
    settings.projectId,
    agent,
    permission,
    onStartDiscussion,
    showToast,
    t,
  ]);

  const permissionLabel =
    permission === "full_access"
      ? t("yunxiao.discussion.permYolo")
      : permission === "auto_edit"
        ? t("yunxiao.discussion.permAuto")
        : t("yunxiao.discussion.permAsk");

  const displayName = plan
    ? buildPlanDisplayName(issues.map((issue) => issue.serialNumber))
    : "";

  return (
    <div style={s.bbDialogOverlay}>
      <div style={s.planLaunchDialog}>
        <div style={s.planLaunchHead}>
          <div>
            <div style={s.bbDialogTitle}>{t("plan.launch.title")}</div>
            <div style={s.planLaunchMeta}>
              {displayName} · {t("yunxiao.importToProject")}：{projectName}
            </div>
          </div>
          <button type="button" style={s.yunxiaoIconBtn} onClick={handleClose} title={t("plan.launch.close")}>
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div style={s.planLaunchList}>
          {items
            .filter((item) => item.status !== "removed")
            .map((item) => (
              <div key={item.issue.id} style={s.planLaunchItem}>
                <span style={s.planLaunchStatus}>
                  {item.status === "loading" || item.status === "pending" ? (
                    <Loader2 size={13} className="spin" />
                  ) : item.status === "done" ? (
                    <CheckCircle2 size={13} color="var(--success, #34c759)" />
                  ) : (
                    <AlertTriangle size={13} color="var(--danger)" />
                  )}
                </span>
                <div style={s.planLaunchItemBody}>
                  <div style={s.planLaunchItemTitle}>
                    <span style={s.yunxiaoIssueSerial}>{item.issue.serialNumber}</span>
                    {item.issue.subject}
                  </div>
                  {(item.status === "done" && (item.imagePaths.length > 0 || item.imageWarning)) ||
                  item.status === "failed" ? (
                    <div style={s.planLaunchItemNote}>
                      {item.status === "done" ? (
                        <>
                          {item.imagePaths.length > 0 &&
                            t("plan.launch.itemImages", { count: item.imagePaths.length })}
                          {item.imageWarning ? ` · ${item.imageWarning}` : ""}
                        </>
                      ) : (
                        item.error
                      )}
                    </div>
                  ) : null}
                </div>
                {item.status === "failed" && (
                  <div style={s.planLaunchItemActions}>
                    <button type="button" style={s.knowledgeSecondaryBtn} onClick={() => handleRetry(item.issue.id)}>
                      {t("yunxiao.retry")}
                    </button>
                    <button type="button" style={s.knowledgeSecondaryBtn} onClick={() => handleRemove(item.issue.id)}>
                      {t("plan.launch.remove")}
                    </button>
                  </div>
                )}
              </div>
            ))}
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
          {working && (
            <span style={s.planLaunchProgress}>{t("plan.launch.fetching")}</span>
          )}
        </div>

        <div style={s.bbDialogActions}>
          <button type="button" style={s.bbBtnGhost} onClick={handleClose} disabled={starting}>
            {t("plan.launch.cancel")}
          </button>
          <button
            type="button"
            style={canStart ? s.bbBtnPrimary : s.bbBtnPrimaryDisabled}
            disabled={!canStart}
            onClick={() => void handleStart()}
          >
            {starting ? <Loader2 size={13} className="spin" /> : <Play size={13} strokeWidth={2.2} fill="currentColor" />}
            {starting ? t("plan.launch.starting") : t("plan.launch.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
