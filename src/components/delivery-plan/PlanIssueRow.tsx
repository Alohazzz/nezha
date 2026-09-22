import type { Plan, PlanIssue } from "../../types";
import s from "../../styles";
import { ISSUE_STATUS_LABEL } from "./PlanPanel";
import type { IssueStatus } from "./deriveIssueStatus";

/** 计划详情里的一行议题：派生状态＋关联方案＋启动动作（行组件独立防列表重渲染）。 */
export function PlanIssueRow({
  issue,
  status,
  schemes,
  onStart,
  onOpenWorkitem,
}: {
  issue: PlanIssue;
  status: IssueStatus;
  schemes: Plan[];
  onStart: () => void;
  onOpenWorkitem?: (workitemId: string) => void;
}) {
  return (
    <tr>
      <td style={s.dpTd}>
        <span style={s.dpChipMono}>{issue.serialNumber}</span>{" "}
        {issue.subject}
      </td>
      <td style={s.dpTd}>
        <span style={s.dpChip}>{ISSUE_STATUS_LABEL[status]}</span>
      </td>
      <td style={s.dpTd}>
        {schemes.length === 0
          ? "—"
          : schemes.map((sc) => (
              <button
                key={sc.id}
                type="button"
                style={s.dpChip}
                onClick={() => onOpenWorkitem?.(issue.workitemId)}
              >
                {sc.name || sc.issues[0]?.serialNumber}·{sc.status}
              </button>
            ))}
      </td>
      <td style={s.dpTd}>
        {(status === "not_started" || status === "aborted") && (
          <button type="button" style={s.dpBtn} onClick={onStart}>
            {status === "aborted" ? "重新发起" : "直接开始"}
          </button>
        )}
        {status === "discussing" || status === "discussed" ? (
          <button type="button" style={s.dpBtn} onClick={onStart}>
            直接开始
          </button>
        ) : null}
      </td>
    </tr>
  );
}
