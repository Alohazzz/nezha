import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, Plus, Send, Trash2 } from "lucide-react";
import { appConfirm } from "../AppConfirmDialog";
import type {
  AgentType,
  DeliveryPlan,
  DeliveryPlanStatus,
  PermissionMode,
  Plan,
  PlanIssue,
  Project,
  Task,
  YunxiaoWorkitem,
} from "../../types";
import { EMPTY_YUNXIAO_SETTINGS, type YunxiaoSettings } from "../app-settings/types";
import { collectOccupiedYunxiaoWorkitemIds, planIssueToWorkitem } from "../../utils/yunxiao";
import { useToast } from "../Toast";
import s from "../../styles";
import { dpChipToneStyle } from "../../styles/delivery-plan";
import { CreatePlanDialog } from "../branch-batch/CreatePlanDialog";
import { SubmitMrDialog } from "../branch-batch/SubmitMrDialog";
import { DirectLaunchDialog, type DirectLaunchOptions } from "../yunxiao/DirectLaunchDialog";
import { PlanLaunchDialog } from "../yunxiao/plan/PlanLaunchDialog";
import { SelectField } from "../yunxiao/SelectField";
import { deriveIssueStatus, type IssueStatus } from "./deriveIssueStatus";
import {
  ISSUE_STATUS_LABEL,
  ISSUE_STATUS_TONE,
  PLAN_STATUS_LABEL,
  PLAN_STATUS_TONE,
} from "./labels";
import { PlanIssueList } from "./PlanIssueList";

const OVERDUE_MS = 14 * 24 * 60 * 60 * 1000;
/** 合并讨论的软上限：与云效议题列表同口径（讨论上下文与图片量的现实约束）。 */
const MERGE_SELECT_SOFT_LIMIT = 10;

/** 欢迎页「计划」视图（mockup ①）：侧栏（项目过滤＋计划列表＋创建）＋详情
 *  （议题表全自动派生状态）。
 *
 *  议题表对齐云效议题列表：行内可勾选做「合并讨论」（N 条合成一份方案），也有
 *  「单条讨论」快捷入口（N=1，同一链路），以及跳云效原议题的链接。 */
export function PlanPanel({
  projects,
  tasks,
  plans,
  deliveryPlans,
  onDeliveryPlansChange,
  onGoYunxiao,
  onStartDirectExecution,
  onCreatePlan,
  onStartPlanDiscussion,
  onCancelPlan,
  onSetParentPlan,
  onOpenWorkitem,
}: {
  projects: Project[];
  tasks: Task[];
  /** 多议题联合方案（方案不动，仅被关联展示）。 */
  plans: Plan[];
  deliveryPlans: DeliveryPlan[];
  onDeliveryPlansChange: (plans: DeliveryPlan[]) => void;
  /** 「添加议题」去云效议题视图（同一套多选与发起链路）。 */
  onGoYunxiao: () => void;
  onStartDirectExecution: (
    issue: YunxiaoWorkitem,
    projectId: string,
    options: DirectLaunchOptions,
  ) => void | Promise<void>;
  /** 发起讨论第一步：落一份 draft 方案（与云效议题视图共用同一链路）。 */
  onCreatePlan: (targetProjectId: string, issues: PlanIssue[]) => Plan;
  onStartPlanDiscussion: (
    planId: string,
    prompt: string,
    agent: AgentType,
    permissionMode: PermissionMode,
  ) => void;
  onCancelPlan: (planId: string) => void | Promise<void>;
  /** 关联方案变更（追加子方案）：写入 draft 方案的 parentPlanId。 */
  onSetParentPlan: (planId: string, parentPlanId: string | undefined) => void;
  /** 打开关联方案（方案看板入口）。 */
  onOpenWorkitem?: (workitemId: string) => void;
}) {
  const { showToast } = useToast();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [statusFilter, setStatusFilter] = useState<DeliveryPlanStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string>("");
  const [showCreate, setShowCreate] = useState(false);
  const [submitPlan, setSubmitPlan] = useState<DeliveryPlan | null>(null);
  const [directIssue, setDirectIssue] = useState<YunxiaoWorkitem | null>(null);
  const [yunxiaoSettings, setYunxiaoSettings] = useState<YunxiaoSettings>(EMPTY_YUNXIAO_SETTINGS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  /** 合并讨论的勾选集合：存议题本体，顺序 = 勾选顺序（与云效议题列表一致）。 */
  const [selectedIssuesById, setSelectedIssuesById] = useState<
    ReadonlyMap<string, PlanIssue>
  >(new Map());
  /** 发起讨论对话框的议题（null = 未打开；单条与合并共用）。 */
  const [launchIssues, setLaunchIssues] = useState<YunxiaoWorkitem[] | null>(null);

  // 链接与发起讨论都要 token/组织；进视图即预热一次（拿云项目 id 拼链接），
  // 点击动作时若还没拿到再兜底读一次盘（沿用原有按需加载语义）。
  useEffect(() => {
    let cancelled = false;
    invoke<{ yunxiao?: YunxiaoSettings }>("load_app_settings")
      .then((appSettings) => {
        if (!cancelled) setYunxiaoSettings(appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const ensureYunxiaoSettings = useCallback(async (): Promise<YunxiaoSettings> => {
    if (yunxiaoSettings.token && yunxiaoSettings.organizationId) return yunxiaoSettings;
    const appSettings = await invoke<{ yunxiao?: YunxiaoSettings }>("load_app_settings");
    const next = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
    setYunxiaoSettings(next);
    return next;
  }, [yunxiaoSettings]);

  const scopedPlans = useMemo(
    () =>
      deliveryPlans.filter(
        (p) => p.projectId === projectId && (statusFilter === "all" || p.status === statusFilter),
      ),
    [deliveryPlans, projectId, statusFilter],
  );
  const selected = useMemo(
    () => scopedPlans.find((p) => p.id === selectedId) ?? scopedPlans[0],
    [scopedPlans, selectedId],
  );
  const project = projects.find((p) => p.id === projectId);

  // 切换计划时清空勾选：勾选只在本计划议题范围内有意义。
  const selectedPlanId = selected?.id ?? "";
  useEffect(() => {
    setSelectedIssuesById(new Map());
  }, [selectedPlanId]);

  const issueRows = useMemo(() => {
    if (!selected) return [];
    return selected.issues.map((issue) => ({
      issue,
      status: deriveIssueStatus(issue.workitemId, tasks, plans),
      schemes: plans.filter((p) => p.issues.some((i) => i.workitemId === issue.workitemId)),
    }));
  }, [selected, tasks, plans]);

  // 已被任务/存活方案占用的议题：不能再发起讨论（与云效议题列表的已导入守卫同源）。
  const occupiedIds = useMemo(
    () => collectOccupiedYunxiaoWorkitemIds(tasks, plans),
    [tasks, plans],
  );

  const summary = useMemo(() => {
    const counts: Record<IssueStatus, number> = {
      not_started: 0,
      discussing: 0,
      discussed: 0,
      executing: 0,
      done: 0,
      aborted: 0,
    };
    for (const row of issueRows) counts[row.status] += 1;
    return counts;
  }, [issueRows]);

  const selectedIds = useMemo(
    () => new Set(selectedIssuesById.keys()),
    [selectedIssuesById],
  );

  const handleToggleSelect = useCallback(
    (issue: PlanIssue) => {
      if (occupiedIds.has(issue.workitemId)) {
        showToast("该议题已被占用（已有任务或方案），请先到云效议题视图查看", "warning");
        return;
      }
      setSelectedIssuesById((prev) => {
        const next = new Map(prev);
        if (next.has(issue.workitemId)) {
          next.delete(issue.workitemId);
          return next;
        }
        if (next.size >= MERGE_SELECT_SOFT_LIMIT) {
          showToast(`单次合并讨论最多选 ${MERGE_SELECT_SOFT_LIMIT} 个议题`, "warning");
          return prev;
        }
        next.set(issue.workitemId, issue);
        return next;
      });
    },
    [occupiedIds, showToast],
  );

  const clearSelection = useCallback(() => setSelectedIssuesById(new Map()), []);

  /** 打开发起讨论对话框：不建任务、不下图，先确认再启动（与云效议题列表同链路）。 */
  const openDiscussion = useCallback(
    async (issues: PlanIssue[]) => {
      if (issues.length === 0) return;
      try {
        const settings = await ensureYunxiaoSettings();
        if (!settings.token || !settings.organizationId) {
          setNotice("未连接云效，请先在设置中配置令牌");
          return;
        }
      } catch (e) {
        setNotice(String(e));
        return;
      }
      setLaunchIssues(issues.map(planIssueToWorkitem));
    },
    [ensureYunxiaoSettings],
  );

  async function handleOpen() {
    if (!selected || !project) return;
    try {
      await invoke("open_delivery_plan_worktree", {
        projectPath: project.path,
        projectId: project.id,
        batchId: selected.id,
      });
    } catch (e) {
      setNotice(String(e));
    }
  }

  async function handleDelete() {
    if (!selected || !project) return;
    const ok = await appConfirm(`确认删除计划「${selected.name}」？`, {
      title: "删除计划",
      kind: "warning",
    });
    if (!ok) return;
    setBusyId(selected.id);
    setNotice("");
    try {
      await invoke("delete_delivery_plan", {
        projectPath: project.path,
        projectId: project.id,
        batchId: selected.id,
        shellOpen: false,
      });
      const list = await invoke<DeliveryPlan[]>("list_delivery_plans", {
        projectId: project.id,
        projectPath: project.path,
      });
      onDeliveryPlansChange([
        ...deliveryPlans.filter((p) => p.projectId !== project.id),
        ...list,
      ]);
      setSelectedId("");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemoveIssue(workitemId: string) {
    if (!selected || !project) return;
    try {
      const plan = await invoke<DeliveryPlan>("remove_delivery_plan_issue", {
        projectId: project.id,
        planId: selected.id,
        workitemId,
      });
      onDeliveryPlansChange(deliveryPlans.map((p) => (p.id === plan.id ? plan : p)));
      setSelectedIssuesById((prev) => {
        if (!prev.has(workitemId)) return prev;
        const next = new Map(prev);
        next.delete(workitemId);
        return next;
      });
    } catch (e) {
      setNotice(String(e));
    }
  }

  async function handleStartIssue(rowIssue: PlanIssue) {
    if (!project) return;
    try {
      const settings = await ensureYunxiaoSettings();
      if (!settings.token || !settings.organizationId) {
        setNotice("未连接云效，请先在设置中配置令牌");
        return;
      }
      const issue = await invoke<YunxiaoWorkitem>("yunxiao_get_workitem", {
        token: settings.token,
        organizationId: settings.organizationId,
        workitemId: rowIssue.workitemId,
      });
      setDirectIssue(issue);
    } catch (e) {
      setNotice(String(e));
    }
  }

  return (
    <div style={s.dpRoot}>
      {notice && <div style={s.dpNotice}>{notice}</div>}

      <div style={s.dpBody}>
        <div style={s.dpSide}>
          {/* 创建计划置顶（反馈 #2）。 */}
          <div style={s.dpSideFilter}>
            <button
              type="button"
              style={s.dpBtnPrimaryBlock}
              onClick={() => setShowCreate(true)}
              disabled={!project}
            >
              <Plus size={13} />
              创建计划
            </button>
          </div>
          <div style={s.dpSideFilter}>
            <SelectField
              value={projectId}
              onChange={(v) => {
                setProjectId(v);
                setSelectedId("");
              }}
              options={projects.map((p) => ({ value: p.id, label: `项目：${p.name}` }))}
              placeholder="选择项目"
            />
          </div>
          {/* 状态过滤（反馈 #1）。 */}
          <div style={s.dpSideFilter}>
            <SelectField
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v as DeliveryPlanStatus | "all");
                setSelectedId("");
              }}
              options={[
                { value: "all", label: "状态：全部" },
                { value: "active", label: "状态：进行中" },
                { value: "review", label: "状态：待评审" },
                { value: "merged", label: "状态：已合并" },
                { value: "closed", label: "状态：已关闭" },
              ]}
              placeholder="状态：全部"
            />
          </div>
          {scopedPlans.length === 0 && <div style={s.dpEmpty}>无匹配计划</div>}
          {scopedPlans.map((p) => (
            <button
              key={p.id}
              type="button"
              style={p.id === selected?.id ? s.dpListItemActive : s.dpListItem}
              onClick={() => setSelectedId(p.id)}
            >
              {/* 状态标识（反馈 #1）：色调同详情头。 */}
              <span style={s.dpListItemTop}>
                <span style={s.dpListItemName}>{p.name}</span>
                <span style={dpChipToneStyle[PLAN_STATUS_TONE[p.status]]}>
                  {PLAN_STATUS_LABEL[p.status]}
                </span>
              </span>
              <span style={s.dpListItemBranch}>{p.branch}</span>
            </button>
          ))}
        </div>

        <div style={s.dpMain}>
          {!selected ? (
            <div style={s.dpEmpty}>从左侧选择一个计划查看议题进展。</div>
          ) : (
            <>
              <div style={s.dpHead}>
                <span style={s.dpTitle}>{selected.name}</span>
                <span style={dpChipToneStyle[PLAN_STATUS_TONE[selected.status]]}>
                  {PLAN_STATUS_LABEL[selected.status]}
                </span>
                <span style={s.dpChip}>{selected.kind}</span>
                {!selected.useWorktree && <span style={s.dpChip}>主检出</span>}
                {selected.worktreeMissing && <span style={s.dpChipWarn}>WorkTree 缺失</span>}
                {selected.runRootMissing && <span style={s.dpChipWarn}>运行程序缺失</span>}
                {selected.status !== "merged" &&
                  selected.status !== "closed" &&
                  Date.now() - selected.createdAt > OVERDUE_MS && (
                    <span style={s.dpChipWarn}>超期</span>
                  )}
                <span style={s.dpSpacer} />
                <button type="button" style={s.dpBtn} onClick={() => onGoYunxiao()}>
                  <Plus size={13} />
                  添加议题
                </button>
                <button
                  type="button"
                  style={s.dpBtn}
                  disabled={
                    selected.status !== "active" ||
                    !selected.targetBranch ||
                    selected.worktreeMissing
                  }
                  onClick={() => setSubmitPlan(selected)}
                >
                  <Send size={13} />
                  提交 MR
                </button>
                <button
                  type="button"
                  style={s.dpBtn}
                  disabled={selected.worktreeMissing}
                  onClick={() => void handleOpen()}
                >
                  <FolderOpen size={13} />
                  打开
                </button>
                <button
                  type="button"
                  style={s.dpBtn}
                  disabled={busyId === selected.id}
                  onClick={() => void handleDelete()}
                >
                  <Trash2 size={13} />
                  删除计划
                </button>
              </div>

              <div style={s.dpBranchRow}>
                {selected.branch} ← {selected.baseBranch} →{" "}
                {selected.targetBranch || "（未指定合并目标）"}
              </div>

              <div style={s.dpSummary}>
                {(Object.keys(summary) as IssueStatus[])
                  .filter((k) => summary[k] > 0)
                  .map((k) => (
                    <span key={k} style={dpChipToneStyle[ISSUE_STATUS_TONE[k]]}>
                      {summary[k]} {ISSUE_STATUS_LABEL[k]}
                    </span>
                  ))}
              </div>

              {issueRows.length === 0 ? (
                <div style={s.dpEmpty}>
                  暂无议题
                  <br />
                  从云效议题列表「添加到计划」开始组织议题
                  <br />
                  <button
                    type="button"
                    style={s.dpBtnPrimary}
                    onClick={() => onGoYunxiao()}
                  >
                    去添加议题
                  </button>
                </div>
              ) : (
                <>
                  <PlanIssueList
                    rows={issueRows}
                    occupiedIds={occupiedIds}
                    selectedIds={selectedIds}
                    selectionMode={selectedIssuesById.size > 0}
                    yunxiaoProjectId={yunxiaoSettings.projectId}
                    onToggleSelect={handleToggleSelect}
                    onDiscuss={(issue) => void openDiscussion([issue])}
                    onMergeDiscuss={() => {
                      const issues = [...selectedIssuesById.values()];
                      clearSelection();
                      void openDiscussion(issues);
                    }}
                    onClearSelection={clearSelection}
                    onStart={(issue) => void handleStartIssue(issue)}
                    onRemove={(workitemId) => void handleRemoveIssue(workitemId)}
                    onOpenWorkitem={onOpenWorkitem}
                  />
                  <p style={s.dpHint}>
                    状态与方案关联全自动派生；从计划内议题创建的任务自动绑定本计划分支 / worktree。
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {showCreate && project && (
        <CreatePlanDialog
          projectId={project.id}
          projectPath={project.path}
          repoPath={project.path}
          onCreated={(plan) => onDeliveryPlansChange([...deliveryPlans, plan])}
          onClose={() => setShowCreate(false)}
        />
      )}
      {submitPlan && project && (
        <SubmitMrDialog
          batch={submitPlan}
          projectId={project.id}
          projectPath={project.path}
          onClose={() => setSubmitPlan(null)}
          onDone={() => setSubmitPlan(null)}
        />
      )}
      {launchIssues && project && (
        <PlanLaunchDialog
          key={launchIssues.map((issue) => issue.id).join(",")}
          issues={launchIssues}
          plans={plans}
          tasks={tasks}
          targetProjectId={project.id}
          projectPath={project.path}
          projectName={project.name}
          settings={yunxiaoSettings}
          onCreatePlan={onCreatePlan}
          onSetParentPlan={onSetParentPlan}
          onStartDiscussion={onStartPlanDiscussion}
          onCancelPlan={onCancelPlan}
          onClose={() => setLaunchIssues(null)}
        />
      )}
      {directIssue && project && (
        <DirectLaunchDialog
          key={directIssue.id}
          issue={directIssue}
          targetProjectId={project.id}
          projectName={project.name}
          settings={yunxiaoSettings}
          onStart={(options) => {
            void onStartDirectExecution(directIssue, project.id, options);
            setDirectIssue(null);
          }}
          onClose={() => setDirectIssue(null)}
        />
      )}
    </div>
  );
}
