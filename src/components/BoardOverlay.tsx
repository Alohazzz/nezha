import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Plan, Project, Task } from "../types";
import { KanbanView } from "./KanbanView";
import { PlanBoard } from "./yunxiao/plan/PlanBoard";
import type { PlanDeps } from "../utils/planDeps";
import { useI18n } from "../i18n";
import s from "../styles";

export type BoardTab = "tasks" | "plans";

/**
 * 看板浮层：任务看板与方案看板共用一个浮层、以 Tab 切换（避免项目栏入口膨胀）。
 * 任务看板按「跨项目总览」呈现；方案看板专注单个方案（顶部项目切换器锁定项目，
 * 左栏方案列表 + 右栏详情），空态与摘要由各自子视图负责。
 */
export function BoardOverlay({
  initialTab = "tasks",
  projects,
  tasks,
  plans,
  planDeps,
  activeProjectId,
  onClose,
  onTaskClick,
  onProjectClick,
  onPlanPreview,
  onPlanComplete,
  onPlanReopen,
  onPlanCancel,
  onPlanArchive,
  onPlanUnarchive,
  onPlanDelete,
}: {
  initialTab?: BoardTab;
  projects: Project[];
  tasks: Task[];
  plans: Plan[];
  planDeps: Record<string, PlanDeps | undefined>;
  /** 应用当前活动项目：方案看板以此作为锁定项目的初值。 */
  activeProjectId?: string | null;
  onClose: () => void;
  onTaskClick: (task: Task) => void;
  onProjectClick: (project: Project) => void;
  onPlanPreview: (plan: Plan) => void;
  onPlanComplete: (planId: string) => void;
  onPlanReopen: (planId: string) => void;
  onPlanCancel: (planId: string) => void;
  onPlanArchive: (planId: string) => void;
  onPlanUnarchive: (planId: string) => void;
  onPlanDelete: (planId: string) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<BoardTab>(initialTab);

  // Esc 关闭浮层。capture 阶段以避免被 xterm / 编辑器吞掉（与任务看板原行为一致）。
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [onClose]);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);
  const projectPaths = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.path);
    return map;
  }, [projects]);

  return (
    <div style={s.planBoardPane} data-board-tab={tab}>
      <div style={s.kanbanHeader}>
        <div style={s.boardTabs}>
          <button
            type="button"
            style={tab === "tasks" ? s.boardTabActive : s.boardTab}
            onClick={() => setTab("tasks")}
          >
            {t("board.tab.tasks")}
          </button>
          <button
            type="button"
            style={tab === "plans" ? s.boardTabActive : s.boardTab}
            onClick={() => setTab("plans")}
          >
            {t("board.tab.plans")}
          </button>
        </div>
        <button
          type="button"
          style={s.kanbanCloseBtn}
          onClick={onClose}
          title={t("kanban.close")}
          aria-label={t("kanban.close")}
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>

      {tab === "tasks" ? (
        <KanbanView
          projects={projects}
          tasks={tasks}
          onTaskClick={onTaskClick}
          onProjectClick={onProjectClick}
          onClose={onClose}
          embedded
        />
      ) : (
        <PlanBoard
          plans={plans}
          tasks={tasks}
          depsByPlanId={planDeps}
          projectNames={projectNames}
          projectPaths={projectPaths}
          activeProjectId={activeProjectId}
          onPreview={onPlanPreview}
          onOpenTask={(taskId) => {
            const task = tasks.find((item) => item.id === taskId);
            if (task) onTaskClick(task);
          }}
          onComplete={onPlanComplete}
          onReopen={onPlanReopen}
          onCancel={onPlanCancel}
          onArchive={onPlanArchive}
          onUnarchive={onPlanUnarchive}
          onDelete={onPlanDelete}
        />
      )}
    </div>
  );
}
