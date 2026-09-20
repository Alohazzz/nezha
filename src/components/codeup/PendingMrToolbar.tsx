import { RefreshCw, Trash2, X } from "lucide-react";
import { SelectField } from "../yunxiao/SelectField";
import s from "../../styles";

/** Radix Select 不允许空字符串选项值（空串是它的「清空」哨兵），故仓库筛选用显式哨兵。 */
export const ALL_REPOS = "__all__";

/**
 * 「待发起」视图的头部工具条。
 *
 * 左起：返回、仓库筛选（Radix Select）、「我的提交」开关、搜索、刷新；
 * 右侧主操作是「删除远端分支(N)」，N 为当前已选中且**可删**的条数，N = 0 时禁用。
 */
export function PendingMrToolbar({
  repoFilter,
  repoOptions,
  mineOnly,
  query,
  loading,
  pruneBusy,
  selectedDeletableCount,
  onBack,
  onRepoChange,
  onToggleMineOnly,
  onQueryChange,
  onRefresh,
  onPrune,
}: {
  repoFilter: string;
  repoOptions: { value: string; label: string }[];
  mineOnly: boolean;
  query: string;
  loading: boolean;
  pruneBusy: boolean;
  selectedDeletableCount: number;
  onBack: () => void;
  onRepoChange: (repo: string) => void;
  onToggleMineOnly: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onPrune: () => void;
}) {
  return (
    <div className="pm-toolbar">
      <button type="button" className="pm-back" onClick={onBack}>
        <X size={14} />
        返回
      </button>
      <span className="pm-toolbar-sep" />
      <div className="pm-repo-select">
        <SelectField
          value={repoFilter || ALL_REPOS}
          onChange={(value) => onRepoChange(value === ALL_REPOS ? "" : value)}
          options={repoOptions}
          placeholder="全部仓库"
        />
      </div>
      <button
        type="button"
        className="pm-toggle"
        data-active={mineOnly}
        aria-pressed={mineOnly}
        onClick={onToggleMineOnly}
      >
        {mineOnly ? "●" : "○"} 我的提交
      </button>
      <input
        className="pm-search"
        placeholder="搜索分支…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <button type="button" className="pm-refresh rp-text-btn" disabled={loading} onClick={onRefresh}>
        <RefreshCw size={13} className={loading ? "spin" : undefined} />
        {loading ? "刷新中…" : "刷新"}
      </button>
      <div className="pm-toolbar-fill" />
      <button
        type="button"
        className="rp-text-btn"
        data-variant="primary"
        disabled={pruneBusy || selectedDeletableCount === 0}
        title="只删除远端分支；未完成合并或受保护的分支会被拒绝"
        onClick={onPrune}
      >
        <Trash2 size={13} />
        删除远端分支
        {selectedDeletableCount > 0 && (
          <span className="rp-count-chip">{selectedDeletableCount}</span>
        )}
      </button>
    </div>
  );
}

/** 状态提示条（错误 / 平台降级 / 操作回执 / 扫描失败的仓库）。 */
export function PendingMrBanners({
  error,
  notice,
  mrOk,
  mrMissingRepos,
  failedScans,
}: {
  error: string;
  notice: string;
  /** 是否有任一仓库拿到了平台 MR 数据。 */
  mrOk: boolean;
  /** MR 数据缺失的仓库名（逐仓库列出，避免一个仓库有数据就掩盖另一个的缺失）。 */
  mrMissingRepos: string[];
  failedScans: { name: string; message: string }[];
}) {
  return (
    <>
      {error && (
        <div className="pm-banner" data-tone="error" style={s.bbGateHint}>
          {error}
        </div>
      )}
      {!mrOk && mrMissingRepos.length > 0 && (
        <div className="pm-banner" data-tone="warn" style={s.bbGateHint}>
          云效 MR 数据不可用（{mrMissingRepos.join("、")}）：「是否已有开放 MR」按未知处理
          （未按此过滤）。请检查应用设置中的云效令牌。
        </div>
      )}
      {notice && (
        <div className="pm-banner" data-tone="info">
          {notice}
        </div>
      )}
      {failedScans.length > 0 && (
        <div className="pm-banner" data-tone="warn">
          {failedScans.map((scan) => `${scan.name}：${scan.message}`).join("；")}
        </div>
      )}
    </>
  );
}

/**
 * 「全选当前列表」行 + 可删计数。
 *
 * 计数单列出来是因为「全选」勾上的分支里可能有一部分过不了删除门禁
 * （未完成合并 / 受保护），用户需要知道真正会被删掉几条。
 */
export function PendingMrSelectAll({
  visibleCount,
  deletableCount,
  allSelected,
  onToggleAll,
}: {
  visibleCount: number;
  deletableCount: number;
  allSelected: boolean;
  onToggleAll: (checked: boolean) => void;
}) {
  if (visibleCount === 0) return null;
  return (
    <div className="pm-select-all" style={s.bbCardSub}>
      <label className="pm-select-all-label">
        <input
          type="checkbox"
          className="pm-check"
          checked={allSelected}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
        全选当前列表（{visibleCount}）
      </label>
      <span className="pm-fill" />
      <span className="pm-label">已选 {deletableCount} 项可删除</span>
    </div>
  );
}
