import {
  Download,
  FileText,
  GitBranch,
  GitMerge,
  Play,
  CircleSlash,
  ArrowRight,
} from "lucide-react";
import type { CodeupMr } from "../../../types";
import type { MergeAction } from "./useMergeHub";
export const statusLabels: Record<string, string> = {
  UNDER_DEV: "开发中",
  UNDER_REVIEW: "评审中",
  TO_BE_MERGED: "待合并",
  APPROVED: "已通过",
  CLOSED: "已关闭",
  MERGED: "已合并",
};
export function MrStatus({ mr }: { mr: CodeupMr }) {
  return (
    <span className="mh-badge" data-state={mr.status}>
      {statusLabels[mr.status] ?? mr.status}
    </span>
  );
}
export function MergeDetail({
  mr,
  busy,
  onAction,
  onReport,
  onClose,
}: {
  mr: CodeupMr;
  busy: { id: string; action: MergeAction } | null;
  onAction: (action: MergeAction) => void;
  onReport: () => void;
  onClose: () => void;
}) {
  const closed = mr.status === "CLOSED" || mr.status === "MERGED";
  const running = busy?.id === mr.id ? busy.action : null;
  return (
    <article className="mh-detail" aria-label="合并请求详情">
      <div className="mh-detail-top">
        <MrStatus mr={mr} />
        <span>
          {mr.repository} #{mr.localId}
        </span>
      </div>
      <h2>{mr.title}</h2>
      <div className="mh-branches">
        <GitBranch size={14} />
        <code>{mr.sourceBranch}</code>
        <ArrowRight size={13} />
        <code>{mr.targetBranch}</code>
      </div>
      <div className="mh-people">
        <div>
          <span>提交人</span>
          <strong>{mr.author || "未提供"}</strong>
        </div>
        <div>
          <span>审核人</span>
          <strong>{mr.reviewers.join("、") || "未指定"}</strong>
        </div>
      </div>
      <div className="mh-checklist">
        <h3>{closed ? "请求信息" : "合并前检查"}</h3>
        <p>
          <Download size={15} />
          本地代码<strong>{mr.pulled ? "已拉取" : "未拉取"}</strong>
        </p>
        <p data-warning={mr.hasConflict}>
          <GitBranch size={15} />
          分支冲突<strong>{mr.hasConflict ? "存在冲突" : "未报告冲突"}</strong>
        </p>
        <p>
          <FileText size={15} />
          审核状态<strong>{statusLabels[mr.status] ?? mr.status}</strong>
        </p>
      </div>
      <div className="mh-actions">
        {!closed && (
          <>
            <button className="mh-button" disabled={!!busy} onClick={() => onAction("pull")}>
              <Download size={14} />
              {running === "pull" ? "拉取中…" : mr.pulled ? "重新拉取" : "拉取代码"}
            </button>
            <button className="mh-button" disabled={!!busy} onClick={() => onAction("review")}>
              <Play size={14} />
              {running === "review" ? "启动中…" : "代码审查"}
            </button>
            <button
              className="mh-button"
              data-variant="primary"
              disabled={!!busy || !mr.pulled}
              title={!mr.pulled ? "请先拉取代码" : "交给 Agent 执行分支合并"}
              onClick={() => onAction("merge")}
            >
              <GitMerge size={14} />
              {running === "merge" ? "启动中…" : "分支合并"}
            </button>
          </>
        )}
        <button className="mh-button" disabled={!!busy} onClick={onReport}>
          <FileText size={14} />
          审查报告
        </button>
      </div>
      {!closed && (
        <button className="mh-button mh-close-button" disabled={!!busy} onClick={onClose}>
          <CircleSlash size={14} />
          关闭请求
        </button>
      )}
    </article>
  );
}
