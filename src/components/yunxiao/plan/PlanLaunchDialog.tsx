import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Play, X } from "lucide-react";
import type {
  AgentType,
  PermissionMode,
  Plan,
  PlanIssue,
  Task,
  YunxiaoIssueImagesPrepared,
  YunxiaoWorkitem,
} from "../../../types";
import { isAgentEnabled, firstEnabledAgent, cycleEnabledAgent, type AgentEnabledState } from "../../../types";
import {
  buildAppendUpstreamContext,
  buildPlanDiscussionPrompt,
  buildPlanDisplayName,
} from "../../../utils/plan";
import {
  PlanLaunchItemList,
  type PlanLaunchItem,
  type PlanLaunchItemStatus,
} from "./PlanLaunchItemList";
import { PlanLaunchParentField } from "./PlanLaunchParentField";
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

const FETCH_CONCURRENCY = 2;

function agentLabel(agent: AgentType): string {
  return agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "DSH";
}

/**
 * 发起联合分析对话框：创建 draft 方案 → 并发拉取详情 + 图片（挂方案目录）→
 * 确认（agent/权限、失败项重试/剔除）→ 组装讨论 prompt 并启动方案讨论任务。
 * 任何非「发起」路径关闭都视为取消：删除 draft 方案记录与已下载图片。
 *
 * **追加议题**也走这个对话框（不另设入口）：多选一批未占用的议题，在「关联方案」里
 * 挑一个本项目已定稿的方案，这批议题就挂成它的**子方案**（决策 A2：一次追加的一批合成
 * 一个子方案）。选择关联方案后，讨论 prompt 会注入上游方案的议题清单与方案文档路径，
 * 由讨论 agent 按内容判定跨方案依赖（决策 B2'）。
 */
export function PlanLaunchDialog({
  issues,
  plans,
  tasks,
  targetProjectId,
  projectPath,
  projectName,
  settings,
  onCreatePlan,
  onSetParentPlan,
  onStartDiscussion,
  onCancelPlan,
  onClose,
}: {
  issues: YunxiaoWorkitem[];
  /** 全量方案：用于算「关联方案」候选与祖先链。 */
  plans: Plan[];
  /** 全量任务：用于给上游方案议题标注当前状态（未生成待办 / 进行中 / 已完成…）。 */
  tasks: Task[];
  targetProjectId: string;
  projectPath: string;
  projectName: string;
  settings: YunxiaoSettings;
  onCreatePlan: (targetProjectId: string, issues: PlanIssue[]) => Plan;
  /** 关联方案变更（含取消关联传 undefined）：写入本方案的 parentPlanId。 */
  onSetParentPlan: (planId: string, parentPlanId: string | undefined) => void;
  onStartDiscussion: (planId: string, prompt: string, agent: AgentType, permissionMode: PermissionMode) => void;
  onCancelPlan: (planId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [items, setItems] = useState<PlanLaunchItem[]>(() =>
    issues.map((issue) => ({ issue, status: "pending" as PlanLaunchItemStatus, imagePaths: [] })),
  );
  const itemsRef = useRef(items);
  const [retryNonce, setRetryNonce] = useState(0);
  const [agentSettings, setAgentSettings] = useState<AgentEnabledState | null>(null);
  // 应用级「批量盘问（测试技能）」开关：开启时讨论环节改走 batch-grill-me，仅影响文案提示。
  const [batchGrill, setBatchGrill] = useState(false);
  const [agent, setAgent] = useState<AgentType>(
    () => getLastYunxiaoAgent(targetProjectId) ?? "codex",
  );
  const [permission, setPermission] = useState<PermissionMode>(
    () => getLastYunxiaoPermission(targetProjectId) ?? "ask",
  );
  const [starting, setStarting] = useState(false);
  const startedRef = useRef(false);
  // 发起人手动补充（背景描述 / 参考资料 / 已有修改方案等），原样拼进讨论 prompt。
  const [notes, setNotes] = useState("");
  /** 关联方案（追加子方案）：空 = 独立方案。候选见 appendableParentPlans。 */
  const [parentPlanId, setParentPlanId] = useState("");

  const updateItem = useCallback((issueId: string, patch: Partial<PlanLaunchItem>) => {
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
    invoke<AgentEnabledState & { batch_grill_enabled?: boolean }>("load_app_settings")
      .then((appSettings) => {
        setAgentSettings(appSettings);
        setBatchGrill(appSettings.batch_grill_enabled ?? false);
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
          ? { ...item, status: "pending" as PlanLaunchItemStatus, error: undefined }
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
      // 方案含 Bug 议题时注入 diagnosing-bugs 根因诊断方法论（类别来自议题详情快照）。
      const hasBug = doneItems.some((item) =>
        (item.detail!.categoryId ?? "").trim().toLowerCase() === "bug",
      );
      const instructions = await invoke<string>("get_plan_discussion_instructions", {
        projectPath,
        planId: plan.id,
        hasBug,
      });
      // 追加子方案：注入上游方案议题清单 + plan.md 路径，供讨论 agent 判定跨方案依赖。
      const upstreamContext = buildAppendUpstreamContext({
        parentPlanId,
        plans,
        projectPath,
        tasks,
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
        userNotes: notes,
        upstreamContext,
        instructions,
      });
      // 先写归属再启动：讨论任务一跑起来看板就该显示它挂在哪个主方案下。
      if (parentPlanId !== (plan.parentPlanId ?? "")) {
        onSetParentPlan(plan.id, parentPlanId || undefined);
      }
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
    notes,
    agent,
    permission,
    parentPlanId,
    plans,
    tasks,
    onSetParentPlan,
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

        <PlanLaunchItemList items={items} onRetry={handleRetry} onRemove={handleRemove} />

        <PlanLaunchParentField
          plans={plans}
          targetProjectId={targetProjectId}
          currentPlanId={plan?.id}
          value={parentPlanId}
          onChange={setParentPlanId}
        />

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

        {batchGrill && (
          <div style={s.planLaunchParentHint}>{t("plan.launch.batchGrillHint")}</div>
        )}

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
