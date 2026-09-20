import type { PendingBranchCandidate } from "../../types";
import { SelectField } from "../yunxiao/SelectField";
import s from "../../styles";
import { badgesFor, commitSummary, targetSourceLabel } from "./pendingMr";

/** 行内「目标分支」下拉的选项（受保护分支带标识）。 */
export interface TargetOption {
  value: string;
  label: string;
}

/**
 * 单个候选分支卡片。
 *
 * 卡片而非数据网格：每个分支要承载多段异构信息（分支名、目标分支可编辑、推断来源、
 * 合并状态、作者、时间、diff 计量），网格列宽在窄窗口下会崩。与 `MergeHubView` 的
 * 卡片列表同构，两个视图切换时观感连续。
 */
export function PendingMrCard({
  branch,
  checked,
  mrOk,
  targetOptions,
  onToggle,
  onTargetChange,
}: {
  branch: PendingBranchCandidate;
  checked: boolean;
  /** 平台 MR 数据是否可用（不可用时不假装「无 MR」）。 */
  mrOk: boolean;
  targetOptions: TargetOption[];
  onToggle: (checked: boolean) => void;
  onTargetChange: (value: string) => void;
}) {
  const badges = badgesFor(branch, mrOk);
  return (
    <div style={s.bbCard}>
      <div className="pm-card-head">
        <input
          type="checkbox"
          className="pm-check"
          aria-label={branch.branch}
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="pm-branch" title={branch.branch}>
          {branch.branch}
        </span>
        {branch.repo !== "" && <span className="pm-badge pm-badge-repo">{branch.repo}</span>}
        <span className="pm-fill" />
        {(branch.additions > 0 || branch.deletions > 0) && (
          <span className="pm-metric">
            <span className="pm-metric-add">+{branch.additions}</span>
            <span className="pm-metric-del">-{branch.deletions}</span>
          </span>
        )}
      </div>

      <div className="pm-card-row">
        {badges.map((badge) => (
          <span key={badge.text} className="pm-badge" data-tone={badge.tone}>
            {badge.text}
          </span>
        ))}
      </div>

      <div className="pm-card-row">
        <span className="pm-label">目标分支</span>
        <div className="pm-target-select">
          <SelectField
            value={branch.targetBranch}
            onChange={onTargetChange}
            options={targetOptions}
            placeholder="选择目标分支"
          />
        </div>
        <span className="pm-hint">（{targetSourceLabel(branch.targetSource)}）</span>
      </div>

      <div className="pm-card-row pm-card-meta">
        <span>{commitSummary(branch)}</span>
        {!branch.deletable && branch.skipReason && (
          <span className="pm-skip" data-tone={branch.protected ? "neutral" : "warn"}>
            {branch.protected ? "受保护分支，不可删除" : `⚠ ${branch.skipReason}`}
          </span>
        )}
        {branch.deletable && (
          <span className="pm-skip" data-tone="ok">
            已合并，可删除远端分支
          </span>
        )}
      </div>
    </div>
  );
}
