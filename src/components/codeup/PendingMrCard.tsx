import type { PendingBranchCandidate } from "../../types";
import { Trash2 } from "lucide-react";
import { SelectField } from "../yunxiao/SelectField";
import s from "../../styles";
import { badgesFor, relativeTime } from "./pendingMr";

/** 行内「目标分支」下拉的选项。 */
export interface TargetOption {
  value: string;
  label: string;
}

/**
 * 单个候选分支卡片。
 *
 * 两行布局，刻意压扁：`分支名 + 仓库 + 状态徽标 + diff 计量` 一行（横向空间本来就有富余），
 * `目标分支下拉 + 提交摘要 + 删除` 一行。早先是四行堆叠，一屏只放得下 4 张卡片。
 *
 * 卡片而非数据网格：每个分支要承载多段异构信息（分支名、目标分支可编辑、推断来源、合并状态、
 * 作者、时间、diff 计量），网格列宽在窄窗口下会崩。与 `MergeHubView` 的卡片列表同构，
 * 两个视图切换时观感连续。
 */
export function PendingMrCard({
  branch,
  checked,
  mrOk,
  targetOptions,
  targetValue,
  targetProtected,
  targetSource,
  onToggle,
  onTargetChange,
  onPrune,
}: {
  branch: PendingBranchCandidate;
  checked: boolean;
  /** 平台 MR 数据是否可用（不可用时不假装「无 MR」）。 */
  mrOk: boolean;
  targetOptions: TargetOption[];
  /** 下拉实际选中的值（已归一到选项大小写）；用于规避 `Develop` / `develop` 的差异。 */
  targetValue: string;
  /** 选中的目标分支是否受保护（受保护徽标挂在选中项旁边，选项文字保持纯分支名）。 */
  targetProtected: boolean;
  /** 目标分支推断来源的说明文案（「按分支名推断」等）。 */
  targetSource: string;
  onToggle: (checked: boolean) => void;
  onTargetChange: (value: string) => void;
  onPrune: () => void;
}) {
  const badges = badgesFor(branch, mrOk);
  const when = relativeTime(branch.lastCommitAt);
  const skipTone = branch.deletable ? "ok" : branch.protected ? "neutral" : "warn";
  const skipText = branch.deletable
    ? "已合并，可删除远端分支"
    : branch.protected
      ? "受保护分支，不可删除"
      : `⚠ ${branch.skipReason}`;
  return (
    <div className="pm-card" style={s.pmCard}>
      <div className="pm-card-head" style={s.bbCardHead}>
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
        {badges.map((badge) => (
          <span key={badge.text} className="pm-badge" data-tone={badge.tone}>
            {badge.text}
          </span>
        ))}
        <span style={s.bbFill} />
        {(branch.additions > 0 || branch.deletions > 0) && (
          <span className="pm-metric">
            <span className="pm-metric-add">+{branch.additions}</span>
            <span className="pm-metric-del">-{branch.deletions}</span>
          </span>
        )}
      </div>

      <div className="pm-card-row" style={s.bbCardSub}>
        <span className="pm-label">目标分支</span>
        <div className="pm-target-select">
          <SelectField
            value={targetValue}
            onChange={onTargetChange}
            options={targetOptions}
            placeholder="选择目标分支"
            triggerStyle={s.pmTargetTrigger}
          />
        </div>
        {targetProtected && <span className="pm-badge">受保护</span>}
        <span className="pm-hint">{targetSource}</span>
        <span className="pm-dot-sep">·</span>
        <span>{branch.unmerged} 个未合并提交</span>
        {branch.lastCommitAuthor.trim() !== "" && (
          <>
            <span className="pm-dot-sep">·</span>
            <span>{branch.lastCommitAuthor}</span>
          </>
        )}
        {when !== "" && (
          <>
            <span className="pm-dot-sep">·</span>
            <span>{when}</span>
          </>
        )}
        <span className="pm-skip-inline" data-tone={skipTone}>
          {skipText}
        </span>
        <span style={s.bbFill} />
        {/* 单行删除：只删这条。批量删除在头部（按勾选）。 */}
        <button
          type="button"
          className="rp-text-btn"
          disabled={!branch.deletable}
          title={branch.deletable ? "删除该远端分支（本地分支不受影响）" : branch.skipReason || "不可删除"}
          onClick={onPrune}
        >
          <Trash2 size={12} />
          删除
        </button>
      </div>
    </div>
  );
}
