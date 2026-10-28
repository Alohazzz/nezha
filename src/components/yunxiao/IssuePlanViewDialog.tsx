import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CircleStop,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { Plan, Task } from "../../types";
import { buildPlanDisplayName, planDirPath, planMdPath } from "../../utils/plan";
import { MessageMarkdownBody } from "../mermaid/MessageMarkdownBody";
import { topoSortPlanIssues } from "../../utils/planDeps";
import type { PlanDeps } from "../../utils/planDeps";
import { parsePlanDeps } from "../../utils/planDeps";
import { HtmlPreviewPane } from "../file-viewer/HtmlPreviewPane";
import { useI18n } from "../../i18n";
import s from "../../styles";

const PLAN_STATUS_LABEL_KEY: Record<Plan["status"], string> = {
  draft: "plan.status.draft",
  finalized: "plan.status.finalized",
  executing: "plan.status.executing",
  completed: "plan.status.completed",
  cancelled: "plan.status.cancelled",
};

/**
 * 议题列表「查看方案」弹窗：plan.md（优先 preview.html）+ 议题清单与执行顺序
 * + 弹窗内直接可用的操作（执行方案 / 继续讨论 / 删除重议 / 取消方案）。
 *
 * 与 PlanPreviewPanel 的区别：它服务方案看板（生成待办确认页、无人值守等完整
 * 启动选项），这里服务议题列表的快捷路径——「开始」按当前界面默认值直接执行，
 * 不展开确认页；需要精细控制时给「取消」逃生，回列表重走完整链路。
 */
export function IssuePlanViewDialog({
  plan,
  discussionTask,
  projectPath,
  starting,
  onStart,
  onResumeDiscussion,
  onRediscuss,
  onCancelPlan,
  onClose,
}: {
  plan: Plan;
  /** 讨论任务（draft 态可能有；已定稿后为 null）。 */
  discussionTask: Task | null;
  projectPath: string;
  /** 「执行方案」进行中（生成待办 + 启动）。 */
  starting: boolean;
  onStart: () => void;
  onResumeDiscussion: () => void;
  onRediscuss: () => void;
  onCancelPlan: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [markdown, setMarkdown] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [deps, setDeps] = useState<PlanDeps | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [confirmingRediscuss, setConfirmingRediscuss] = useState(false);

  // 操作按钮可用性：draft 锁执行（plan.md 仍被会话覆盖）；finalized 开执行；
  // executing 变「继续执行」（仍进此弹窗，用户可能想看进度缺口）；讨论未定稿可续聊。
  const isDraft = plan.status === "draft";
  const discussionBroken =
    isDraft &&
    (!discussionTask ||
      discussionTask.status === "failed" ||
      discussionTask.status === "cancelled" ||
      discussionTask.status === "interrupted");
  const canStart = (plan.status === "finalized" || plan.status === "executing") && !starting;
  const canCancel =
    !isDraft || (!!discussionTask && discussionTask.status === "input_required");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const mdPath = planMdPath(projectPath, plan.id);
      const htmlPath = `${planDirPath(projectPath, plan.id)}/preview.html`;
      const content = await invoke<string>("read_file_content", { path: mdPath, projectPath });
      setMarkdown(content);
      try {
        const [html, mtimes] = await Promise.all([
          invoke<string>("read_file_content", { path: htmlPath, projectPath }),
          invoke<Record<string, number>>("read_file_mtimes", {
            paths: [mdPath, htmlPath],
            projectPath,
          }),
        ]);
        const htmlMs = mtimes[htmlPath];
        const mdMs = mtimes[mdPath];
        setPreviewHtml(
          html.trim().length > 0 &&
            typeof htmlMs === "number" &&
            typeof mdMs === "number" &&
            htmlMs >= mdMs
            ? html
            : null,
        );
      } catch {
        setPreviewHtml(null);
      }
    } catch (e) {
      setMarkdown("");
      setPreviewHtml(null);
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath, plan.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 执行顺序：deps.json 拓扑序；缺失/损坏回落方案快照给定顺序（与看板同口径）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await invoke<string>(
          "read_file_content",
          { path: `${planDirPath(projectPath, plan.id)}/deps.json`, projectPath },
        );
        const parsed = parsePlanDeps(
          raw,
          plan.issues.map((issue) => issue.serialNumber),
          [],
        );
        if (!cancelled) setDeps(parsed);
      } catch {
        if (!cancelled) setDeps(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, plan.id, plan.issues]);

  const orderedIssues = useMemo(() => {
    if (!deps) return plan.issues;
    const order = topoSortPlanIssues(
      plan.issues.map((issue) => issue.serialNumber),
      deps.graph,
      deps.executionOrder,
    );
    const bySerial = new Map(plan.issues.map((issue) => [issue.serialNumber, issue]));
    return order
      .map((serial) => bySerial.get(serial))
      .filter((issue): issue is NonNullable<typeof issue> => !!issue);
  }, [deps, plan.issues]);

  return (
    <div style={s.bbDialogOverlay}>
      <div style={s.planPreviewDialog}>
        <div style={s.planLaunchHead}>
          <div>
            <div style={s.bbDialogTitle}>{t("plan.preview.title")}</div>
            <div style={s.planPanelMeta}>
              <span style={s.planPanelName}>
                {plan.name || buildPlanDisplayName(plan.issues.map((issue) => issue.serialNumber))}
              </span>
              <span style={s.planPanelBadge}>{t(PLAN_STATUS_LABEL_KEY[plan.status])}</span>
            </div>
            <div style={s.planPanelIssues}>
              {orderedIssues.map((issue) => (
                <span key={issue.workitemId} style={s.yunxiaoMetaBadge}>
                  {issue.serialNumber} {issue.subject}
                </span>
              ))}
            </div>
          </div>
          <div style={s.planPreviewHeadSide}>
            {isDraft && discussionBroken && (
              <button
                type="button"
                style={s.knowledgePrimaryBtn}
                onClick={onResumeDiscussion}
              >
                <RefreshCw size={12} strokeWidth={2.2} />
                {t("yunxiao.planView.resumeDiscussion")}
              </button>
            )}
            {canStart && (
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={starting}
                title={t("plan.start.hint")}
                onClick={onStart}
              >
                {starting ? <Loader2 size={12} className="spin" /> : <Play size={12} strokeWidth={2.4} />}
                {starting
                  ? t("plan.start.creating")
                  : plan.status === "executing"
                    ? t("yunxiao.planView.continue")
                    : t("yunxiao.issueActions.startPlan")}
              </button>
            )}
            {plan.status !== "completed" && (
              <button
                type="button"
                style={s.knowledgeSecondaryBtn}
                onClick={onRediscuss}
              >
                <Trash2 size={12} strokeWidth={2.2} />
                {t("yunxiao.issueActions.rediscuss")}
              </button>
            )}
            {canCancel && !confirmingCancel && (
              <button
                type="button"
                style={s.knowledgeSecondaryBtn}
                onClick={() => setConfirmingCancel(true)}
              >
                <CircleStop size={12} strokeWidth={2.2} />
                {t("yunxiao.issueActions.cancelPlan")}
              </button>
            )}
            <button
              type="button"
              style={s.yunxiaoIconBtn}
              onClick={onClose}
              title={t("plan.launch.close")}
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
        </div>

        {(confirmingCancel || confirmingRediscuss) && (
          <div style={s.yunxiaoIssuePlanConfirmBar}>
            <span>
              {confirmingCancel
                ? t("yunxiao.planView.cancelPrompt")
                : t("yunxiao.planView.rediscussPrompt")}
            </span>
            <button
              type="button"
              className="row-actions-btn"
              data-tone="danger"
              onClick={confirmingCancel ? onCancelPlan : onRediscuss}
            >
              {t("yunxiao.planView.confirmYes")}
            </button>
            <button
              type="button"
              className="row-actions-btn"
              data-tone="secondary"
              onClick={() => {
                setConfirmingCancel(false);
                setConfirmingRediscuss(false);
              }}
            >
              {t("yunxiao.planView.confirmNo")}
            </button>
          </div>
        )}

        <div style={s.planPreviewBody}>
          {loading ? (
            <div style={s.yunxiaoEmpty}>
              <Loader2 size={18} className="spin" />
            </div>
          ) : loadError && !markdown ? (
            <div style={s.planPanelEmpty}>
              {isDraft
                ? t("plan.preview.discussionRunning")
                : t("plan.preview.mdMissing")}
            </div>
          ) : previewHtml ? (
            <div style={s.planPreviewHtmlWrap}>
              <HtmlPreviewPane
                html={previewHtml}
                fileName="preview.html"
                filePath={`${planDirPath(projectPath, plan.id)}/preview.html`}
                projectPath={projectPath}
              />
            </div>
          ) : (
            <MessageMarkdownBody text={markdown} className="plan-md" />
          )}
        </div>
      </div>
    </div>
  );
}
