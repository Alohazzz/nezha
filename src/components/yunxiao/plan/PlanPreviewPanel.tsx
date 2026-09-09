import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { FileText, Loader2, Trash2, X } from "lucide-react";
import type { AgentType, PermissionMode, Plan, PlanIssue, Task } from "../../../types";
import { buildPlanDisplayName, planDirPath, planMdPath } from "../../../utils/plan";
import { GeneratePlanTodosDialog } from "./GeneratePlanTodosDialog";
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
