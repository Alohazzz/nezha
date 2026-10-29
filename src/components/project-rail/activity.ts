import type { Task } from "../../types";

export type ProjectStatus = "attention" | "running" | null;

export type ProjectActivity = {
  status: ProjectStatus;
  attentionCount: number;
  /** 「已完成未读」任务数：独立信息性标识，不计入 attentionCount、不受角标开关控制。 */
  unreadCount: number;
};

export const EMPTY_PROJECT_ACTIVITY: ProjectActivity = {
  status: null,
  attentionCount: 0,
  unreadCount: 0,
};

export function getProjectActivity(
  activityByProjectId: Map<string, ProjectActivity>,
  projectId: string,
): ProjectActivity {
  return activityByProjectId.get(projectId) ?? EMPTY_PROJECT_ACTIVITY;
}

export function buildProjectActivityMap(tasks: Task[]): Map<string, ProjectActivity> {
  const activityByProjectId = new Map<string, ProjectActivity>();
  for (const task of tasks) {
    let activity = activityByProjectId.get(task.projectId);
    if (!activity) {
      activity = { status: null, attentionCount: 0, unreadCount: 0 };
      activityByProjectId.set(task.projectId, activity);
    }

    if (task.status === "input_required" || task.status === "awaiting_review") {
      activity.attentionCount += 1;
      activity.status = "attention";
    } else if (task.status === "detached" || task.status === "interrupted") {
      activity.status = "attention";
    } else if ((task.status === "running" || task.status === "pending") && activity.status === null) {
      activity.status = "running";
    }
    if (task.unreadAt !== undefined) activity.unreadCount += 1;
  }
  return activityByProjectId;
}
