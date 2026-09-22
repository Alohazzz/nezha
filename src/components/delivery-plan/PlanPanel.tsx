import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, Plus, Send, Trash2 } from "lucide-react";
import { appConfirm } from "../AppConfirmDialog";
import type {
  DeliveryPlan,
  Plan,
  Project,
  Task,
  YunxiaoWorkitem,
} from "../../types";
import { EMPTY_YUNXIAO_SETTINGS, type YunxiaoSettings } from "../app-settings/types";
import s from "../../styles";
import { dpChipToneStyle } from "../../styles/delivery-plan";
import { CreatePlanDialog } from "../branch-batch/CreatePlanDialog";
import { SubmitMrDialog } from "../branch-batch/SubmitMrDialog";
import { DirectLaunchDialog, type DirectLaunchOptions } from "../yunxiao/DirectLaunchDialog";
import { SelectField } from "../yunxiao/SelectField";
import { deriveIssueStatus, type IssueStatus } from "./deriveIssueStatus";
import {
  ISSUE_STATUS_LABEL,
  ISSUE_STATUS_TONE,
  PLAN_STATUS_LABEL,
  PLAN_STATUS_TONE,
} from "./labels";
import { PlanIssueRow } from "./PlanIssueRow";

const OVERDUE_MS = 14 * 24 * 60 * 60 * 1000;

/** 欢迎页「计划」视图（mockup ①）：侧栏（项目过滤＋计划列表＋创建）＋详情
 *  （议题表全自动派生状态）。 */
export function PlanPanel({
  projects,
  tasks,
  plans,
  deliveryPlans,
  onDeliveryPlansChange,
  onGoYunxiao,
  onStartDirectExecution,
  onOpenWorkitem,
}: {
  projects: Project[];
  tasks: Task[];
  /** 多议题联合方案（方案不动，仅被关联展示）。 */
  plans: Plan[];
  deliveryPlans: DeliveryPlan[];
  onDeliveryPlansChange: (plans: DeliveryPlan[]) => void;
  /** 「添加议题 / 发起讨论」都去云效议题视图（同一套多选与发起链路）。 */
  onGoYunxiao: () => void;
  onStartDirectExecution: (
    issue: YunxiaoWorkitem,
    projectId: string,
    options: DirectLaunchOptions,
  ) => void | Promise<void>;
  /** 打开关联方案（方案看板入口）。 */
  onOpenWorkitem?: (workitemId: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [selectedId, setSelectedId] = useState<string>("");
  const [showCreate, setShowCreate] = useState(false);
  const [submitPlan, setSubmitPlan] = useState<DeliveryPlan | null>(null);
  const [directIssue, setDirectIssue] = useState<YunxiaoWorkitem | null>(null);
  const [yunxiaoSettings, setYunxiaoSettings] = useState<YunxiaoSettings>(EMPTY_YUNXIAO_SETTINGS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const scopedPlans = useMemo(
    () => deliveryPlans.filter((p) => p.projectId === projectId),
    [deliveryPlans, projectId],
  );
  const selected = useMemo(
    () => scopedPlans.find((p) => p.id === selectedId) ?? scopedPlans[0],
    [scopedPlans, selectedId],
  );
  const project = projects.find((p) => p.id === projectId);

  const issueRows = useMemo(() => {
    if (!selected) return [];
    return selected.issues.map((issue) => ({
      issue,
      status: deriveIssueStatus(issue.workitemId, tasks, plans),
      schemes: plans.filter((p) => p.issues.some((i) => i.workitemId === issue.workitemId)),
    }));
  }, [selected, tasks, plans]);

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

  async function handleOpen() {
    if (!selected || !project) return;
    try {
      await invoke("open_delivery_plan_worktree", {
        projectPath: project.path,
        projectId: project.id,
        planId: selected.id,
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
        planId: selected.id,
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
    } catch (e) {
      setNotice(String(e));
    }
  }

  async function handleStartIssue(rowIssue: {
    workitemId: string;
    serialNumber: string;
    subject: string;
  }) {
    if (!project) return;
    try {
      const appSettings = await invoke<{ yunxiao?: YunxiaoSettings }>("load_app_settings");
      const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
      setYunxiaoSettings(yunxiao);
      if (!yunxiao.token || !yunxiao.organizationId) {
        setNotice("未连接云效，请先在设置中配置令牌");
        return;
      }
      const issue = await invoke<YunxiaoWorkitem>("yunxiao_get_workitem", {
        token: yunxiao.token,
        organizationId: yunxiao.organizationId,
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
          {scopedPlans.length === 0 && <div style={s.dpEmpty}>本项目暂无计划</div>}
          {scopedPlans.map((p) => (
            <button
              key={p.id}
              type="button"
              style={p.id === selected?.id ? s.dpListItemActive : s.dpListItem}
              onClick={() => setSelectedId(p.id)}
            >
              {p.name}
              <span style={s.dpListItemBranch}>{p.branch}</span>
            </button>
          ))}
          <div style={s.dpSideFooter}>
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
                  <table style={s.dpTable}>
                    <thead>
                      <tr>
                        <th style={s.dpTh}>议题</th>
                        <th style={s.dpTh}>状态</th>
                        <th style={s.dpTh}>关联方案</th>
                        <th style={s.dpTh} />
                      </tr>
                    </thead>
                    <tbody>
                      {issueRows.map((row) => (
                        <PlanIssueRow
                          key={row.issue.workitemId}
                          issue={row.issue}
                          status={row.status}
                          schemes={row.schemes}
                          onStart={() => void handleStartIssue(row.issue)}
                          onRemove={() => void handleRemoveIssue(row.issue.workitemId)}
                          onOpenWorkitem={onOpenWorkitem}
                        />
                      ))}
                    </tbody>
                  </table>
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
