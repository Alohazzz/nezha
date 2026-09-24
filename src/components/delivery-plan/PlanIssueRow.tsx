import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import type { Plan, PlanIssue } from "../../types";
import { buildYunxiaoIssueLink } from "../../utils/yunxiao";
import s from "../../styles";
import { dpChipToneStyle } from "../../styles/delivery-plan";
import { ISSUE_STATUS_LABEL, ISSUE_STATUS_TONE, SCHEME_STATUS_LABEL } from "./labels";
import type { IssueStatus } from "./deriveIssueStatus";

export interface PlanIssueRowData {
  issue: PlanIssue;
  status: IssueStatus;
  schemes: Plan[];
}

/** 计划详情里的一行议题（mockup 表格行）：勾选框＋派生状态 chip＋关联方案 chip＋动作。
 *  行组件独立防列表重渲染。
 *
 *  行内动作都是一次点击直达的文字按钮（无二级菜单）：主操作（「直接开始」/「重新发起」）
 *  常驻，次级动作（「单条讨论」「移出计划」）行悬停时才现身——整行静止态不再是一排实心
 *  按钮（见 `styles/row-actions.css`）。
 *
 *  「单条讨论」与「在云效打开」跟云效议题列表同一口径。已被任务或存活方案占用的议题
 *  （`occupied`）不再提供讨论入口：再发起会为同一议题多造一份方案，与云效列表的
 *  已导入守卫同源（判定见 `collectOccupiedYunxiaoWorkitemIds`）。 */
export function PlanIssueRow({
  row,
  occupied,
  selected,
  yunxiaoProjectId,
  onToggleSelect,
  onDiscuss,
  onStart,
  onRemove,
  onOpenWorkitem,
}: {
  row: PlanIssueRowData;
  /** 已被任务/存活方案占用：勾选框禁用、讨论入口收起（直接开始不受影响）。 */
  occupied: boolean;
  selected: boolean;
  /** 云效云项目 ID（构建源议题链接；空则不显示链接按钮）。 */
  yunxiaoProjectId: string;
  onToggleSelect: (issue: PlanIssue) => void;
  onDiscuss: (issue: PlanIssue) => void;
  onStart: () => void;
  onRemove?: () => void;
  onOpenWorkitem?: (workitemId: string) => void;
}) {
  const { issue, status, schemes } = row;
  const [hover, setHover] = useState(false);

  const ordered = useMemo(
    () => [...schemes].sort((a, b) => b.createdAt - a.createdAt),
    [schemes],
  );

  const issueLink = yunxiaoProjectId
    ? buildYunxiaoIssueLink(yunxiaoProjectId, issue.workitemId)
    : "";

  return (
    <tr
      className="row-actions-host"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <td style={s.dpTdCheck}>
        <label
          style={occupied ? s.yunxiaoIssueCheckDisabled : s.yunxiaoIssueCheck}
          title={occupied ? "已被任务或方案占用，不能重复发起讨论" : undefined}
        >
          <input
            type="checkbox"
            disabled={occupied}
            checked={selected}
            aria-label={`选择议题 ${issue.serialNumber}`}
            onChange={() => onToggleSelect(issue)}
          />
        </label>
      </td>
      <td style={s.dpTd}>
        <div style={s.dpIssueCell}>
          <span style={s.dpChipMono}>{issue.serialNumber}</span>
          <span style={s.dpIssueSubject}>{issue.subject}</span>
          {issueLink && (
            <button
              type="button"
              style={hover ? s.dpIssueLinkBtnHover : s.dpIssueLinkBtn}
              title={`在云效打开 ${issue.serialNumber}`}
              aria-label={`在云效打开 ${issue.serialNumber}`}
              onClick={() => openUrl(issueLink).catch(() => {})}
            >
              <ExternalLink size={12} strokeWidth={2} />
            </button>
          )}
        </div>
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
      <td style={s.dpTdActions}>
        {/* 顺序：次级动作在左（收起时不占视觉），主操作永远在最右——悬停现身时主操作不位移。 */}
        <div className="row-actions" data-testid={`plan-issue-actions-${issue.workitemId}`}>
          {!occupied && (
            <button
              type="button"
              className="row-actions-btn row-actions-secondary"
              data-tone="secondary"
              title="只讨论这一条议题（与合并讨论同一链路）"
              onClick={() => onDiscuss(issue)}
            >
              单条讨论
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="row-actions-btn row-actions-secondary"
              data-tone="danger"
              onClick={onRemove}
            >
              移出计划
            </button>
          )}
          {status === "not_started" && (
            <button type="button" className="row-actions-btn" data-tone="primary" onClick={onStart}>
              直接开始
            </button>
          )}
          {status === "aborted" && (
            <button type="button" className="row-actions-btn" data-tone="primary" onClick={onStart}>
              重新发起
            </button>
          )}
          {(status === "discussing" || status === "discussed") && (
            <button type="button" className="row-actions-btn" data-tone="primary" onClick={onStart}>
              直接开始
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
