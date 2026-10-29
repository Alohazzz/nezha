import { Loader2 } from "lucide-react";
import type { TaskStatus } from "../types";

// 任务状态统一简化为小圆点（参照 ZCode 任务列表的做法）：
// 6px 实心圆 + 语义色，只有 running 保留 spinner。
// 外层 14px 容器与旧图标等宽，列表行布局不受影响。
const DOT_CLASS: Partial<Record<TaskStatus, string>> = {
  input_required: "status-dot status-dot--warning",
  waiting_deps: "status-dot status-dot--muted",
  awaiting_review: "status-dot status-dot--accent",
  detached: "status-dot status-dot--warning",
  interrupted: "status-dot status-dot--warning",
  done: "status-dot status-dot--success",
  failed: "status-dot status-dot--danger",
  cancelled: "status-dot status-dot--muted",
  todo: "status-dot status-dot--muted",
  pending: "status-dot status-dot--muted",
};

export function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === "running") {
    return (
      <span className="status-icon-slot">
        <Loader2 size={14} className="spin status-icon-muted" />
      </span>
    );
  }
  return (
    <span className="status-icon-slot">
      <span className={DOT_CLASS[status] ?? "status-dot status-dot--muted"} />
    </span>
  );
}
