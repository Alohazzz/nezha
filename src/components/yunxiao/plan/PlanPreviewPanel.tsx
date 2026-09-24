import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { FileText, Loader2, Play, Trash2, X } from "lucide-react";
import type {
  AgentEnabledState,
  AgentType,
  PermissionMode,
  Plan,
  PlanIssue,
  Task,
} from "../../../types";
import { firstEnabledAgent, isAgentEnabled } from "../../../types";
import { getLastYunxiaoAgent, getLastYunxiaoPermission } from "../../../utils/yunxiao";
import { buildPlanDisplayName, planDirPath, planMdPath } from "../../../utils/plan";
import { GeneratePlanTodosDialog } from "./GeneratePlanTodosDialog";
import { UnattendedToggle } from "./UnattendedToggle";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

const MAX_PREVIEW_IMAGES = 20;

interface PlanImage {
  key: string;
  serial: string;
  path: string;
  dataUrl: string;
}

const PLAN_STATUS_LABEL_KEY: Record<Plan["status"], string> = {
  draft: "plan.status.draft",
  finalized: "plan.status.finalized",
  executing: "plan.status.executing",
  completed: "plan.status.completed",
  cancelled: "plan.status.cancelled",
};

/** 「方案预览」弹窗：渲染 plan.md + 图片，定稿后提供「生成待办」入口。 */
export function PlanPreviewPanel({
  plan,
  tasks,
  projectPath,
  onCreateTodos,
  onDeletePlan,
  onClose,
}: {
  plan: Plan;
  tasks: Task[];
  projectPath: string;
  onCreateTodos: (input: {
    planId: string;
    issues: PlanIssue[];
    agent: AgentType;
    permissionMode: PermissionMode;
    autoStart?: boolean;
    unattended?: boolean;
  }) => Promise<boolean>;
  onDeletePlan: (planId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [markdown, setMarkdown] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [images, setImages] = useState<PlanImage[]>([]);
  const [showGenerate, setShowGenerate] = useState(false);
  const [starting, setStarting] = useState(false);
  /** 无人值守：整链自动接续（勾选后生成待办不再停在 todo 等人点开始）。 */
  const [unattended, setUnattended] = useState(false);
  const [agentSettings, setAgentSettings] = useState<AgentEnabledState | null>(null);

  const linkedTasks = useMemo(
    () => tasks.filter((task) => task.planId === plan.id),
    [tasks, plan.id],
  );
  // 删除条件只看「是否还有任务引用本方案」：讨论任务自带 planId，存活即在
  // linkedTasks 里；任务被删后 discussionTaskId 悬空，方案成为孤儿——正是
  // 此时最该允许删除（旧判据 !plan.discussionTaskId 会让孤儿方案永远不可删）。
  const canDelete = linkedTasks.length === 0;
  // 「生成待办」在讨论定稿后的任何状态都可用（执行中/已完成的方案可重新生成待办，
  // 例如旧待办被取消删除后想重跑）；仅「讨论中」锁定——plan.md 仍在被会话覆盖更新。
  const canGenerate = plan.status !== "draft" && markdown.trim().length > 0;
  // 「开始」= 生成待办 + 立即执行：同样要求方案已定稿且文档就绪。
  const canStart = canGenerate && !starting;

  useEffect(() => {
    invoke<AgentEnabledState>("load_app_settings")
      .then(setAgentSettings)
      .catch(() => undefined);
  }, []);

  /**
   * 「开始」不弹确认页：沿用方案议题顺序与 `deps.json` 既有依赖，Agent/权限取该项目
   * 上次选择。任务创建后交给串行调度依前置依赖顺序放行（具体分配在 App 侧）。
   * 勾选无人值守时：任务跑完一轮自动收尾，整链无需点击（权限被强制为 YOLO）。
   */
  const handleStart = useCallback(async () => {
    if (!canStart) return;
    setStarting(true);
    const preferred = getLastYunxiaoAgent(plan.projectId) ?? "codex";
    try {
      const ok = await onCreateTodos({
        planId: plan.id,
        issues: plan.issues,
        agent: isAgentEnabled(agentSettings, preferred)
          ? preferred
          : firstEnabledAgent(agentSettings),
        permissionMode: getLastYunxiaoPermission(plan.projectId) ?? "ask",
        autoStart: true,
        unattended,
      });
      // 开始后关闭预览：任务已在跑，用户应看到工作区/终端而不是方案正文。
      if (ok) onClose();
    } finally {
      setStarting(false);
    }
  }, [canStart, plan, agentSettings, onCreateTodos, onClose, unattended]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const content = await invoke<string>("read_file_content", {
        path: planMdPath(projectPath, plan.id),
        projectPath,
      });
      setMarkdown(content);
    } catch (e) {
      setMarkdown("");
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath, plan.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 图片库：方案目录 images/<workitemId>/ 下的文件（read_image_preview → data URL）。
  useEffect(() => {
    let cancelled = false;
    const serialByWorkitem = new Map(plan.issues.map((i) => [i.workitemId, i.serialNumber]));
    (async () => {
      try {
        const root = `${planDirPath(projectPath, plan.id)}/images`;
        const issueDirs = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>(
          "read_dir_entries",
          { path: root, projectPath },
        );
        const collected: PlanImage[] = [];
        for (const dir of issueDirs.filter((entry) => entry.is_dir).slice(0, MAX_PREVIEW_IMAGES)) {
          const files = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>(
            "read_dir_entries",
            { path: dir.path, projectPath },
          );
          for (const file of files.filter((entry) => !entry.is_dir)) {
            if (cancelled || collected.length >= MAX_PREVIEW_IMAGES) break;
            try {
              const preview = await invoke<{ dataUrl: string }>("read_image_preview", {
                path: file.path,
                projectPath,
              });
              collected.push({
                key: file.path,
                serial: serialByWorkitem.get(dir.name) ?? dir.name,
                path: file.path,
                dataUrl: preview.dataUrl,
              });
            } catch {
              // 单张失败跳过
            }
          }
          if (cancelled) return;
        }
        if (!cancelled) setImages(collected);
      } catch {
        if (!cancelled) setImages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, plan.id, plan.issues]);

  const handleDelete = useCallback(async () => {
    await onDeletePlan(plan.id);
  }, [onDeletePlan, plan.id]);

  const html = useMemo(() => {
    if (!markdown.trim()) return "";
    return marked.parse(markdown, { async: false }) as string;
  }, [markdown]);

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
              {plan.batchId && (
                <span style={s.planPanelBadge}>{t("plan.preview.batchLinked")}</span>
              )}
            </div>
            <div style={s.planPanelIssues}>
              {plan.issues.map((issue) => (
                <span key={issue.workitemId} style={s.yunxiaoMetaBadge}>
                  {issue.serialNumber}
                </span>
              ))}
            </div>
          </div>
          <div style={s.planPreviewHeadSide}>
            <UnattendedToggle checked={unattended} disabled={starting} onChange={setUnattended} />
            <button
              type="button"
              style={canStart ? s.bbBtnPrimary : s.bbBtnPrimaryDisabled}
              disabled={!canStart}
              title={t("plan.start.hint")}
              onClick={() => void handleStart()}
            >
              {starting ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <Play size={12} strokeWidth={2.4} />
              )}
              {starting ? t("plan.start.creating") : t("plan.start")}
            </button>
            <button
              type="button"
              style={canGenerate ? s.knowledgePrimaryBtn : s.knowledgePrimaryBtnDisabled}
              disabled={!canGenerate}
              title={plan.status === "finalized" ? undefined : t("plan.generateTodosAgain")}
              onClick={() => setShowGenerate(true)}
            >
              <FileText size={12} strokeWidth={2.2} />
              {plan.status === "finalized"
                ? t("plan.generateTodos")
                : t("plan.generateTodosAgain")}
            </button>
            {canDelete && (
              <button
                type="button"
                style={s.knowledgeSecondaryBtn}
                onClick={() => void handleDelete()}
              >
                <Trash2 size={12} strokeWidth={2.2} />
                {t("plan.delete")}
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

        <div style={s.planPreviewBody}>
          {loading ? (
            <div style={s.yunxiaoEmpty}>
              <Loader2 size={18} className="spin" />
            </div>
          ) : loadError && !markdown ? (
            <div style={s.planPanelEmpty}>
              {plan.status === "draft"
                ? t("plan.preview.discussionRunning")
                : t("plan.preview.mdMissing")}
            </div>
          ) : (
            <>
              <div
                className="plan-md"
                style={s.planPanelMarkdown}
                dangerouslySetInnerHTML={{ __html: html }}
              />
              {images.length > 0 && (
                <div style={s.planPanelGallery}>
                  {images.map((image) => (
                    <div key={image.key} style={s.planPanelGalleryItem}>
                      <img src={image.dataUrl} alt={image.serial} style={s.planPanelImage} />
                      <span style={s.planPanelGalleryLabel}>{image.serial}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {showGenerate && (
          <GeneratePlanTodosDialog
            plan={plan}
            tasks={tasks}
            onCreateTodos={async (input) => {
              const ok = await onCreateTodos(input);
              if (ok) setShowGenerate(false);
              return ok;
            }}
            onClose={() => setShowGenerate(false)}
          />
        )}
      </div>
    </div>
  );
}
