import { Sparkles, X } from "lucide-react";
import type { PlanIssue } from "../../types";
import s from "../../styles";
import { PlanIssueRow, type PlanIssueRowData } from "./PlanIssueRow";

/** 计划详情的议题列表：多选动作条（合并讨论）＋议题表。
 *
 *  形态对齐云效议题列表（`YunxiaoIssueList`）：行内勾选 → 顶部动作条把勾选的 N 条
 *  议题**合成一份方案**发起讨论；行内另有「单条讨论」快捷入口（N=1，同一链路）与
 *  「在云效打开」链接。抽成独立组件是为了让 `PlanPanel` 不越过 AGENTS.md 的 400 行上限。 */
export function PlanIssueList({
  rows,
  occupiedIds,
  selectedIds,
  selectionMode,
  yunxiaoProjectId,
  onToggleSelect,
  onDiscuss,
  onMergeDiscuss,
  onClearSelection,
  onStart,
  onRemove,
  onOpenWorkitem,
}: {
  rows: readonly PlanIssueRowData[];
  /** 已被任务/存活方案占用的议题 id：勾选框禁用、讨论入口收起。 */
  occupiedIds: ReadonlySet<string>;
  /** 多选模式下的已选议题 id。 */
  selectedIds: ReadonlySet<string>;
  /** 是否处于多选模式（已选 ≥1 时为 true，此时动作条出现）。 */
  selectionMode: boolean;
  yunxiaoProjectId: string;
  onToggleSelect: (issue: PlanIssue) => void;
  /** 行内单条「单条讨论」（N=1）。 */
  onDiscuss: (issue: PlanIssue) => void;
  /** 动作条「合并讨论」：把已勾选的议题合成一份方案发起。 */
  onMergeDiscuss: () => void;
  onClearSelection: () => void;
  onStart: (issue: PlanIssue) => void;
  onRemove: (workitemId: string) => void;
  onOpenWorkitem?: (workitemId: string) => void;
}) {
  return (
    <>
      {selectionMode && (
        <div style={s.dpSelectBar}>
          <span style={s.dpSelectCount}>已选 {selectedIds.size} 项</span>
          <button type="button" style={s.dpBtnPrimary} onClick={onMergeDiscuss}>
            <Sparkles size={12} strokeWidth={2.2} />
            合并讨论
          </button>
          <span style={s.dpHint}>把勾选的议题合成一份方案，发起一次讨论。</span>
          <span style={s.dpSpacer} />
          <button type="button" style={s.dpBtn} onClick={onClearSelection}>
            <X size={12} strokeWidth={2.2} />
            清空
          </button>
        </div>
      )}

      <table style={s.dpTable}>
        <thead>
          <tr>
            <th style={s.dpThCheck} />
            <th style={s.dpTh}>议题</th>
            <th style={s.dpTh}>状态</th>
            <th style={s.dpTh}>关联方案</th>
            <th style={s.dpTh} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <PlanIssueRow
              key={row.issue.workitemId}
              row={row}
              occupied={occupiedIds.has(row.issue.workitemId)}
              selected={selectedIds.has(row.issue.workitemId)}
              yunxiaoProjectId={yunxiaoProjectId}
              onToggleSelect={onToggleSelect}
              onDiscuss={onDiscuss}
              onStart={() => onStart(row.issue)}
              onRemove={() => onRemove(row.issue.workitemId)}
              onOpenWorkitem={onOpenWorkitem}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}
