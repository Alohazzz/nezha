import type {
  PendingBranchCandidate,
  PendingBranchRepoScan,
  PendingMergeState,
  PendingTargetSource,
} from "../../types";

/**
 * 「待发起」视图的纯逻辑：候选判据、排序、筛选、文案映射。
 *
 * 刻意与组件分开，因为这里的规则是**用户可见行为的定义**（哪些分支出现在清单里、按什么
 * 顺序、徽标怎么写），值得直接单测；组件层只做渲染与调用。
 */

/** 徽标色调，对应 `pr-badge[data-tone]` 的语义。 */
export type PendingTone = "neutral" | "accent" | "success" | "danger" | "warning";

export interface PendingBadge {
  text: string;
  tone: PendingTone;
}

/**
 * 列表里展示的分支：候选集 **加上**「已推送、已合并」的分支。
 *
 * 后者不在候选集里（未合并提交数为 0），但正是批量删除要处理的对象——视图同时承载
 * 「发现待发起」与「清理已收尾」两件事，所以两类都要出现，并靠徽标区分。
 *
 * `mrOk = false` 表示平台 MR 数据不可用：此时「无开放 MR」无从判定，**不能**用它把分支
 * 筛掉（会把「凭据失败」静默变成「没有待发起分支」），故该条按未知放行。
 */
export function isVisibleBranch(branch: PendingBranchCandidate, mrOk: boolean): boolean {
  const noOpenMr = branch.openMrId === null || !mrOk;
  if (branch.pushed && branch.unmerged > 0 && noOpenMr) return true;
  return branch.pushed && branch.mergeState === "merged";
}

/**
 * 「待发起」候选判据：`已推送 ∧ 未合并提交 > 0 ∧ 无开放 MR`。
 *
 * 注意「未合并提交 > 0」对**未推送**分支恒不成立（后端对未推送分支不做昂贵计算，
 * 其 `unmerged` 保持 0），因此未推送分支天然被排除，无需单独判断。
 */
export function isPrCandidate(branch: PendingBranchCandidate, mrOk = true): boolean {
  const noOpenMr = branch.openMrId === null || !mrOk;
  return branch.pushed && branch.unmerged > 0 && noOpenMr;
}

/**
 * 该分支能否「发起合并请求」：已推送、还有未合并提交、且没有开放 MR。
 *
 * 与删除门禁正好互斥（可删 = 已完整合并），因此同一套勾选可以同时驱动两个动作——
 * 勾中的行按各自属性分别计入「发起合并(N)」或「删除远端分支(N)」的计数。
 *
 * 平台 MR 数据不可用时（`mrOk = false`）不因此拒绝：用户是明确勾选的，重复发起由后端
 * 的幂等判重兜底；这里只在行上保留「MR 未知」徽标提示。
 */
export function isMrCandidate(branch: PendingBranchCandidate): boolean {
  return branch.pushed && branch.unmerged > 0 && branch.openMrId === null;
}

/** 行内目标分支的生效值：用户覆盖优先，其次后端推断结果。 */
export function effectiveTarget(branch: PendingBranchCandidate, override?: string): string {
  return override && override.trim() !== "" ? override : branch.targetBranch;
}

/**
 * 把一次**增量**扫描结果并回已有扫描（行内改目标分支只重算那一条）。
 *
 * 后端按 `onlyBranches` 只返回被重算的分支，不能整表替换——否则其他仓库/其他分支的行
 * 会被空数组抹掉。这里是按「仓库路径 + 分支名」做 upsert：重算到的行覆盖旧行，其余保留。
 */
export function mergeScans<T extends { path: string; branches: PendingBranchCandidate[] }>(
  prev: T[],
  incoming: T[],
): T[] {
  const byPath = new Map(prev.map((scan) => [scan.path, scan]));
  for (const scan of incoming) {
    const old = byPath.get(scan.path);
    if (!old) {
      byPath.set(scan.path, scan);
      continue;
    }
    const updated = new Map(scan.branches.map((b) => [b.branch, b]));
    const merged = old.branches.map((b) => updated.get(b.branch) ?? b);
    for (const b of scan.branches) {
      if (!old.branches.some((o) => o.branch === b.branch)) merged.push(b);
    }
    byPath.set(scan.path, { ...old, ...scan, branches: merged });
  }
  return [...byPath.values()];
}

/** 候选排序：我的提交优先 → 最近提交时间倒序 → 仓库名 → 分支名（稳定可预期）。 */
export function sortCandidates(
  branches: PendingBranchCandidate[],
): PendingBranchCandidate[] {
  return [...branches].sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    if (a.lastCommitAt !== b.lastCommitAt) return b.lastCommitAt - a.lastCommitAt;
    if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
    return a.branch.localeCompare(b.branch);
  });
}

export interface PendingFilters {
  /** 只看包含本人提交的分支。 */
  mineOnly: boolean;
  /** 分支名搜索（大小写不敏感，空串表示不过滤）。 */
  query: string;
}

/** 应用筛选（在已排序结果上）。 */
export function applyFilters(
  branches: PendingBranchCandidate[],
  filters: PendingFilters,
): PendingBranchCandidate[] {
  const query = filters.query.trim().toLowerCase();
  return branches.filter((branch) => {
    if (filters.mineOnly && !branch.mine) return false;
    if (query && !branch.branch.toLowerCase().includes(query)) return false;
    return true;
  });
}

/**
 * 把各仓库扫描结果摊平成**可展示**的分支数组。
 *
 * 跳过扫描失败的仓库；每个仓库用**自己的** `mrOk` 判可见性——一个仓库的 MR 数据可用，
 * 不能让另一个仓库里「MR 未知」的分支被误判成「无 MR」而漏掉。
 */
export function flattenScans(scans: PendingBranchRepoScan[]): PendingBranchCandidate[] {
  return scans
    .filter((scan) => scan.ok)
    .flatMap((scan) => scan.branches.filter((b) => isVisibleBranch(b, scan.mrOk)));
}

const MERGE_BADGE: Record<PendingMergeState, (b: PendingBranchCandidate) => PendingBadge> = {
  merged: (b) => ({
    text: b.mergedInto ? `已合并进 ${b.mergedInto}` : "已合并",
    tone: "success",
  }),
  partial: () => ({ text: "部分合并", tone: "warning" }),
  unmerged: () => ({ text: "未合并", tone: "neutral" }),
};

/**
 * 行的状态徽标序列（顺序即展示顺序）。
 *
 * 特意把「无 MR」显式画成徽标而不是留空：候选为空时用户需要能区分「没有待发起分支」与
 * 「平台 MR 数据没拉到」。
 */
export function badgesFor(branch: PendingBranchCandidate, mrOk: boolean): PendingBadge[] {
  const badges: PendingBadge[] = [MERGE_BADGE[branch.mergeState](branch)];
  if (branch.openMrId !== null) {
    badges.push({ text: `已有 MR #${branch.openMrId}`, tone: "accent" });
  } else if (mrOk) {
    badges.push({ text: "无 MR", tone: "neutral" });
  } else {
    badges.push({ text: "MR 未知", tone: "warning" });
  }
  if (branch.openMrConflict) badges.push({ text: "有冲突", tone: "danger" });
  if (branch.mine) badges.push({ text: "我的提交", tone: "accent" });
  if (branch.protected) badges.push({ text: "受保护", tone: "neutral" });
  if (branch.remoteOnly) badges.push({ text: "仅远端", tone: "neutral" });
  if (!branch.pushed) badges.push({ text: "未推送", tone: "warning" });
  if (branch.dataMissing) badges.push({ text: "数据缺失", tone: "warning" });
  return badges;
}

/** 目标分支推断来源的说明文案（让用户判断这个默认值该不该信）。 */
export function targetSourceLabel(source: PendingTargetSource): string {
  switch (source) {
    case "user":
      return "手动指定";
    case "config":
      return "项目配置";
    case "name":
      return "按分支名推断";
    default:
      return "默认值";
  }
}

/** 「N 个未合并提交 · 作者 · 时间」这一行的文案。 */
export function commitSummary(branch: PendingBranchCandidate): string {
  const parts: string[] = [];
  parts.push(`${branch.unmerged} 个未合并提交`);
  const author = branch.lastCommitAuthor.trim();
  if (author) parts.push(author);
  const when = relativeTime(branch.lastCommitAt);
  if (when) parts.push(when);
  return parts.join(" · ");
}

/** 相对时间（中文）。无法解析（0）时返回空串，交由调用方跳过。 */
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  if (!unixSeconds) return "";
  const diff = Math.max(0, Math.floor(now / 1000) - unixSeconds);
  if (diff < 60) return "刚刚";
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/** 已选分支的 key（仓库路径 + 分支，跨仓库同名分支也要能区分）。 */
export function candidateKey(branch: PendingBranchCandidate): string {
  return `${branch.repoPath}\u0000${branch.branch}`;
}

/** 构删除请求体的最小定位信息。 */
export function toPruneTarget(branch: PendingBranchCandidate) {
  return {
    repoPath: branch.repoPath,
    repo: branch.repo,
    branch: branch.branch,
    targetBranch: branch.targetBranch,
  };
}
