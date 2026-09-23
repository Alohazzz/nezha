import { useMemo } from "react";
import type { Plan, PlanIssue } from "../../types";
import s from "../../styles";
import { dpChipToneStyle } from "../../styles/delivery-plan";
import { ISSUE_STATUS_LABEL, ISSUE_STATUS_TONE, SCHEME_STATUS_LABEL } from "./labels";
import type { IssueStatus } from "./deriveIssueStatus";

/** 计划详情里的一行议题（mockup 表格行）：派生状态 chip＋关联方案 chip＋动作。
 *  行组件独立防列表重渲染。 */
export function PlanIssueRow({
  issue,
  status,
  schemes,
  onStart,
  onRemove,
  onOpenWorkitem,
}: {
  issue: PlanIssue;
  status: IssueStatus;
  schemes: Plan[];
  onStart: () => void;
  onRemove?: () => void;
  onOpenWorkitem?: (workitemId: string) => void;
}) {
  const ordered = useMemo(
    () => [...schemes].sort((a, b) => b.createdAt - a.createdAt),
    [schemes],
  );
  return (
    <tr>
      <td style={s.dpTd}>
        <span style={s.dpChipMono}>{issue.serialNumber}</span> {issue.subject}
      </td>
      <td style={s.dpTd}>
        <span style={dpChipToneStyle[ISSUE_STATUS_TONE[status]]}>
          {ISSUE_STATUS_LABEL[status]}
        </span>
      </td>
      <td style={s.dpTd}>
        {ordered.length === 0
          ? "—"
          : ordered.map((sc) => (
              <button
                key={sc.id}
                type="button"
                style={s.dpChipAc}
                onClick={() => onOpenWorkitem?.(issue.workitemId)}
              >
                {sc.name || sc.issues[0]?.serialNumber}·
                {SCHEME_STATUS_LABEL[sc.status] ?? sc.status}
              </button>
            ))}
      </td>
      <td style={s.dpTd}>
        {/* 主动作 primary（mockup 行内动作的实色形态）；移出计划为次级。 */}
        {status === "not_started" && (
          <button type="button" style={s.dpBtnPrimary} onClick={onStart}>
            直接开始
          </button>
        )}
        {status === "aborted" && (
          <button type="button" style={s.dpBtnPrimary} onClick={onStart}>
            重新发起
          </button>
        )}
        {(status === "discussing" || status === "discussed") && (
          <button type="button" style={s.dpBtn} onClick={onStart}>
            直接开始
          </button>
        )}
        {onRemove && (
          <button type="button" style={s.dpBtn} onClick={onRemove}>
            移出计划
          </button>
        )}
      </td>
    </tr>
  );
}
