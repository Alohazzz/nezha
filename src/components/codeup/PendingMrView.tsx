import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import type { PendingBranchCandidate, PendingBranchRepoScan, Project } from "../../types";
import { load, save } from "../../utils";
import s from "../../styles";
import { PendingMrCard } from "./PendingMrCard";
import { PruneRemoteConfirmDialog } from "./PruneRemoteConfirmDialog";
import {
  ALL_REPOS,
  PendingMrBanners,
  PendingMrSelectAll,
  PendingMrToolbar,
} from "./PendingMrToolbar";
import { useRemoteBranchPrune } from "./useRemoteBranchPrune";
import { applyFilters, candidateKey, flattenScans, sortCandidates } from "./pendingMr";

const MINE_ONLY_KEY = "nezha.pendingMr.mineOnly";
const REPO_FILTER_KEY = "nezha.pendingMr.repo";
const TARGET_OVERRIDES_KEY = "nezha.pendingMr.targetOverrides";

/** 受保护分支在目标分支下拉里的标识后缀。 */
const PROTECTED_MARK = " ◎";

/** 目标分支覆盖值（按「仓库路径 + 分支」记忆，跨会话保留）。 */
type TargetOverrides = Record<string, string>;

/** 扫描结果 + 它所属的项目根（删除时按项目校验仓库路径在项目内）。 */
interface ScopedScan extends PendingBranchRepoScan {
  projectPath: string;
}

function overrideKey(repoPath: string, branch: string): string {
  return `${repoPath}\u0000${branch}`;
}

/**
 * 「待发起」视图：把本地/远端分支元数据与云效平台侧数据 join，列出「已推送 + 有未合并提交 +
 * 无开放 MR」的候选分支，并承载「批量删除已收尾远端分支」。
 *
 * 与「合并审核」并列的独立欢迎页视图：后者只列平台上已有的 MR，本视图覆盖的正是**还没
 * 发起 MR** 的分支。删除按仓库既有两阶段模式走（dry-run 扫描 → 确认弹层 → 逐条回执）。
 */
export function PendingMrView({
  projects,
  onBack,
}: {
  /** 工作区内的全部项目（每个项目下可能还有多个 git 仓库）。 */
  projects: Project[];
  onBack: () => void;
}) {
  const [scans, setScans] = useState<ScopedScan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mineOnly, setMineOnly] = useState(() => load(MINE_ONLY_KEY, true));
  const [repoFilter, setRepoFilter] = useState(() => load(REPO_FILTER_KEY, ""));
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState<TargetOverrides>(() =>
    load<TargetOverrides>(TARGET_OVERRIDES_KEY, {}),
  );

  const refresh = useCallback(
    async (repo: string, showSpinner: boolean, currentOverrides: TargetOverrides) => {
      if (showSpinner) setLoading(true);
      setError("");
      const collected: ScopedScan[] = [];
      const failures: string[] = [];
      // 目标分支覆盖要发回后端参与判定：否则行上按新目标分支出示的合并状态/可删性
      // 仍是按旧目标算出来的（徽标会与实际不符）。
      const overridesByBranch: Record<string, string> = {};
      for (const [key, target] of Object.entries(currentOverrides)) {
        const [, branch] = key.split("\u0000");
        if (branch && target) overridesByBranch[branch] = target;
      }
      for (const project of projects) {
        try {
          const list = await invoke<PendingBranchRepoScan[]>("list_branch_pr_candidates", {
            projectPath: project.path,
            repoFilter: repo || null,
            targetOverrides: Object.keys(overridesByBranch).length > 0 ? overridesByBranch : null,
          });
          for (const scan of list) collected.push({ ...scan, projectPath: project.path });
        } catch (e) {
          // 单个项目失败不应让整个视图失败——如实收集原因，其余项目照常展示。
          failures.push(`${project.name}：${e}`);
        }
      }
      setScans(collected);
      setError(failures.join("；"));
      if (showSpinner) setLoading(false);
    },
    [projects],
  );

  const projectPaths = useMemo(() => projects.map((p) => p.path).join("\u0000"), [projects]);

  useEffect(() => {
    void refresh(repoFilter, true, overrides);
    // 只跟项目集合与首屏筛选绑定；仓库切换由 onRepoChange 显式触发，避免重复加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPaths]);

  useEffect(() => {
    save(MINE_ONLY_KEY, mineOnly);
  }, [mineOnly]);

  useEffect(() => {
    save(REPO_FILTER_KEY, repoFilter);
  }, [repoFilter]);

  useEffect(() => {
    save(TARGET_OVERRIDES_KEY, overrides);
  }, [overrides]);

  // 仓库下拉的选项不能在筛选后收窄：否则选中某个仓库后，其余仓库从下拉里消失、
  // 用户无法再切回去。故记住「见过的全部仓库名」，只增不减。
  const knownReposRef = useRef<string[]>([]);
  const repoOptions = useMemo(() => {
    for (const scan of scans) {
      if (!knownReposRef.current.includes(scan.name)) knownReposRef.current.push(scan.name);
    }
    const options = [{ value: ALL_REPOS, label: "全部仓库" }];
    for (const name of [...knownReposRef.current].sort((a, b) => a.localeCompare(b))) {
      options.push({ value: name, label: name });
    }
    return options;
  }, [scans]);

  /**
   * 行内「目标分支」下拉的选项：各仓库出现过的分支名。
   *
   * 受保护分支带标识——用户不该把目标分支误选成普通功能分支。
   */
  const targetOptions = useMemo(() => {
    const names = new Map<string, boolean>();
    for (const scan of scans) {
      for (const branch of scan.branches) {
        names.set(branch.branch, (names.get(branch.branch) ?? false) || branch.protected);
      }
    }
    for (const fallback of ["develop", "master", "main"]) {
      names.set(fallback, true);
    }
    return [...names.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, protectedBranch]) => ({
        value: name,
        label: protectedBranch ? `${name}${PROTECTED_MARK}` : name,
      }));
  }, [scans]);

  // 逐仓库看 MR 数据：一个仓库有数据不代表另一个也有，否则缺数据的那个仓库会被静默漏报。
  const mrOk = useMemo(() => scans.some((scan) => scan.mrOk), [scans]);
  const mrMissing = useMemo(() => scans.filter((scan) => !scan.mrOk), [scans]);
  /** 卡片上的「无 MR」徽标按**该分支所属仓库**的 MR 数据可用性判定。 */
  const mrOkByRepo = useMemo(
    () => new Map(scans.map((scan) => [scan.path, scan.mrOk])),
    [scans],
  );
  const failedScans = useMemo(() => scans.filter((scan) => !scan.ok), [scans]);

  // 目标分支的覆盖值由后端应用（它才知道合并状态与可删性怎么算），前端不再二次改写，
  // 否则会把后端标好的 `targetSource: "user"` 覆写成别的来源。
  const visible = useMemo(
    () => sortCandidates(applyFilters(flattenScans(scans), { mineOnly, query })),
    [scans, mineOnly, query],
  );

  const visibleByKey = useMemo(
    () => new Map(visible.map((b) => [candidateKey(b), b])),
    [visible],
  );

  const selectedBranches = useMemo(
    () => [...selected].map((key) => visibleByKey.get(key)).filter(Boolean) as PendingBranchCandidate[],
    [selected, visibleByKey],
  );
  /** 已选中且可删的条数：头部主操作的计数，也是按钮是否可用的依据。 */
  const selectedDeletable = useMemo(
    () => selectedBranches.filter((b) => b.deletable),
    [selectedBranches],
  );

  const toggleRow = useCallback((branch: PendingBranchCandidate, checked: boolean) => {
    const key = candidateKey(branch);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const allVisibleSelected =
    visible.length > 0 && visible.every((b) => selected.has(candidateKey(b)));

  const toggleAll = useCallback(
    (checked: boolean) => {
      setSelected(checked ? new Set(visible.map(candidateKey)) : new Set());
    },
    [visible],
  );

  const {
    pruneBusy,
    pruneResults,
    pending,
    startPrune,
    confirmPrune,
    resetPruneResults,
    cancelPrune,
  } = useRemoteBranchPrune({
    scans,
    selectedDeletable,
    refresh: () => void refresh(repoFilter, false, overrides),
    clearSelection: () => setSelected(new Set()),
    setError,
    setNotice,
  });

  const onRepoChange = useCallback(
    (repo: string) => {
      setRepoFilter(repo);
      setSelected(new Set());
      resetPruneResults();
      void refresh(repo, true, overrides);
    },
    [refresh, overrides, resetPruneResults],
  );

  /**
   * 行内改目标分支：记住覆盖值**并重跑扫描**。
   *
   * 重跑是必要的——合并状态与可删性都是相对目标分支算出来的，不重算的话行上会继续显示
   * 按旧目标得出的结论（徽标与实际不符）。Radix Select 的变更是一次离散动作，不是逐键输入，
   * 因此直接触发一次扫描即可。
   */
  const onTargetChange = useCallback(
    (branch: PendingBranchCandidate, value: string) => {
      const next = { ...overrides, [overrideKey(branch.repoPath, branch.branch)]: value };
      setOverrides(next);
      void refresh(repoFilter, false, next);
    },
    [overrides, refresh, repoFilter],
  );

  const hasAnything = visible.length > 0;
  const hasProjects = projects.length > 0;


  return (
    <div style={s.welcomePane}>
      <PendingMrToolbar
        repoFilter={repoFilter}
        repoOptions={repoOptions}
        mineOnly={mineOnly}
        query={query}
        loading={loading}
        pruneBusy={pruneBusy}
        selectedDeletableCount={selectedDeletable.length}
        onBack={onBack}
        onRepoChange={onRepoChange}
        onToggleMineOnly={() => setMineOnly((v) => !v)}
        onQueryChange={setQuery}
        onRefresh={() => void refresh(repoFilter, true, overrides)}
        onPrune={() => void startPrune()}
      />

      <PendingMrBanners
        error={error}
        notice={notice}
        mrOk={mrOk}
        mrMissingRepos={mrMissing.map((scan) => scan.name)}
        failedScans={failedScans}
      />

      <div style={s.bbList}>
        <PendingMrSelectAll
          visibleCount={visible.length}
          deletableCount={selectedDeletable.length}
          allSelected={allVisibleSelected}
          onToggleAll={toggleAll}
        />

        {loading && scans.length === 0 && (
          <div style={s.bbRefreshing}>
            <RefreshCw size={16} className="spin" />
            正在扫描分支…
          </div>
        )}
        {!loading && !hasProjects && (
          <div style={s.bbEmpty}>
            工作区里还没有项目，先打开一个 Git 仓库。
          </div>
        )}
        {!loading && hasProjects && !hasAnything && !error && (
          <div style={s.bbEmpty}>
            {mineOnly
              ? "当前筛选下没有待发起的分支。可关闭「我的提交」查看同事的分支。"
              : "当前没有待发起的分支（已推送、有未合并提交、且无开放 MR 的分支）。"}
          </div>
        )}

        {visible.map((branch) => (
          <PendingMrCard
            key={candidateKey(branch)}
            branch={branch}
            checked={selected.has(candidateKey(branch))}
            mrOk={mrOkByRepo.get(branch.repoPath) ?? false}
            targetOptions={targetOptions}
            onToggle={(checked) => toggleRow(branch, checked)}
            onTargetChange={(value) => onTargetChange(branch, value)}
          />
        ))}

        {pruneResults.length > 0 && (
          <div className="pm-results">
            <div className="pm-label">删除结果</div>
            {pruneResults.map((item) => (
              <div
                key={`${item.repoPath}:${item.branch}`}
                className="pm-result-line"
                data-tone={item.deleted ? "ok" : item.deletable ? "error" : "warn"}
              >
                {item.deleted ? "✓ 已删除" : item.deletable ? "× 删除失败" : "· 跳过"} {item.repo}:
                {item.branch} — {item.reason}
              </div>
            ))}
          </div>
        )}
      </div>

      <PruneRemoteConfirmDialog
        pending={pending}
        busy={pruneBusy}
        onCancel={cancelPrune}
        onConfirm={() => void confirmPrune()}
      />
    </div>
  );
}
