import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import type {
  PendingBranchCandidate,
  PendingBranchRepoRef,
  PendingBranchRepoScan,
  Project,
} from "../../types";
import { load, save } from "../../utils";
import s from "../../styles";
import { PendingMrCard } from "./PendingMrCard";
import { PruneRemoteConfirmDialog } from "./PruneRemoteConfirmDialog";
import { ALL_REPOS, PendingMrBanners, PendingMrSelectAll, PendingMrToolbar } from "./PendingMrToolbar";
import { useRemoteBranchPrune } from "./useRemoteBranchPrune";
import { applyFilters, candidateKey, flattenScans, sortCandidates, targetSourceLabel } from "./pendingMr";

const MINE_ONLY_KEY = "nezha.pendingMr.mineOnly";
const TARGET_OVERRIDES_KEY = "nezha.pendingMr.targetOverrides";

/** 目标分支覆盖值（按「仓库路径 + 分支」记忆，跨会话保留）。 */
type TargetOverrides = Record<string, string>;

/** 扫描结果 + 它所属的项目根（删除时按项目校验仓库路径在项目内）。 */
interface ScopedScan extends PendingBranchRepoScan {
  projectPath: string;
}

/** 一个项目下的仓库（或该项目发现失败的原因）。 */
interface ProjectRepos {
  project: Project;
  repos: PendingBranchRepoRef[];
  error: string;
}

function overrideKey(repoPath: string, branch: string): string {
  return `${repoPath}\u0000${branch}`;
}

/**
 * 「发起合并」视图：把本地/远端分支元数据与云效平台侧数据 join，列出「已推送 + 有未合并提交 +
 * 无开放 MR」的候选分支，并承载「批量删除已收尾远端分支」。
 *
 * 与「合并审核」并列的独立欢迎页视图：后者只列平台上已有的 MR，本视图覆盖的正是**还没
 * 发起 MR** 的分支。删除按仓库既有两阶段模式走（dry-run 扫描 → 确认弹层 → 逐条回执）。
 *
 * **分段加载**：一次扫全部仓库要几十秒（每个候选分支都要 rev-list / merge-base / cherry /
 * diff，外加 fetch），首屏会像卡住。因此先只做文件系统级的仓库发现（无 git 子进程，秒回），
 * 用户选中某个仓库后再扫那个仓库的分支。
 */
export function PendingMrView({
  projects,
  onBack,
}: {
  /** 工作区内的全部项目（每个项目下可能还有多个 git 仓库）。 */
  projects: Project[];
  onBack: () => void;
}) {
  const [projectRepos, setProjectRepos] = useState<ProjectRepos[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [scans, setScans] = useState<ScopedScan[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mineOnly, setMineOnly] = useState(() => load(MINE_ONLY_KEY, true));
  const [repoFilter, setRepoFilter] = useState("");
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState<TargetOverrides>(() =>
    load<TargetOverrides>(TARGET_OVERRIDES_KEY, {}),
  );

  /** 第一步：只发现仓库（秒回，无 git 子进程）。 */
  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    setError("");
    const collected: ProjectRepos[] = [];
    for (const project of projects) {
      try {
        const repos = await invoke<PendingBranchRepoRef[]>("list_branch_pr_repos", {
          projectPath: project.path,
        });
        collected.push({ project, repos, error: "" });
      } catch (e) {
        // 单个项目失败不应让整个视图失败——如实收集原因，其余项目照常展示。
        collected.push({ project, repos: [], error: String(e) });
      }
    }
    setProjectRepos(collected);
    setReposLoading(false);
  }, [projects]);

  const projectPaths = useMemo(() => projects.map((p) => p.path).join("\u0000"), [projects]);

  useEffect(() => {
    void loadRepos();
    // 只跟项目集合绑定；仓库发现本身很轻，不需要额外节流。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPaths]);

  useEffect(() => {
    save(MINE_ONLY_KEY, mineOnly);
  }, [mineOnly]);

  useEffect(() => {
    save(TARGET_OVERRIDES_KEY, overrides);
  }, [overrides]);

  /**
   * 第二步：扫选中仓库的分支。
   *
   * `repo` 为空时按「仓库名」逐个项目扫描（同一仓库名可能出现在多个项目下）；
   * 指定仓库名时只扫那一个——这就是分段加载省下的时间。
   */
  const loadBranches = useCallback(
    async (repo: string, showSpinner: boolean, currentOverrides: TargetOverrides) => {
      if (showSpinner) setScanning(true);
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
      const overridesArg = Object.keys(overridesByBranch).length > 0 ? overridesByBranch : null;
      for (const project of projects) {
        try {
          const list = await invoke<PendingBranchRepoScan[]>("list_branch_pr_candidates", {
            projectPath: project.path,
            repoFilter: repo || null,
            targetOverrides: overridesArg,
          });
          for (const scan of list) collected.push({ ...scan, projectPath: project.path });
        } catch (e) {
          failures.push(`${project.name}：${e}`);
        }
      }
      setScans(collected);
      setError(failures.join("；"));
      if (showSpinner) setScanning(false);
    },
    [projects],
  );

  /** 仓库下拉的选项：来自发现阶段，与是否已扫描无关（切换后不会丢选项）。 */
  const repoOptions = useMemo(() => {
    const names = new Set<string>();
    for (const entry of projectRepos) {
      for (const repo of entry.repos) names.add(repo.name);
    }
    const options = [{ value: ALL_REPOS, label: "全部仓库" }];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      options.push({ value: name, label: name });
    }
    return options;
  }, [projectRepos]);

  /**
   * 行内「目标分支」下拉的选项：各仓库出现过的分支名。
   *
   * 受保护分支带标识——用户不该把目标分支误选成普通功能分支。
   */
  const targetOptions = useMemo(() => {
    // 按小写归并：同一个分支在仓库间大小写可能不一致（实测 `feature/Develop/…` 推断出
    // `Develop`，而 `develop` 才是真实远端分支名）。不归并的话目标分支可能落不进选项列表，
    // Radix Select 找不到匹配项就会把值渲染成空白。
    const names = new Map<string, { canonical: string; protectedBranch: boolean }>();
    const put = (name: string, protectedBranch: boolean) => {
      const key = name.toLowerCase();
      const existing = names.get(key);
      if (!existing) {
        names.set(key, { canonical: name, protectedBranch });
        return;
      }
      existing.protectedBranch ||= protectedBranch;
    };
    for (const scan of scans) {
      for (const branch of scan.branches) {
        put(branch.branch, branch.protected);
        // 当前生效的目标分支也要进选项：它是后端推断/覆盖的结果，未必出现在本地分支列表里。
        put(branch.targetBranch, branch.protected);
      }
    }
    for (const fallback of ["develop", "master", "main"]) put(fallback, true);

    // 选项一律只显示纯分支名（不挂 ◎ 之类的圆点）：受保护与否由选中项旁边那个
    // 「受保护」徽标表达，选项文字保持干净。
    return [...names.values()]
      .sort((a, b) => a.canonical.localeCompare(b.canonical))
      .map(({ canonical }) => ({ value: canonical, label: canonical }));
  }, [scans]);

  /** 受保护的目标分支名集合（小写），供卡片在选中项旁显示「受保护」徽标。 */
  const protectedTargets = useMemo(() => {
    const set = new Set<string>();
    for (const scan of scans) {
      for (const branch of scan.branches) {
        if (branch.protected) set.add(branch.branch.toLowerCase());
      }
    }
    for (const fallback of ["develop", "master", "main"]) set.add(fallback);
    return set;
  }, [scans]);

  /** 目标分支值 → 选项里的真实大小写：避免 `Develop` / `develop` 这类差异把下拉渲染成空白。 */
  const canonicalTarget = useMemo(() => {
    const byLower = new Map(targetOptions.map((o) => [o.value.toLowerCase(), o.value]));
    return (value: string) => byLower.get(value.toLowerCase()) ?? value;
  }, [targetOptions]);

  const mrOk = useMemo(() => scans.some((scan) => scan.mrOk), [scans]);
  const mrMissing = useMemo(() => scans.filter((scan) => !scan.mrOk), [scans]);
  /** 卡片上的「无 MR」徽标按**该分支所属仓库**的 MR 数据可用性判定。 */
  const mrOkByRepo = useMemo(() => new Map(scans.map((scan) => [scan.path, scan.mrOk])), [scans]);
  const failedScans = useMemo(() => scans.filter((scan) => !scan.ok), [scans]);

  // 目标分支的覆盖值由后端应用（它才知道合并状态与可删性怎么算），前端不再二次改写，
  // 否则会把后端标好的 `targetSource: "user"` 覆写成别的来源。
  const visible = useMemo(
    () => sortCandidates(applyFilters(flattenScans(scans), { mineOnly, query })),
    [scans, mineOnly, query],
  );

  const visibleByKey = useMemo(() => new Map(visible.map((b) => [candidateKey(b), b])), [visible]);

  const selectedBranches = useMemo(
    () =>
      [...selected].map((key) => visibleByKey.get(key)).filter(Boolean) as PendingBranchCandidate[],
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
    refresh: () => void loadBranches(repoFilter, false, overrides),
    clearSelection: () => setSelected(new Set()),
    setError,
    setNotice,
  });

  /**
   * 切仓库：清掉上一个仓库的结果，只扫这一个仓库。
   *
   * 切回「全部仓库」时清空列表而不全扫——全扫正是要避免的几十秒等待；视图会提示先选仓库。
   */
  const onRepoChange = useCallback(
    (repo: string) => {
      setRepoFilter(repo);
      setSelected(new Set());
      resetPruneResults();
      setScans([]);
      if (!repo) return;
      void loadBranches(repo, true, overrides);
    },
    [loadBranches, overrides, resetPruneResults],
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
      void loadBranches(repoFilter, false, next);
    },
    [overrides, loadBranches, repoFilter],
  );

  const repoErrors = projectRepos.filter((entry) => entry.error);
  const repoCount = projectRepos.reduce((n, entry) => n + entry.repos.length, 0);
  const hasProjects = projects.length > 0;
  const hasAnything = visible.length > 0;

  return (
    <div style={s.welcomePane}>
      <PendingMrToolbar
        repoFilter={repoFilter}
        repoOptions={repoOptions}
        mineOnly={mineOnly}
        query={query}
        busy={reposLoading || scanning}
        busyLabel={reposLoading ? "发现中…" : "扫描中…"}
        pruneBusy={pruneBusy}
        selectedDeletableCount={selectedDeletable.length}
        onBack={onBack}
        onRepoChange={onRepoChange}
        onToggleMineOnly={() => setMineOnly((v) => !v)}
        onQueryChange={setQuery}
        onRefresh={() =>
          repoFilter ? void loadBranches(repoFilter, true, overrides) : void loadRepos()
        }
        onPrune={() => void startPrune()}
      />

      <PendingMrBanners
        error={error}
        notice={notice}
        mrOk={mrOk}
        mrMissingRepos={mrMissing.map((scan) => scan.name)}
        failedScans={[
          ...repoErrors.map((entry) => ({ name: entry.project.name, message: entry.error })),
          ...failedScans,
        ]}
      />

      <div style={s.bbList} className="pm-list">
        <PendingMrSelectAll
          visibleCount={visible.length}
          deletableCount={selectedDeletable.length}
          allSelected={allVisibleSelected}
          onToggleAll={toggleAll}
        />

        {!hasProjects && <div style={s.bbEmpty}>工作区里还没有项目，先打开一个 Git 仓库。</div>}

        {hasProjects && reposLoading && (
          <div style={s.bbRefreshing}>
            <RefreshCw size={16} className="spin" />
            正在发现仓库…
          </div>
        )}

        {/* 仓库就绪但还没选：提示选择，而不是一次性全扫（那要几十秒）。 */}
        {hasProjects && !reposLoading && !repoFilter && (
          <div style={s.bbEmpty}>
            {repoCount === 0
              ? "工作区里的项目都没有可用的 git 仓库。"
              : `选择上方仓库后加载分支（${repoCount} 个仓库可选）。`}
          </div>
        )}

        {repoFilter && scanning && scans.length === 0 && (
          <div style={s.bbRefreshing}>
            <RefreshCw size={16} className="spin" />
            正在扫描 {repoFilter} 的分支…
          </div>
        )}

        {repoFilter && !scanning && !hasAnything && !error && (
          <div style={s.bbEmpty}>
            {mineOnly
              ? "当前筛选下没有发起合并的分支。可关闭「我的提交」查看同事的分支。"
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
            targetValue={canonicalTarget(branch.targetBranch)}
            targetProtected={protectedTargets.has(branch.targetBranch.toLowerCase())}
            targetSource={targetSourceLabel(branch.targetSource)}
            onToggle={(checked) => toggleRow(branch, checked)}
            onTargetChange={(value) => onTargetChange(branch, value)}
            onPrune={() => void startPrune()}
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
