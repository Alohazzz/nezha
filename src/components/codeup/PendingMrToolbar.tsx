import { RefreshCw, Send, Trash2, X } from "lucide-react";
import { SelectField } from "../yunxiao/SelectField";
import s from "../../styles";

/** Radix Select 不允许空字符串选项值（空串是它的「清空」哨兵），故仓库筛选用显式哨兵。 */
export const ALL_REPOS = "__all__";

/**
 * 「待发起」视图的头部工具条。
 *
 * 左起：返回、仓库筛选（Radix Select）、「我的提交」开关、搜索、刷新；
 * 右侧主操作是「发起合并请求(N)」与「删除远端分支(N)」——两者共用同一套勾选，
 * 按各自属性分别计数：未合并的分支计入发起、已收尾的分支计入删除。
 */
export function PendingMrToolbar({
  repoFilter,
  repoOptions,
  mineOnly,
  query,
  busy,
  busyLabel,
  createBusy,
  pruneBusy,
  selectedMrCount,
  selectedDeletableCount,
  onBack,
  onRepoChange,
  onToggleMineOnly,
  onQueryChange,
  onRefresh,
  onCreate,
  onPrune,
}: {
  repoFilter: string;
  repoOptions: { value: string; label: string }[];
  mineOnly: boolean;
  query: string;
  /** 正在发现仓库或扫描分支（两段加载任一在跑）。 */
  busy: boolean;
  /** 忙碌时刷新按钮上的文案（「发现中…」/「扫描中…」）。 */
  busyLabel: string;
  createBusy: boolean;
  pruneBusy: boolean;
  /** 已选中且可发起 MR 的条数。 */
  selectedMrCount: number;
  selectedDeletableCount: number;
  onBack: () => void;
  onRepoChange: (repo: string) => void;
  onToggleMineOnly: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onCreate: () => void;
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
      {/* 开关状态由 data-active 的底色表达，不再用 ●/○ 圆点。 */}
      <button
        type="button"
        className="pm-toggle"
        data-active={mineOnly}
        aria-pressed={mineOnly}
        onClick={onToggleMineOnly}
      >
        我的提交
      </button>
      <input
        className="pm-search"
        placeholder="搜索分支…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <button type="button" className="pm-refresh rp-text-btn" disabled={busy} onClick={onRefresh}>
        <RefreshCw size={13} className={busy ? "spin" : undefined} />
        {busy ? busyLabel : "刷新"}
      </button>
      <div className="pm-toolbar-fill" />
      {/* 发起合并是右侧主操作：已推送、有未合并提交、无开放 MR 的勾选项计入。 */}
      <button
        type="button"
        className="rp-text-btn"
        data-variant="accent"
        disabled={createBusy || selectedMrCount === 0}
        title="为勾选的分支在云效上发起合并请求（已有同源同目标 MR 的会自动跳过）"
        onClick={onCreate}
      >
        <Send size={13} />
        发起合并请求
        {selectedMrCount > 0 && <span className="rp-count-chip">{selectedMrCount}</span>}
      </button>
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
