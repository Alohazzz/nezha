//! 「待发起」视图（欢迎页）——把本地/远端分支元数据与云效平台侧数据 join 起来。
//!
//! 视图回答两个问题：「哪些分支已经推上去、但还没发起合并请求」，以及「哪些远端分支已经
//! 收尾可以删掉」。两侧数据源完全不同：
//!
//! - 本地侧：`git for-each-ref`（分支 + upstream + 作者 + 时间）与逐候选的 `rev-list` /
//!   `merge-base`（未合并提交数、合并三态）。
//! - 平台侧：`codeup` 模块的分支列表（`protected` / `defaultBranch`）与开放 MR 列表，
//!   一次拉全后在内存里按 `sourceBranch` join（**不逐分支查询**）。
//!
//! 平台不可达时按「平台侧数据缺失」降级：受保护判定回落到 git 侧硬编码口径、开放 MR 标记
//! 为「未知」，但**列表本身仍然可用**（`platform_ok` / `mr_ok` 让前端能如实说明）。
//!
//! 删除远端分支是**对外可见且难以撤销**的操作，沿用仓库既有两阶段模式
//! （`build_prune_stale_branches` 的 dry-run 先例）：`dry_run = true` 只扫描并逐条给出
//! 「可删 / 不可删 + 原因」，`false` 才执行；单条失败不中断整批。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::git::{resolve_repo_path, run_git, validate_project_path};
use serde::{Deserialize, Serialize};

/// 目标分支的兜底常量（配置与分支名都推断不出来时使用，取仓库里最像主干的那条）。
const FALLBACK_TARGETS: [&str; 3] = ["develop", "master", "main"];

/// 分支名中被视为「目标分支段」的主干名（含 `develop-old` / `master-old` 这类变体）。
fn is_protected_like(name: &str) -> bool {
    let lower = name.to_lowercase();
    let base = lower.split('-').next().unwrap_or("");
    matches!(base, "develop" | "master" | "main")
}

/// 版本段（`v2.20260901` / `v2.20260501.25.1`）——分支名规范里夹在类型与目标之间的那种。
fn is_version_like(segment: &str) -> bool {
    let mut chars = segment.chars();
    matches!(chars.next(), Some('v' | 'V')) && chars.next().is_some_and(|c| c.is_ascii_digit())
}

/// 议题编号段（`QHDK-30392`）——不是分支名。
fn is_issue_like(segment: &str) -> bool {
    let Some((prefix, number)) = segment.split_once('-') else {
        return false;
    };
    !prefix.is_empty()
        && prefix.len() <= 10
        && prefix.chars().all(|c| c.is_ascii_alphabetic())
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

/// 目标分支推断来源，前端据此在小字里标注「这个默认值可不可信」。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetSource {
    /// 用户在行内手动指定的目标分支（优先级最高）。
    User,
    /// 项目配置的默认分支。
    Config,
    /// 分支命名规范中的目标段（如 `hotfix/<版本>/master/<议题>` → master）。
    Name,
    /// 兜底常量。
    Default,
}

/// 合并三态。刻意区分「部分合并」——只报布尔值会让用户误以为分支已收尾。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MergeState {
    /// 有独有提交、源分支不含。
    Unmerged,
    /// 源分支完全包含该分支的提交。
    Merged,
    /// 部分提交已进源分支、仍有提交没进去。
    Partial,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProtectedSource {
    /// 平台侧 `protected` / `defaultBranch` 标志（覆盖面更广）。
    Platform,
    /// 平台不可达时回落 git 侧硬编码口径。
    Git,
}

/// 单个候选分支（或「已收尾待删」分支）的全部可展示信息。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchCandidate {
    pub branch: String,
    /// 仓库显示名（与 `BuildRepo.name` 一致）。
    pub repo: String,
    /// 仓库绝对路径（删除时按仓库回传）。
    pub repo_path: String,
    /// 是否有 upstream（即已推送）。
    pub pushed: bool,
    pub protected: bool,
    pub protected_source: Option<ProtectedSource>,
    /// 相对目标分支的未合并提交数。
    pub unmerged: u64,
    pub merge_state: MergeState,
    /// 已合并时合进了哪条源分支（不只是一个布尔值）。
    pub merged_into: Option<String>,
    pub target_branch: String,
    pub target_source: TargetSource,
    /// 独有提交的作者集合里包含本人 git email。
    pub mine: bool,
    pub authors: Vec<String>,
    pub last_commit_author: String,
    /// 最近提交时间（unix 秒；0 表示解析不到）。
    pub last_commit_at: i64,
    pub additions: u64,
    pub deletions: u64,
    /// 平台侧开放 MR（无则 None）。
    pub open_mr_id: Option<i64>,
    pub open_mr_state: String,
    pub open_mr_conflict: bool,
    /// 是否允许删除远端分支（硬门禁：已完整合并进源分支 且 非受保护 且 已推送）。
    pub deletable: bool,
    /// 不可删除的原因（可删除时为空）。
    pub skip_reason: String,
    /// 该行的部分数据缺失（如 merge-base 失败），需在行上标注。
    pub data_missing: bool,
}

/// 单个仓库的扫描结果。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchRepoScan {
    pub name: String,
    pub path: String,
    /// 该仓库扫描是否成功。
    pub ok: bool,
    /// `ok = false` 时的失败原因。
    pub message: String,
    /// 平台侧分支列表可用（false 表示受保护判定已回落 git 口径）。
    pub platform_ok: bool,
    /// 平台侧开放 MR 数据可用（false 表示「是否有开放 MR」未知，不能据此过滤）。
    pub mr_ok: bool,
    pub branches: Vec<BranchCandidate>,
}

/// 删除请求的最小定位信息：仓库路径 + 分支 + 用户确认的目标分支。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranchTarget {
    pub repo_path: String,
    pub repo: String,
    pub branch: String,
    /// 判定「是否已完整合并」的源分支（用户在行内确认过的那个）。
    pub target_branch: String,
}

/// 删除单项回执。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranchPruneItem {
    pub repo: String,
    pub repo_path: String,
    pub branch: String,
    pub target_branch: String,
    /// 本次是否已删除（dry-run 恒为 false）。
    pub deleted: bool,
    /// 是否满足删除条件。
    pub deletable: bool,
    pub reason: String,
}

/// 项目下一个可扫描的 git 仓库（供分段加载的仓库下拉用）。
///
/// 只带定位信息：视图先秒出仓库列表，用户选中某个仓库后才去读它的分支。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchRepoRef {
    /// 仓库显示名（与 `BuildRepo.name` 一致，也是 `repo_filter` 的匹配键）。
    pub name: String,
    /// 仓库绝对路径。
    pub path: String,
}

// ── git 原语（同步，只在 spawn_blocking 里调用）──────────────────────────────

/// 跑 git 并返回 stdout 行；非零退出把 stderr 作为错误。
fn git_lines(dir: &str, args: &[&str]) -> Result<Vec<String>, String> {
    let out = run_git(dir, args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .collect())
}

/// 跑 git 并返回 trim 后的单行 stdout。
fn git_stdout(dir: &str, args: &[&str]) -> Result<String, String> {
    Ok(git_lines(dir, args)?.join("\n").trim().to_string())
}

/// 本地分支元数据（一次 `for-each-ref` 批量取，避免逐分支起进程）。
struct BranchMeta {
    name: String,
    /// `origin/foo` 形态的 upstream 短名；空 = 未推送。
    upstream: String,
    last_commit_author: String,
    last_commit_at: i64,
}

fn list_local_branches(dir: &str) -> Result<Vec<BranchMeta>, String> {
    let lines = git_lines(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(upstream:short)\t%(authorname)\t%(committerdate:unix)",
            "refs/heads",
        ],
    )?;
    let mut out = Vec::new();
    for line in lines {
        let mut parts = line.split('\t');
        let Some(name) = parts.next() else { continue };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        out.push(BranchMeta {
            name: name.to_string(),
            upstream: parts.next().unwrap_or("").trim().to_string(),
            last_commit_author: parts.next().unwrap_or("").trim().to_string(),
            last_commit_at: parts.next().unwrap_or("").trim().parse::<i64>().unwrap_or(0),
        });
    }
    Ok(out)
}

/// 当前仓库的 git 身份 email（「我的提交」判据）。
fn current_user_email(dir: &str) -> String {
    git_stdout(dir, &["config", "user.email"])
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

/// `from..to` 的提交数。
fn rev_count(dir: &str, from: &str, to: &str) -> Result<u64, String> {
    let range = format!("{from}..{to}");
    let raw = git_stdout(dir, &["rev-list", "--count", &range])?;
    raw.parse::<u64>()
        .map_err(|e| format!("解析提交数失败（{range}）: {e}"))
}

/// 独有提交里「补丁等价物已存在于上游」的条数（`git cherry` 的 `-` 行）。
///
/// 判定「部分合并」只能走补丁等价：squash / cherry-pick 会在上游造出**新 hash**，
/// 单看提交计数两条方向都数不到，`merge-base` 也不会前移。`git cherry` 逐提交比 patch-id，
/// 上游已有等价改动即输出 `-`。
///
/// 只在独有提交数不大时调用：该命令对每个提交算 patch-id，上千提交的长分支会明显变慢，
/// 而这种分支本来也不可能是「已收尾待删」的部分合并分支。超出上限返回 `None`（按未合并处理）。
fn cherry_contained(dir: &str, upstream: &str, head: &str, unique: u64) -> Option<u64> {
    const MAX_CHERRY_COMMITS: u64 = 500;
    if unique == 0 || unique > MAX_CHERRY_COMMITS {
        return None;
    }
    let lines = git_lines(dir, &["cherry", upstream, head]).ok()?;
    Some(lines.iter().filter(|l| l.starts_with('-')).count() as u64)
}

/// `a...b` 的左/右独有提交数（左 = a 独有，右 = b 独有）。
fn left_right_count(dir: &str, a: &str, b: &str) -> Result<(u64, u64), String> {
    let range = format!("{a}...{b}");
    let raw = git_stdout(dir, &["rev-list", "--left-right", "--count", &range])?;
    let mut it = raw.split_whitespace();
    let left = it
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| format!("解析 {range} 左侧计数失败"))?;
    let right = it
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| format!("解析 {range} 右侧计数失败"))?;
    Ok((left, right))
}

fn merge_base(dir: &str, a: &str, b: &str) -> Option<String> {
    let raw = git_stdout(dir, &["merge-base", a, b]).ok()?;
    let head = raw.lines().next().unwrap_or("").trim().to_string();
    if head.is_empty() {
        None
    } else {
        Some(head)
    }
}

/// 某区间的提交作者 email 集合（去重、小写）。
fn range_authors(dir: &str, from: &str, to: &str) -> Result<Vec<String>, String> {
    let range = format!("{from}..{to}");
    let lines = git_lines(dir, &["log", "--format=%aE", &range])?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for line in lines {
        let email = line.trim().to_lowercase();
        if !email.is_empty() && seen.insert(email.clone()) {
            out.push(email);
        }
    }
    Ok(out)
}

/// 区间 diff 的（新增行, 删除行）。用 `--numstat` 而不是 `--shortstat`：后者是本地化文案，
/// 非英文 locale 下解析会直接失败。
fn diff_line_stats(dir: &str, from: &str, to: &str) -> Result<(u64, u64), String> {
    let out = run_git(dir, &["diff", "--numstat", from, to])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut added = 0u64;
    let mut deleted = 0u64;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split('\t');
        let (Some(a), Some(d)) = (it.next(), it.next()) else {
            continue;
        };
        // 二进制文件的 numstat 是 `-`。
        added += a.trim().parse::<u64>().unwrap_or(0);
        deleted += d.trim().parse::<u64>().unwrap_or(0);
    }
    Ok((added, deleted))
}

fn ref_exists(dir: &str, reference: &str) -> bool {
    matches!(
        run_git(dir, &["rev-parse", "--verify", "--quiet", reference]),
        Ok(out) if out.status.success()
    )
}

/// 远端是否确实存在该分支（live `ls-remote`，不用陈旧的 remote-tracking ref）。
fn remote_branch_exists(dir: &str, branch: &str) -> Result<bool, String> {
    let out = run_git(
        dir,
        &["ls-remote", "--heads", "origin", &format!("refs/heads/{branch}")],
    )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(!String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

/// 远端全部分支名（一次 `ls-remote --heads origin`）。`None` = 查询失败（离线 / 无 origin
/// / 凭据失效），调用方回落本地 upstream 口径——网络问题不能让整张列表静默消失。
///
/// `core.quotepath=false`：非 ASCII 分支名（本项目用户普遍用中文分支）不得被转成八进制
/// 转义，否则 `refs/heads/` 前缀匹配会整体漏掉它们。
fn list_remote_heads(dir: &str) -> Option<HashSet<String>> {
    let out = run_git(
        dir,
        &["-c", "core.quotepath=false", "ls-remote", "--heads", "origin"],
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut heads = HashSet::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // 行格式：<sha>\t<refname>；refname 不含空白，按 tab 拆即可。
        if let Some(refname) = line.split('\t').nth(1) {
            if let Some(name) = refname.strip_prefix("refs/heads/") {
                heads.insert(name.to_string());
            }
        }
    }
    Some(heads)
}

/// git 错误是否表明「远端这个 ref 已经不存在」——幂等删除的成功信号。
///
/// 覆盖两类现场：`push --delete` 的 `remote ref does not exist`（exists 检查通过后、
/// 执行前分支被平台合并自动删除 / 他人删除 / 读写副本滞后），与 fetch 的
/// `couldn't find remote ref`（同一窗口的更早阶段）。删除的**目标状态**是
/// 「远端没有这个分支」，错误本身证明目标已达成，不得回执成失败。
fn stderr_says_remote_ref_missing(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("remote ref does not exist") || s.contains("couldn't find remote ref")
}

/// 该分支是否已被源分支**完整**包含（远端视角：`origin/target..origin/branch` 为空）。
fn remote_fully_merged(dir: &str, target: &str, branch: &str) -> Result<bool, String> {
    let target_ref = format!("origin/{target}");
    let branch_ref = format!("origin/{branch}");
    if !ref_exists(dir, &target_ref) {
        return Err(format!("远端不存在源分支 {target}"));
    }
    if !ref_exists(dir, &branch_ref) {
        return Err(format!("远端不存在分支 {branch}"));
    }
    Ok(rev_count(dir, &target_ref, &branch_ref)? == 0)
}

// ── 目标分支推断 ─────────────────────────────────────────────────────────────

/// 目标分支推断（纯函数，便于单测）：
/// ① 用户手动指定；② 项目配置的默认分支；③ 分支命名规范中的目标段；④ 兜底常量。
///
/// **明确否决 merge-base 距离推断**：实测 `fetarue/v2.20260501.25.1/…` 到 develop 与 master
/// 的距离几乎相同（fork 点过旧），无法区分。该法只在删除门禁里做精确判定，不用于猜目标。
fn infer_target_branch(
    branch: &str,
    config_default: &str,
    known_branches: &HashSet<String>,
    user_override: Option<&str>,
) -> (String, TargetSource) {
    if let Some(target) = user_override.map(str::trim).filter(|t| !t.is_empty()) {
        return (target.to_string(), TargetSource::User);
    }

    let configured = config_default.trim();
    if !configured.is_empty() {
        return (configured.to_string(), TargetSource::Config);
    }

    // 命名规范：<type>/<版本>[/<目标分支>]/<议题编号>-<描述>。
    // 逐段找第一个「像目标分支」的段——不假定它固定在第 3 段，因为
    // `feature/develop/消息嵌入` 的目标段在第 2 段。
    for segment in branch.split('/').map(str::trim).skip(1) {
        if segment.is_empty()
            || is_version_like(segment)
            || is_issue_like(segment)
            || segment == branch
        {
            continue;
        }
        if is_protected_like(segment) || known_branches.contains(segment) {
            return (segment.to_string(), TargetSource::Name);
        }
    }

    let fallback = FALLBACK_TARGETS
        .iter()
        .find(|name| known_branches.contains(**name))
        .copied()
        .unwrap_or(FALLBACK_TARGETS[0]);
    (fallback.to_string(), TargetSource::Default)
}

// ── 平台侧数据 ───────────────────────────────────────────────────────────────

/// 平台侧单仓库数据（一次拉全后在内存里 join）。
#[derive(Default)]
struct RepoPlatform {
    /// 平台侧受保护 / 默认分支集合。
    protected: HashSet<String>,
    default_branch: Option<String>,
    /// sourceBranch → 开放 MR（同一源分支多条时取 local_id 最大的那条）。
    open_mrs: HashMap<String, crate::codeup::OpenChangeRequest>,
    /// 分支列表是否拿到。
    platform_ok: bool,
    /// 开放 MR 列表是否拿到。
    mr_ok: bool,
}

impl RepoPlatform {
    fn is_protected(&self, branch: &str) -> bool {
        self.protected.contains(branch) || self.default_branch.as_deref() == Some(branch)
    }
}

/// 把本地仓库路径解析成云效仓库 id（同步，必须放在 `spawn_blocking` 里跑）。
///
/// 这里要跑 `git remote get-url`，是进程启动；放在异步运行时上会阻塞 Tauri 主线程。
fn resolve_repository_ids_blocking(
    repo_paths: &[String],
    known: &[crate::codeup::CodeupRepository],
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for path in repo_paths {
        if let Ok(Some((_, id))) = crate::codeup::resolve_codeup_repository_id_blocking(path, known) {
            out.insert(path.clone(), id);
        }
    }
    out
}

/// 单仓库的平台侧原始数据：云效仓库 id + 分支列表（空 = 该仓库不在云效上 / 平台不可达）。
struct RepoPlatformRaw {
    repository_id: String,
    branches: Vec<crate::codeup::CodeupBranchInfo>,
}

/// 拉取若干仓库的平台侧原始数据（`仓库路径 → 原始数据`）。
///
/// 分三段，且**只有中间那段跑 git**，因此单独放进 `spawn_blocking`：
/// 1. 仓库列表（一次网络请求，失败即整体降级为空）；
/// 2. 仓库 id 解析（要跑 `git remote get-url`，进程启动 → `spawn_blocking`）；
/// 3. 逐仓库分支列表（网络）。
///
/// 平台侧数据是「尽力而为」的辅助信息，任何一段失败都只降级，不让整张列表失败。
async fn fetch_platform_raw(repo_paths: &[String]) -> HashMap<String, RepoPlatformRaw> {
    let known_repos = crate::codeup::fetch_codeup_repositories()
        .await
        .unwrap_or_default();
    if known_repos.is_empty() {
        return HashMap::new();
    }
    let paths = repo_paths.to_vec();
    let ids = match tauri::async_runtime::spawn_blocking(move || {
        resolve_repository_ids_blocking(&paths, &known_repos)
    })
    .await
    {
        Ok(map) => map,
        Err(_) => return HashMap::new(),
    };

    let mut out = HashMap::new();
    for (path, repository_id) in ids {
        let branches = crate::codeup::fetch_codeup_branches(&repository_id)
            .await
            .unwrap_or_default();
        out.insert(
            path,
            RepoPlatformRaw {
                repository_id,
                branches,
            },
        );
    }
    out
}

/// 拉取全部仓库的平台侧数据（尽力而为，失败即降级）。
///
/// 开放 MR 列表**只拉一次**，再按 `repositoryId` 分发到各仓库；逐分支查询被明确否决。
async fn fetch_platform_data(repos: &[(String, String)]) -> HashMap<String, RepoPlatform> {
    let open_mrs = crate::codeup::fetch_open_change_requests().await;
    let (open_mrs, mr_ok) = match open_mrs {
        Ok(list) => (list, true),
        Err(e) => {
            // 凭据 / 网络失败不能让列表失败，但要如实标记「MR 数据未知」。
            eprintln!("[pending-mr] 云效开放 MR 列表不可用，按未知降级：{e}");
            (Vec::new(), false)
        }
    };

    let paths: Vec<String> = repos.iter().map(|(_, path)| path.clone()).collect();
    let raw = fetch_platform_raw(&paths).await;

    let mut out: HashMap<String, RepoPlatform> = HashMap::new();
    for (_, path) in repos {
        let mut data = RepoPlatform {
            mr_ok,
            ..Default::default()
        };
        // 仓库不在云效上（本地独有仓库）时保持 platform_ok = false。
        let Some(entry) = raw.get(path) else {
            out.insert(path.clone(), data);
            continue;
        };
        if !entry.branches.is_empty() {
            data.platform_ok = true;
        }
        for b in &entry.branches {
            if b.is_protected {
                data.protected.insert(b.name.clone());
            }
            if b.is_default {
                data.default_branch = Some(b.name.clone());
            }
        }
        for mr in &open_mrs {
            if mr.repository_id != entry.repository_id {
                continue;
            }
            data.open_mrs
                .entry(mr.source_branch.clone())
                .and_modify(|existing| {
                    if mr.local_id > existing.local_id {
                        *existing = mr.clone();
                    }
                })
                .or_insert_with(|| mr.clone());
        }
        out.insert(path.clone(), data);
    }
    out
}

// ── 单分支评估 ───────────────────────────────────────────────────────────────

/// 评估一个本地分支，产出可展示的候选行。
///
/// 昂贵计算（未合并计数 / merge-base / 作者 / diff）只对**已推送**的分支做：未推送的分支
/// 既不是「待发起」候选、也不可能删远端分支，标记后即可返回。
#[allow(clippy::too_many_arguments)]
fn evaluate_branch(
    dir: &str,
    repo_name: &str,
    meta: &BranchMeta,
    known_branches: &HashSet<String>,
    config_default: &str,
    user_target: Option<&str>,
    me: &str,
    platform: Option<&RepoPlatform>,
    git_protected: bool,
    remote_heads: Option<&HashSet<String>>,
) -> BranchCandidate {
    let (target_branch, target_source) =
        infer_target_branch(&meta.name, config_default, known_branches, user_target);

    // 「已推送」以远端现状为准：平台「合并后删除源分支」是常态，只看 upstream 配置会把
    // 远端已删的行标成「已合并，可删除」，dry-run 再用 live ls-remote 以「远端已无该分支」
    // 打回——两口径自相矛盾，用户点删除永远进不了确认框（体感：点了没有任何反应）。
    // `remote_heads = None`（ls-remote 失败）时回落 upstream 口径，不因离线藏掉整张列表。
    let has_upstream = !meta.upstream.is_empty();
    let remote_gone = has_upstream
        && remote_heads.is_some_and(|heads| !heads.contains(&meta.name));
    let pushed = has_upstream && !remote_gone;
    let platform_protected = platform.is_some_and(|p| p.is_protected(&meta.name));
    let protected = platform_protected || git_protected;
    // 平台侧分支列表可用时以平台为准；否则如实标注回落来源。
    let protected_source = if platform.is_some_and(|p| p.platform_ok) {
        ProtectedSource::Platform
    } else {
        ProtectedSource::Git
    };
    let open_mr = platform.and_then(|p| p.open_mrs.get(&meta.name).cloned());

    let mut candidate = BranchCandidate {
        branch: meta.name.clone(),
        repo: repo_name.to_string(),
        repo_path: dir.to_string(),
        pushed,
        protected,
        protected_source: if protected { Some(protected_source) } else { None },
        unmerged: 0,
        merge_state: MergeState::Unmerged,
        merged_into: None,
        target_branch: target_branch.clone(),
        target_source,
        mine: false,
        authors: Vec::new(),
        last_commit_author: meta.last_commit_author.clone(),
        last_commit_at: meta.last_commit_at,
        additions: 0,
        deletions: 0,
        open_mr_id: open_mr.as_ref().map(|m| m.local_id),
        open_mr_state: open_mr.as_ref().map(|m| m.state.clone()).unwrap_or_default(),
        open_mr_conflict: open_mr.as_ref().is_some_and(|m| m.has_conflict),
        deletable: false,
        skip_reason: String::new(),
        data_missing: false,
    };

    if !pushed {
        candidate.skip_reason = if remote_gone {
            "远端已无该分支".to_string()
        } else {
            "未推送到远端（无 upstream），不能删除远端分支".to_string()
        };
        return candidate;
    }

    let target_ref = format!("origin/{target_branch}");
    if !ref_exists(dir, &target_ref) {
        candidate.data_missing = true;
        candidate.skip_reason = format!("远端不存在目标分支 {target_branch}，无法判定合并状态");
        return candidate;
    }

    // 未合并提交数 + 「完全合并」判定：一次 --left-right 拿右侧独有数即可。
    let unmerged = match left_right_count(dir, &target_ref, &meta.name) {
        Ok((_target_only, branch_only)) => branch_only,
        Err(e) => {
            candidate.data_missing = true;
            candidate.skip_reason = format!("读取未合并提交失败：{e}");
            return candidate;
        }
    };
    candidate.unmerged = unmerged;

    if unmerged == 0 {
        candidate.merge_state = MergeState::Merged;
        // 已合并时「合进了哪条分支」就是被判定为源分支的那条。
        candidate.merged_into = Some(target_branch.clone());
        // 已合并时 diff 计量仍按 merge-base 基线给出（该分支自身带来的改动量）。
        if let Some(fork) = merge_base(dir, &target_ref, &meta.name) {
            if let Ok((added, deleted)) = diff_line_stats(dir, &fork, &meta.name) {
                candidate.additions = added;
                candidate.deletions = deleted;
            }
        }
    } else {
        // 还有独有提交 —— 再看其中是否已有补丁等价物进了源分支（部分合并）。
        candidate.merge_state = match cherry_contained(dir, &target_ref, &meta.name, unmerged) {
            Some(contained) if contained > 0 => MergeState::Partial,
            _ => MergeState::Unmerged,
        };
        if let Some(fork) = merge_base(dir, &target_ref, &meta.name) {
            if let Ok((added, deleted)) = diff_line_stats(dir, &fork, &meta.name) {
                candidate.additions = added;
                candidate.deletions = deleted;
            }
        } else {
            candidate.data_missing = true;
        }
    }

    // 「我的提交」判针对**已合并**的分支同样要算：默认「我的提交」筛选下，
    // 已收尾待删的分支也要留在列表里，否则用户永远看不到可删项。
    if let Ok(authors) = range_authors(dir, &target_ref, &meta.name) {
        candidate.mine = !me.is_empty() && authors.iter().any(|a| a == me);
        candidate.authors = authors;
    }

    // 硬门禁：只有「已完整合并进源分支」的远端分支才允许删除。
    candidate.deletable = match candidate.merge_state {
        MergeState::Merged => true,
        MergeState::Partial => {
            candidate.skip_reason = format!("部分提交未合进 {target_branch}，未完成合并，不可删除");
            false
        }
        MergeState::Unmerged => {
            candidate.skip_reason = format!("未完成合并进 {target_branch}，不可删除");
            false
        }
    };
    if candidate.deletable && protected {
        candidate.deletable = false;
        candidate.skip_reason = "受保护分支，不可删除".to_string();
    }
    candidate
}

// ── 扫描 ─────────────────────────────────────────────────────────────────────

/// 列出项目下可用的 git 仓库（**只做发现，不读分支**）。
///
/// 与逐分支扫描分开，是为了让视图能先秒出仓库下拉、用户选中后再扫码分支：一次性扫描全部
/// 仓库要几十秒（每个候选分支都要跑 rev-list / merge-base / cherry / diff，外加 fetch），
/// 首屏会像卡住一样。发现阶段只做文件系统判断，无 git 子进程。
///
/// 过滤掉不是工作树根的目录：`discover_repos_blocking` 把「目录存在」当作子模块可用，而未
/// 初始化的子模块只留下空目录，此时 `git -C <dir>` 会向上找到父仓库（实测 `HIS/Nto.Pacs`
/// 解析到 `HIS`），把父仓库的分支原样重复一遍。
///
/// 项目里没有可用仓库返回空列表而非错误：「不适用」不是故障，错误条要留给真正的失败
/// （路径非法、git 失败、平台凭据失效），否则注册了非 git 目录的项目每次打开都刷一条红条。
fn discover_repo_refs_blocking(project_path: &str) -> Result<Vec<BranchRepoRef>, String> {
    validate_project_path(project_path)?;
    let root = Path::new(project_path);
    let mut out: Vec<BranchRepoRef> = Vec::new();

    // 主仓库：项目根自身是 git 仓库时，仓库名与 `BuildRepo.name` 一致（目录名）。
    if root.join(".git").exists() {
        let name = root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "root".to_string());
        out.push(BranchRepoRef {
            name,
            path: project_path.to_string(),
        });
    }

    let gitmodules = root.join(".gitmodules");
    if gitmodules.exists() {
        let content = std::fs::read_to_string(&gitmodules).unwrap_or_default();
        for (name, rel, _) in crate::build::parse_gitmodules(&content) {
            let full = root.join(&rel);
            // 未初始化的子模块只有空目录，不是工作树根，排除。
            if full.join(".git").exists() {
                out.push(BranchRepoRef {
                    name,
                    path: crate::git::path_to_string(&full)?,
                });
            }
        }
    }
    Ok(out)
}

/// 扫描单仓库的本地分支（同步；在 `spawn_blocking` 里跑）。
///
/// `overrides`：用户在行内手动指定的目标分支（`分支名 → 目标分支`）。这些值优先级最高，
/// 且**会参与所有判定**（未合并数、合并三态、可删性），保证徽标与「N 项可删」计数始终
/// 与用户看到的目标分支一致——否则改完目标分支后，行上仍显示按旧目标算出的合并状态。
///
/// `only_branches`：只评估这些分支（`None` = 全部）。行内改目标分支时前端会带上被改的那一条，
/// 把「一次切换 = 全仓库上百个 git 子进程」收敛成一个分支的固定开销。`known_branches` 仍取
/// 全量——目标分支推断要靠它判断某个命名段是不是真实分支。
fn scan_repo_blocking(
    repo_name: &str,
    repo_path: &str,
    config_default: &str,
    overrides: &HashMap<String, String>,
    platform: Option<&RepoPlatform>,
    only_branches: Option<&HashSet<String>>,
) -> BranchRepoScan {
    let mut scan = BranchRepoScan {
        name: repo_name.to_string(),
        path: repo_path.to_string(),
        ok: true,
        message: String::new(),
        platform_ok: platform.is_some_and(|p| p.platform_ok),
        mr_ok: platform.is_some_and(|p| p.mr_ok),
        branches: Vec::new(),
    };

    let branches = match list_local_branches(repo_path) {
        Ok(b) => b,
        Err(e) => {
            scan.ok = false;
            scan.message = format!("读取分支列表失败：{e}");
            return scan;
        }
    };
    if branches.is_empty() {
        return scan;
    }
    let known_branches: HashSet<String> = branches.iter().map(|b| b.name.clone()).collect();
    let branches: Vec<BranchMeta> = match only_branches {
        Some(only) => branches
            .into_iter()
            .filter(|b| only.contains(&b.name))
            .collect(),
        None => branches,
    };
    if branches.is_empty() {
        return scan;
    }

    // 目标分支可能不止一条（用户覆盖 / 配置项 / 命名推断），先把不同的目标各 fetch 一次；
    // 此后所有比较都用 origin/<target>，避免拿陈旧本地 ref 做结论。
    // fetch 失败不致命：该目标可能只存在于本地（如已改名的 backbone）。
    let mut targets: Vec<String> = branches
        .iter()
        .map(|b| {
            infer_target_branch(
                &b.name,
                config_default,
                &known_branches,
                overrides.get(&b.name).map(String::as_str),
            )
            .0
        })
        .collect();
    targets.sort();
    targets.dedup();
    for target in &targets {
        let _ = run_git(repo_path, &["fetch", "origin", target.as_str()]);
    }

    // 远端现有分支全量列表（一次 ls-remote，按仓库取）：「已推送 / 可删」的判定必须与
    // 删除 dry-run 的 live 检查同源。查询失败返回 None，逐行回落 upstream 配置口径。
    let remote_heads = list_remote_heads(repo_path);

    let me = current_user_email(repo_path);
    for meta in &branches {
        let candidate = evaluate_branch(
            repo_path,
            repo_name,
            meta,
            &known_branches,
            config_default,
            overrides.get(&meta.name).map(String::as_str),
            &me,
            platform,
            crate::build::is_protected_branch(&meta.name, config_default),
            remote_heads.as_ref(),
        );
        scan.branches.push(candidate);
    }
    scan
}

/// 列出项目下可用的 git 仓库（只做发现，不读分支）。
///
/// 「发起合并」视图用它做**分段加载的第一步**：先拿到仓库下拉，用户选中某个仓库后再调用
/// `list_branch_pr_candidates` 只扫那一个仓库。
#[tauri::command]
pub async fn list_branch_pr_repos(project_path: String) -> Result<Vec<BranchRepoRef>, String> {
    tauri::async_runtime::spawn_blocking(move || discover_repo_refs_blocking(&project_path))
        .await
        .map_err(|e| format!("list_branch_pr_repos panicked: {e}"))?
}

/// 「待发起」视图的只读聚合命令：本地分支元数据 + 平台侧 join。
///
/// 除必要的 `fetch` 外不做任何写操作。`repo_filter` 为仓库名（与 `BuildRepo.name` 一致）；
/// `target_overrides` 是用户手动指定的目标分支（`分支名 → 目标分支`），参与全部判定，
/// 保证徽标与可删计数和用户看到的目标分支一致。
#[tauri::command]
pub async fn list_branch_pr_candidates(
    project_path: String,
    repo_filter: Option<String>,
    target_overrides: Option<HashMap<String, String>>,
    only_branches: Option<Vec<String>>,
) -> Result<Vec<BranchRepoScan>, String> {
    let repos = {
        let project_path = project_path.clone();
        tauri::async_runtime::spawn_blocking(move || discover_repo_refs_blocking(&project_path))
            .await
            .map_err(|e| format!("list_branch_pr_candidates panicked: {e}"))??
    };

    let filter = repo_filter.map(|f| f.trim().to_string()).unwrap_or_default();
    let repos: Vec<(String, String)> = repos
        .into_iter()
        .filter(|r| filter.is_empty() || filter == r.name)
        .map(|r| (r.name, r.path))
        .collect();
    if repos.is_empty() {
        return Ok(Vec::new());
    }

    // 平台侧数据在异步层取（网络 IO），再交给 blocking 扫描做纯 git 工作。
    let platforms = fetch_platform_data(&repos).await;

    let overrides = target_overrides.unwrap_or_default();
    // 只评估指定分支（行内改目标分支时用）：空 Vec 视为「没指定」而不是「评估零个分支」，
    // 否则前端传空数组会把整个列表清空。
    let only: Option<HashSet<String>> = only_branches
        .filter(|v| !v.is_empty())
        .map(|v| v.into_iter().collect());
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<BranchRepoScan>, String> {
        // 默认目标分支只在项目配置里（可空）。
        let config_default = crate::config::read_project_config(project_path)
            .map(|c| c.build.default_branch)
            .unwrap_or_default();
        Ok(repos
            .iter()
            .map(|(name, path)| {
                scan_repo_blocking(
                    name,
                    path,
                    &config_default,
                    &overrides,
                    platforms.get(path),
                    only.as_ref(),
                )
            })
            .collect())
    })
    .await
    .map_err(|e| format!("list_branch_pr_candidates panicked: {e}"))?
}

// ── 删除远端分支 ─────────────────────────────────────────────────────────────

/// 单条远端分支删除的判定 + 执行。
///
/// `platform_protected`：平台侧受保护集合（`None` = 平台不可用，回落 git 口径）。
/// `config_default`：项目配置的默认分支，回落口径与扫描侧同源。
fn prune_remote_item_blocking(
    item: &RemoteBranchTarget,
    dry_run: bool,
    platform_protected: Option<&HashSet<String>>,
    config_default: &str,
) -> RemoteBranchPruneItem {
    let mut out = RemoteBranchPruneItem {
        repo: item.repo.clone(),
        repo_path: item.repo_path.clone(),
        branch: item.branch.clone(),
        target_branch: item.target_branch.clone(),
        deleted: false,
        deletable: false,
        reason: String::new(),
    };
    let dir = item.repo_path.as_str();
    let target = item.target_branch.trim();

    if target.is_empty() {
        out.reason = "未指定目标分支，无法判定是否已合并".to_string();
        return out;
    }
    // 受保护判定优先用平台口径（覆盖面更广）；平台不可用才回落 git 硬编码口径。
    // **只判待删分支自身**：目标分支（主干）在平台上几乎总是受保护/默认分支，若一并查
    // 集合，所有已合并进主干的特性分支都会被误拒——与扫描侧「已合并，可删除」的口径
    // 自相矛盾。
    let protected = match platform_protected {
        Some(set) => set.contains(&item.branch),
        None => crate::build::is_protected_branch(&item.branch, config_default),
    };
    if protected {
        out.reason = "受保护分支，不可删除".to_string();
        return out;
    }
    // 先确认远端确有该分支（live ls-remote，不用陈旧引用）。
    match remote_branch_exists(dir, &item.branch) {
        Ok(true) => {}
        Ok(false) => {
            if dry_run {
                out.reason = "远端已无该分支".to_string();
            } else {
                // 执行阶段才发现分支已不在远端：先前已删（平台 / 他人 / 上一次点击），
                // 删除目标已达成——按成功回执，避免红色「删除失败」。
                out.deletable = true;
                out.deleted = true;
                out.reason = "远端已无该分支，删除目标已达成（分支可能已被平台或他人删除）".to_string();
            }
            return out;
        }
        Err(e) => {
            out.reason = format!("查询远端分支失败：{e}");
            return out;
        }
    }
    // 再把源分支与**待删分支自身**的远端跟踪引用都刷新一遍：只看 origin/<target>
    // 是不够的——origin/<branch> 若停在旧 tip，会把「其实还有未合并提交」的分支误判成
    // 已完整合并而放行删除。
    for reference in [target, item.branch.as_str()] {
        match run_git(dir, &["fetch", "origin", reference]) {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                // 拉取待删分支时发现远端已无该 ref：exists 检查与 fetch 之间的窗口被删，
                // 与 exists=false 同语义（目标达成）；拉取目标分支失败仍是数据问题。
                if reference == item.branch && stderr_says_remote_ref_missing(&stderr) {
                    if dry_run {
                        out.reason = "远端已无该分支".to_string();
                    } else {
                        out.deletable = true;
                        out.deleted = true;
                        out.reason =
                            "远端已无该分支，删除目标已达成（分支可能已被平台或他人删除）".to_string();
                    }
                    return out;
                }
                out.reason = format!("拉取 {reference} 失败：{}", stderr.trim());
                return out;
            }
            Err(e) => {
                out.reason = format!("拉取 {reference} 失败：{e}");
                return out;
            }
        }
    }
    match remote_fully_merged(dir, target, &item.branch) {
        Ok(true) => {}
        Ok(false) => {
            out.reason = format!("未完成合并进 {target}，已拒绝删除");
            return out;
        }
        Err(e) => {
            out.reason = format!("判定合并状态失败：{e}");
            return out;
        }
    }

    out.deletable = true;
    if dry_run {
        out.reason = format!("已完整合入 origin/{target}");
        return out;
    }
    // 只删远端分支，**不删本地分支**——删本地会破坏其他任务打开的工作区。
    match run_git(dir, &["push", "origin", "--delete", &item.branch]) {
        Ok(o) if o.status.success() => {
            out.deleted = true;
            out.reason = format!("已删除远端分支（已完整合入 origin/{target}）");
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            // push --delete 报 ref 不存在：exists / fetch 都过了之后分支才被删
            // （平台合并自动删除、他人先删、读写副本滞后）。目标状态「远端无此分支」
            // 已由错误本身证明——幂等成功，不得回执成失败。
            if stderr_says_remote_ref_missing(&stderr) {
                out.deleted = true;
                out.reason =
                    "远端已无该分支，删除目标已达成（分支可能已被平台或他人删除）".to_string();
            } else {
                out.reason = format!("删除失败：{}", stderr.trim());
            }
        }
        Err(e) => out.reason = format!("删除失败：{e}"),
    }
    out
}

/// 取各仓库的平台侧受保护分支集合（尽力而为；`None` = 平台不可用 / 仓库不在云效上）。
///
/// 复用 [`fetch_platform_raw`]：仓库列表拉一次、id 解析走 `spawn_blocking`、
/// 分支列表逐仓库拉一次，不逐条删除项重复请求。
async fn fetch_protected_sets(repo_paths: &[String]) -> HashMap<String, Option<HashSet<String>>> {
    let raw = fetch_platform_raw(repo_paths).await;
    let mut out = HashMap::new();
    for repo_path in repo_paths {
        let set = raw.get(repo_path).and_then(|entry| {
            if entry.branches.is_empty() {
                return None;
            }
            Some(
                entry
                    .branches
                    .iter()
                    .filter(|b| b.is_protected || b.is_default)
                    .map(|b| b.name.clone())
                    .collect::<HashSet<String>>(),
            )
        });
        out.insert(repo_path.clone(), set);
    }
    out
}

/// 批量删除远端分支（两阶段：先 dry-run 扫描，再执行）。
///
/// **不得**提供「一步到位」的删除入口——dry-run 先例见 `build_prune_stale_branches`。
#[tauri::command]
pub async fn prune_remote_branches(
    project_path: String,
    items: Vec<RemoteBranchTarget>,
    dry_run: bool,
) -> Result<Vec<RemoteBranchPruneItem>, String> {
    validate_project_path(&project_path)?;
    // 每个仓库路径都必须落在项目内，拒绝越界路径（在产生任何副作用之前校验）。
    for item in &items {
        resolve_repo_path(&project_path, Some(&item.repo_path)).await?;
    }

    // 平台侧受保护集合按仓库缓存一次，避免逐条重复请求。
    let repo_paths: Vec<String> = items
        .iter()
        .map(|i| i.repo_path.clone())
        .collect();
    let protection = fetch_protected_sets(&repo_paths).await;
    // 回落 git 口径时的默认分支与扫描侧同源（项目配置），保证两侧判定一致。
    let config_default = crate::config::read_project_config(project_path.clone())
        .map(|c| c.build.default_branch)
        .unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        Ok(items
            .iter()
            .map(|item| {
                prune_remote_item_blocking(
                    item,
                    dry_run,
                    protection.get(&item.repo_path).and_then(|s| s.as_ref()),
                    &config_default,
                )
            })
            .collect())
    })
    .await
    .map_err(|e| format!("prune_remote_branches panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    /// 测试夹具的绝对基路径。
    ///
    /// 不能直接用 `std::env::temp_dir()`：它读 `TEMP`/`TMP`，在 Git Bash 下会拿到 `/tmp`
    /// 这类非 Windows 绝对路径，被 `validate_project_path` 拒绝；而 `canonicalize()` 又会
    /// 产出 `\\?\` verbatim 前缀，git 把它当远端 URL 时直接报「hostname contains invalid
    /// characters」。两者都是环境相关的坑，故固定落在 `target/`（已 gitignore）下。
    fn temp_base() -> PathBuf {
        let base = std::env::current_dir()
            .expect("current dir")
            .join("target")
            .join("pending-mr-tests");
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    struct TempRepo {
        path: PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            let path = temp_base().join(format!("nezha-pending-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            let out = Command::new("git").arg("init").arg(&path).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            for (k, v) in [("user.email", "me@test.test"), ("user.name", "me")] {
                let o = Command::new("git")
                    .arg("-C")
                    .arg(&path)
                    .args(["config", k, v])
                    .output()
                    .unwrap();
                assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            }
            Self { path }
        }

        fn dir(&self) -> &str {
            self.path.to_str().unwrap()
        }

        fn git(&self, args: &[&str]) {
            let o = Command::new("git")
                .arg("-C")
                .arg(&self.path)
                .args(args)
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        }

        /// 以指定身份提交（用于「我的提交」多作者场景）。
        fn git_authored(&self, args: &[&str], email: &str, name: &str) {
            let o = Command::new("git")
                .arg("-C")
                .arg(&self.path)
                .args([
                    "-c",
                    &format!("user.email={email}"),
                    "-c",
                    &format!("user.name={name}"),
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        }

        fn stdout(&self, args: &[&str]) -> String {
            let o = Command::new("git")
                .arg("-C")
                .arg(&self.path)
                .args(args)
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    struct TempBareRemote {
        path: PathBuf,
    }

    impl TempBareRemote {
        fn new() -> Self {
            let path =
                temp_base().join(format!("nezha-pending-origin-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            let out = Command::new("git")
                .arg("init")
                .arg("--bare")
                .arg(&path)
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            Self { path }
        }

        fn dir(&self) -> &str {
            self.path.to_str().unwrap()
        }
    }

    impl Drop for TempBareRemote {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// 建好「本地仓库 + bare origin」，主干为 `develop`，并推送。
    fn repo_with_origin() -> (TempRepo, TempBareRemote) {
        let repo = TempRepo::new();
        let origin = TempBareRemote::new();
        std::fs::write(repo.path.join("tracked.txt"), "hello").unwrap();
        repo.git(&["add", "tracked.txt"]);
        repo.git(&["commit", "-m", "init"]);
        repo.git(&["branch", "-m", "develop"]);
        repo.git(&["remote", "add", "origin", origin.dir()]);
        repo.git(&["push", "-u", "origin", "develop"]);
        (repo, origin)
    }

    /// 从 develop 起新建分支并提交一个文件。
    fn write_commit(repo: &TempRepo, branch: &str, file: &str, body: &str) {
        repo.git(&["checkout", "-B", branch, "develop"]);
        std::fs::write(repo.path.join(file), body).unwrap();
        repo.git(&["add", file]);
        repo.git(&["commit", "-m", branch]);
    }

    fn branch_of<'a>(scan: &'a BranchRepoScan, name: &str) -> &'a BranchCandidate {
        scan.branches
            .iter()
            .find(|b| b.branch == name)
            .unwrap_or_else(|| panic!("缺少分支 {name}"))
    }

    /// 平台不可用、无行内覆盖时的扫描（回落 git 侧受保护口径）。
    fn scan(repo: &TempRepo, config_default: &str) -> BranchRepoScan {
        scan_repo_blocking("HIS", repo.dir(), config_default, &HashMap::new(), None, None)
    }

    /// 带用户目标分支覆盖的扫描。
    fn scan_with_overrides(
        repo: &TempRepo,
        config_default: &str,
        overrides: &HashMap<String, String>,
    ) -> BranchRepoScan {
        scan_repo_blocking("HIS", repo.dir(), config_default, overrides, None, None)
    }

    fn known(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    // 目标分支推断：配置优先 → 分支名目标段 → 兜底。
    #[test]
    fn infers_target_branch_from_config_then_name_then_fallback() {
        let branches = known(&["develop", "master", "main", "develop-old"]);

        // ① 配置优先
        assert_eq!(
            infer_target_branch("feature/develop/x", "release", &branches, None),
            ("release".to_string(), TargetSource::Config)
        );
        // ② 命名规范第三段
        assert_eq!(
            infer_target_branch("hotfix/v2.20260901/master/QHDK-30392-x", "", &branches, None),
            ("master".to_string(), TargetSource::Name)
        );
        // ② 目标段不在第三段（feature/develop/描述）也要认出来
        assert_eq!(
            infer_target_branch("feature/develop/消息嵌入", "", &branches, None),
            ("develop".to_string(), TargetSource::Name)
        );
        // ② 版本段 / 议题段不得被误当成目标分支
        assert_eq!(
            infer_target_branch("fix/v2.20260901/develop/QHDK-30395-x", "", &branches, None),
            ("develop".to_string(), TargetSource::Name)
        );
        // ③ 命名不合规范（Nezha 自建批次）→ 兜底常量
        assert_eq!(
            infer_target_branch("feature/my-slug", "", &branches, None),
            ("develop".to_string(), TargetSource::Default)
        );
        // ④ 用户手动指定优先级最高，压过配置与命名
        assert_eq!(
            infer_target_branch("hotfix/v2.20260901/master/x", "release", &branches, Some("main")),
            ("main".to_string(), TargetSource::User)
        );
        // ④ 空白覆盖值不算覆盖，回落正常推断
        assert_eq!(
            infer_target_branch("feature/develop/x", "", &branches, Some("  ")),
            ("develop".to_string(), TargetSource::Name)
        );
    }

    // 行内目标分支覆盖必须参与合并判定：改成 master 后，按 develop 算出的
    // 「已合并、可删除」结论就不再成立——徽标与可删计数不能与用户看到的目标不一致。
    #[test]
    fn user_target_override_recomputes_merge_state() {
        let (repo, _origin) = repo_with_origin();
        // master 作为另一条主干，且不含该分支的提交。
        repo.git(&["branch", "master", "develop"]);
        repo.git(&["push", "origin", "master"]);

        // 分支已合入 develop，但没合入 master。
        write_commit(&repo, "feature/develop/done", "d.txt", "d");
        repo.git(&["push", "-u", "origin", "feature/develop/done"]);
        repo.git(&["checkout", "develop"]);
        repo.git(&["merge", "--no-edit", "feature/develop/done"]);
        repo.git(&["push", "origin", "develop"]);

        // 默认（推断出 develop）→ 已合并、可删。
        let base = scan(&repo, "");
        let default_view = branch_of(&base, "feature/develop/done");
        assert_eq!(default_view.merge_state, MergeState::Merged);
        assert!(default_view.deletable);
        assert_eq!(default_view.target_source, TargetSource::Name);

        // 用户改成 master → 未合并、不可删，且来源标成 user。
        let mut overrides = HashMap::new();
        overrides.insert("feature/develop/done".to_string(), "master".to_string());
        let overridden = scan_with_overrides(&repo, "", &overrides);
        let item = branch_of(&overridden, "feature/develop/done");
        assert_eq!(item.target_branch, "master");
        assert_eq!(item.target_source, TargetSource::User);
        assert_eq!(item.merge_state, MergeState::Unmerged);
        assert!(!item.deletable, "按新目标分支判定后不可删除");
    }

    // 增量扫描：只评估指定分支。行内改目标分支只重算那一条，结果必须与全量扫描一致——
    // 否则前端「只重算一个分支」的提速会以结论不一致为代价。
    #[test]
    fn only_branches_limits_evaluation_without_changing_verdicts() {
        let (repo, _origin) = repo_with_origin();
        write_commit(&repo, "feature/develop/one", "one.txt", "1");
        repo.git(&["push", "-u", "origin", "feature/develop/one"]);
        write_commit(&repo, "feature/develop/two", "two.txt", "2");
        repo.git(&["push", "-u", "origin", "feature/develop/two"]);
        repo.git(&["checkout", "develop"]);

        // 全量：两条都在。
        let full = scan(&repo, "");
        assert!(full.branches.iter().any(|b| b.branch == "feature/develop/one"));
        assert!(full.branches.iter().any(|b| b.branch == "feature/develop/two"));

        // 增量：只回被指定的那一条，且结论与全量一致。
        let only: HashSet<String> = ["feature/develop/two".to_string()].into_iter().collect();
        let partial =
            scan_repo_blocking("HIS", repo.dir(), "", &HashMap::new(), None, Some(&only));
        let names: Vec<&str> = partial.branches.iter().map(|b| b.branch.as_str()).collect();
        assert_eq!(names, vec!["feature/develop/two"]);
        let picked = branch_of(&partial, "feature/develop/two");
        let reference = branch_of(&full, "feature/develop/two");
        assert_eq!(picked.unmerged, reference.unmerged);
        assert_eq!(picked.merge_state, reference.merge_state);
        assert_eq!(picked.target_branch, reference.target_branch);
        // 目标分支的推断要用**全量**分支名做 known_branches，不能因过滤而失效。
        assert_eq!(picked.target_source, TargetSource::Name);
    }

    // 「我的提交」判据：多作者分支里只要有本人的提交即算「我的」。
    #[test]
    fn marks_branch_as_mine_when_own_commit_is_in_unique_set() {
        let (repo, _origin) = repo_with_origin();
        repo.git(&["checkout", "-b", "feature/develop/shared", "develop"]);
        repo.git_authored(
            &["commit", "--allow-empty", "-m", "by other"],
            "other@test.test",
            "other",
        );
        repo.git_authored(
            &["commit", "--allow-empty", "-m", "by me"],
            "me@test.test",
            "me",
        );
        repo.git(&["push", "-u", "origin", "HEAD"]);
        repo.git(&["checkout", "develop"]);

        let scan = scan(&repo, "");
        assert!(scan.ok, "{}", scan.message);
        let item = branch_of(&scan, "feature/develop/shared");
        assert!(item.mine, "独有提交含本人应判为我的提交");
        assert_eq!(item.merge_state, MergeState::Unmerged);
        assert_eq!(item.unmerged, 2);
        assert_eq!(item.target_branch, "develop");
        assert_eq!(item.target_source, TargetSource::Name);
    }

    // 未推送的分支要明确标记，且不允许删除。
    #[test]
    fn marks_unpushed_branch_and_never_deletable() {
        let (repo, _origin) = repo_with_origin();
        write_commit(&repo, "feature/develop/local-only", "local.txt", "local");
        repo.git(&["checkout", "develop"]);

        let scan = scan(&repo, "");
        let item = branch_of(&scan, "feature/develop/local-only");
        assert!(!item.pushed);
        assert!(!item.deletable);
        assert!(!item.skip_reason.is_empty());
    }

    // 合并三态：未合并 / 部分合并 / 已合并。
    #[test]
    fn classifies_merge_state_three_ways() {
        let (repo, _origin) = repo_with_origin();

        // 未合并：有独有提交，源分支不含。
        write_commit(&repo, "feature/develop/a", "a1.txt", "a1");
        repo.git(&["push", "-u", "origin", "feature/develop/a"]);
        repo.git(&["checkout", "develop"]);

        // 部分合并：两个独有提交，只把一个 cherry-pick 进 develop。
        repo.git(&["checkout", "-b", "feature/develop/b", "develop"]);
        std::fs::write(repo.path.join("b1.txt"), "b1").unwrap();
        repo.git(&["add", "b1.txt"]);
        repo.git(&["commit", "-m", "b1"]);
        let first = repo.stdout(&["rev-parse", "HEAD"]);
        std::fs::write(repo.path.join("b2.txt"), "b2").unwrap();
        repo.git(&["add", "b2.txt"]);
        repo.git(&["commit", "-m", "b2"]);
        repo.git(&["push", "-u", "origin", "feature/develop/b"]);
        repo.git(&["checkout", "develop"]);
        repo.git(&["cherry-pick", &first]);
        repo.git(&["push", "origin", "develop"]);

        // 已合并：develop 上把分支 merge 进来并推走。
        write_commit(&repo, "feature/develop/c", "c1.txt", "c1");
        repo.git(&["push", "-u", "origin", "feature/develop/c"]);
        repo.git(&["checkout", "develop"]);
        repo.git(&["merge", "--no-edit", "feature/develop/c"]);
        repo.git(&["push", "origin", "develop"]);

        let scan = scan(&repo, "");
        assert!(scan.ok, "{}", scan.message);

        let a = branch_of(&scan, "feature/develop/a");
        assert_eq!(a.merge_state, MergeState::Unmerged);
        assert!(!a.deletable);
        assert!(!a.skip_reason.is_empty());

        let b = branch_of(&scan, "feature/develop/b");
        assert_eq!(
            b.merge_state,
            MergeState::Partial,
            "一个提交已进 develop、一个没进"
        );
        assert!(!b.deletable);

        let c = branch_of(&scan, "feature/develop/c");
        assert_eq!(c.merge_state, MergeState::Merged);
        assert_eq!(c.merged_into.as_deref(), Some("develop"));
        assert!(c.deletable, "已完整合并的分支允许删除");
    }

    // 删除门禁：受保护分支一律拒绝；未完成合并不许删；dry-run 不得产生任何远端变更。
    #[test]
    fn prune_gates_deletion_and_dry_run_changes_nothing() {
        let (repo, _origin) = repo_with_origin();

        // 已完整合并、可删的分支
        write_commit(&repo, "hotfix/v2.20260901/develop/QHDK-1-x", "h1.txt", "h1");
        repo.git(&["push", "-u", "origin", "hotfix/v2.20260901/develop/QHDK-1-x"]);
        repo.git(&["checkout", "develop"]);
        repo.git(&["merge", "--no-edit", "hotfix/v2.20260901/develop/QHDK-1-x"]);
        repo.git(&["push", "origin", "develop"]);

        // 未合并的分支
        write_commit(&repo, "feature/develop/wip", "w.txt", "w");
        repo.git(&["push", "-u", "origin", "feature/develop/wip"]);
        repo.git(&["checkout", "develop"]);

        let target = |branch: &str| RemoteBranchTarget {
            repo_path: repo.dir().to_string(),
            repo: "HIS".to_string(),
            branch: branch.to_string(),
            target_branch: "develop".to_string(),
        };
        let items = vec![
            target("hotfix/v2.20260901/develop/QHDK-1-x"),
            target("feature/develop/wip"),
            target("develop"),
        ];

        let scan: Vec<RemoteBranchPruneItem> = items
            .iter()
            .map(|i| prune_remote_item_blocking(i, true, None, ""))
            .collect();
        let find = |list: &[RemoteBranchPruneItem], name: &str| {
            list.iter().find(|i| i.branch == name).unwrap().clone()
        };
        assert!(find(&scan, "hotfix/v2.20260901/develop/QHDK-1-x").deletable);
        assert!(!find(&scan, "feature/develop/wip").deletable, "未完成合并必须拒绝");
        assert!(!find(&scan, "develop").deletable, "受保护分支必须拒绝");
        assert!(scan.iter().all(|i| !i.deleted), "dry-run 不得真删");
        assert!(remote_branch_exists(repo.dir(), "hotfix/v2.20260901/develop/QHDK-1-x").unwrap());

        // 执行：只删已完整合并的那条。
        let done: Vec<RemoteBranchPruneItem> = items
            .iter()
            .map(|i| prune_remote_item_blocking(i, false, None, ""))
            .collect();
        assert!(find(&done, "hotfix/v2.20260901/develop/QHDK-1-x").deleted);
        assert!(!find(&done, "feature/develop/wip").deleted);
        assert!(!find(&done, "develop").deleted);
        assert!(!remote_branch_exists(repo.dir(), "hotfix/v2.20260901/develop/QHDK-1-x").unwrap());
        assert!(remote_branch_exists(repo.dir(), "feature/develop/wip").unwrap());
        assert!(remote_branch_exists(repo.dir(), "develop").unwrap());
        // 只删远端：本地分支不受影响，不会破坏其他任务打开的工作区。
        assert!(
            !repo
                .stdout(&["branch", "--list", "hotfix/v2.20260901/develop/QHDK-1-x"])
                .is_empty(),
            "本地分支不应被删除"
        );
    }

    // 平台侧受保护标志优先：`develop-old` 这类 git 侧不认得的受保护分支也不可删。
    #[test]
    fn platform_protected_flag_blocks_deletion() {
        let (repo, _origin) = repo_with_origin();
        repo.git(&["checkout", "-b", "develop-old", "develop"]);
        repo.git(&["push", "-u", "origin", "develop-old"]);
        repo.git(&["checkout", "develop"]);
        repo.git(&["merge", "--no-edit", "develop-old"]);
        repo.git(&["push", "origin", "develop"]);

        // 平台口径下 `develop-old` 受保护
        let platform = RepoPlatform {
            protected: known(&["develop-old", "develop"]),
            default_branch: Some("develop".to_string()),
            platform_ok: true,
            mr_ok: true,
            ..Default::default()
        };
        let scan = scan_repo_blocking("HIS", repo.dir(), "", &HashMap::new(), Some(&platform), None);
        let item = branch_of(&scan, "develop-old");
        assert!(item.protected, "平台受保护标志应生效");
        assert!(!item.deletable);
        assert_eq!(item.protected_source, Some(ProtectedSource::Platform));

        // 删除命令同样按平台口径拒绝
        let target = RemoteBranchTarget {
            repo_path: repo.dir().to_string(),
            repo: "HIS".to_string(),
            branch: "develop-old".to_string(),
            target_branch: "develop".to_string(),
        };
        let out = prune_remote_item_blocking(&target, false, Some(&known(&["develop-old"])), "");
        assert!(!out.deletable);
        assert!(!out.deleted);
        assert!(remote_branch_exists(repo.dir(), "develop-old").unwrap());
    }

    // 目标分支受保护不得殃及待删分支：develop 这类主干在云效上几乎总是受保护/默认分支，
    // 删除门禁若把「目标分支 ∈ 受保护集合」也算进去，所有已合并进主干的特性分支都会被
    // 误拒——行内「已合并，可删除远端分支」与 dry-run「受保护分支，不可删除」自相矛盾。
    #[test]
    fn platform_protected_target_does_not_block_merged_feature_branch() {
        let (repo, _origin) = repo_with_origin();
        write_commit(&repo, "fix/v2.20260901/develop/QHDK-1-x", "f1.txt", "f");
        repo.git(&["push", "-u", "origin", "fix/v2.20260901/develop/QHDK-1-x"]);
        repo.git(&["checkout", "develop"]);
        repo.git(&["merge", "--no-edit", "fix/v2.20260901/develop/QHDK-1-x"]);
        repo.git(&["push", "origin", "develop"]);

        // 平台口径：develop / master 都在受保护集合里——线上仓库的常态。
        let platform = known(&["develop", "master"]);
        let target = RemoteBranchTarget {
            repo_path: repo.dir().to_string(),
            repo: "HIS".to_string(),
            branch: "fix/v2.20260901/develop/QHDK-1-x".to_string(),
            target_branch: "develop".to_string(),
        };

        // dry-run 必须判为可删（与扫描侧口径一致），且不产生任何远端变更。
        let out = prune_remote_item_blocking(&target, true, Some(&platform), "");
        assert!(
            out.deletable,
            "目标分支受保护不应阻断特性分支删除，实际原因：{}",
            out.reason
        );
        assert!(!out.deleted, "dry-run 不得真删");
        assert!(remote_branch_exists(repo.dir(), "fix/v2.20260901/develop/QHDK-1-x").unwrap());

        // 口径收窄不能放过真正的受保护分支：待删分支自身在集合里仍要拒绝。
        let guarded = RemoteBranchTarget {
            repo_path: repo.dir().to_string(),
            repo: "HIS".to_string(),
            branch: "develop".to_string(),
            target_branch: "develop".to_string(),
        };
        let out = prune_remote_item_blocking(&guarded, true, Some(&platform), "");
        assert!(!out.deletable, "受保护分支自身必须拒绝");
    }

    // 远端分支已被删除而本地 upstream / 分支都还在（平台合并后自动删除是常态）：扫描若继续
    // 标「已合并，可删除」，用户勾选后 dry-run 必然以「远端已无该分支」拒绝——回执面板与
    // 行内徽标自相矛盾，体感就是「点了删除没反应」。扫描与 dry-run 必须给出同一结论。
    #[test]
    fn scan_refuses_branch_already_deleted_on_remote() {
        let (repo, origin) = repo_with_origin();
        write_commit(&repo, "fix/v2.20260901/develop/QHDK-30439-x", "f1.txt", "f");
        repo.git(&["push", "-u", "origin", "fix/v2.20260901/develop/QHDK-30439-x"]);
        repo.git(&["checkout", "develop"]);
        repo.git(&["merge", "--no-edit", "fix/v2.20260901/develop/QHDK-30439-x"]);
        repo.git(&["push", "origin", "develop"]);

        // 只在 bare 端删分支：本地分支、upstream 配置、remote-tracking ref 全部保留——
        // 精确复刻「平台侧删除、本机尚未 fetch --prune」的线上状态。
        let o = Command::new("git")
            .arg("-C")
            .arg(origin.dir())
            .args(["update-ref", "-d", "refs/heads/fix/v2.20260901/develop/QHDK-30439-x"])
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));

        let scan = scan(&repo, "");
        let item = branch_of(&scan, "fix/v2.20260901/develop/QHDK-30439-x");
        assert!(
            !item.pushed,
            "远端已无该分支时不得再按已推送处理（该行应从待办列表消失），skip={}",
            item.skip_reason
        );
        assert!(
            !item.deletable,
            "扫描不得承诺 dry-run 做不到的删除，skip={}",
            item.skip_reason
        );
        assert!(
            item.skip_reason.contains("远端已无该分支"),
            "skip={}",
            item.skip_reason
        );

        // dry-run 同口径拒绝，且与扫描的可删性一致。
        let target = RemoteBranchTarget {
            repo_path: repo.dir().to_string(),
            repo: "HIS".to_string(),
            branch: "fix/v2.20260901/develop/QHDK-30439-x".to_string(),
            target_branch: "develop".to_string(),
        };
        let out = prune_remote_item_blocking(&target, true, None, "");
        assert!(!out.deletable);
        assert_eq!(
            item.deletable, out.deletable,
            "扫描与 dry-run 的可删性必须一致"
        );
        assert!(out.reason.contains("远端已无该分支"), "reason={}", out.reason);
    }

    // 非 ASCII 分支名必须能被远端存在性检查识别（用户仓库的分支名普遍含中文）。
    #[test]
    fn remote_branch_exists_recognises_chinese_branch_names() {
        let (repo, _origin) = repo_with_origin();
        let branch = "fix/v2.20260901/develop/QHDK-30439-消息平台参数未配置静默跳过";
        write_commit(&repo, branch, "f1.txt", "f");
        repo.git(&["push", "-u", "origin", branch]);
        assert!(
            remote_branch_exists(repo.dir(), branch).unwrap(),
            "远端确实存在该中文分支，存在性检查不得漏判"
        );
    }

    // push --delete 报「远端已无该分支」时，删除的目标状态已经达成（读副本还看得到、
    // 写路径发现早已被删——平台合并自动删 / 他人先删 / 副本滞后的常态），必须按成功回执，
    // 绝不能报成红色「删除失败」。用 pushurl 把读写拆到两个仓库复刻这个不一致窗口：
    // ls-remote / fetch 读 origin（分支在），push 走 pushurl（分支不在）。
    #[test]
    fn push_delete_missing_remote_ref_is_treated_as_achieved() {
        let (repo, origin) = repo_with_origin();
        let empty = TempBareRemote::new();
        write_commit(&repo, "feature/develop/doomed", "f.txt", "f");
        repo.git(&["push", "-u", "origin", "feature/develop/doomed"]);
        repo.git(&["checkout", "develop"]);
        repo.git(&["merge", "--no-edit", "feature/develop/doomed"]);
        repo.git(&["push", "origin", "develop"]);
        // 读走 origin（分支存在），写走空仓库（分支不存在）。
        repo.git(&["remote", "set-url", "--push", "origin", empty.dir()]);

        let target = RemoteBranchTarget {
            repo_path: repo.dir().to_string(),
            repo: "HIS".to_string(),
            branch: "feature/develop/doomed".to_string(),
            target_branch: "develop".to_string(),
        };
        let out = prune_remote_item_blocking(&target, false, None, "");
        assert!(
            out.deleted,
            "push 报远端已无该分支时目标已达成，应按成功回执；实际 reason={}",
            out.reason
        );
        assert!(
            out.reason.contains("删除目标已达成"),
            "回执应说明目标已达成，实际：{}",
            out.reason
        );
        // 读路径未受影响：origin 上分支仍在（不一致窗口的另一侧）。
        assert!(remote_branch_exists(repo.dir(), "feature/develop/doomed").unwrap());
    }

    // 目标分支不存在时按「数据缺失」降级，而不是让整个列表失败。
    #[test]
    fn degrades_when_target_branch_is_missing() {
        let (repo, _origin) = repo_with_origin();
        write_commit(&repo, "feature/develop/ghost", "g.txt", "g");
        repo.git(&["push", "-u", "origin", "feature/develop/ghost"]);
        repo.git(&["checkout", "develop"]);

        let scan = scan(&repo, "nope-branch");
        assert!(scan.ok);
        let item = branch_of(&scan, "feature/develop/ghost");
        assert_eq!(item.target_branch, "nope-branch");
        assert!(item.data_missing);
        assert!(!item.deletable);
    }

    // 开放 MR 在内存 join：命中该源分支时行上带出 MR 编号。
    #[test]
    fn joins_open_mr_by_source_branch() {
        let (repo, _origin) = repo_with_origin();
        write_commit(&repo, "feature/develop/with-mr", "m.txt", "m");
        repo.git(&["push", "-u", "origin", "feature/develop/with-mr"]);
        repo.git(&["checkout", "develop"]);

        let mut open_mrs = HashMap::new();
        open_mrs.insert(
            "feature/develop/with-mr".to_string(),
            crate::codeup::OpenChangeRequest {
                repository_id: "42".to_string(),
                source_branch: "feature/develop/with-mr".to_string(),
                target_branch: "develop".to_string(),
                local_id: 3527,
                state: "UNDER_REVIEW".to_string(),
                has_conflict: false,
            },
        );
        let platform = RepoPlatform {
            default_branch: Some("develop".to_string()),
            open_mrs,
            platform_ok: true,
            mr_ok: true,
            protected: HashSet::new(),
        };
        let scan = scan_repo_blocking("HIS", repo.dir(), "", &HashMap::new(), Some(&platform), None);
        let item = branch_of(&scan, "feature/develop/with-mr");
        assert_eq!(item.open_mr_id, Some(3527));
        assert_eq!(item.open_mr_state, "UNDER_REVIEW");
        // MR 数据可用时该分支不应成为「待发起」候选（前端据此过滤），但行本身要如实带出 MR。
        assert!(scan.mr_ok);
    }
    // 路径安全：仓库路径必须落在项目内，越界路径在产生任何副作用前就被拒绝。
    // 仓库发现要给出可用的仓库名（与 repo_filter 的匹配键一致），这是分段加载的第一步。
    #[test]
    fn discover_repo_refs_lists_worktree_roots() {
        let (repo, _origin) = repo_with_origin();
        let found = discover_repo_refs_blocking(repo.dir()).unwrap();
        assert_eq!(found.len(), 1, "单仓库项目只列主仓库");
        let expected = repo
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap();
        assert_eq!(found[0].name, expected, "仓库名要与 BuildRepo.name 一致");
        assert_eq!(found[0].path, repo.dir());
    }

    // 未初始化的子模块：`.gitmodules` 里声明了、目录也在，但里面没有 `.git`。此时
    // `git -C <dir>` 会向上找到父仓库（实测 HIS 的 Nto.Pacs 解析到 HIS），把父仓库的分支
    // 原样重复一遍。发现阶段必须把它排除，只留真正的工作树根。
    #[test]
    fn discover_repo_refs_excludes_non_worktree_roots() {
        let (repo, _origin) = repo_with_origin();
        // 声明一个未初始化的子模块：目录建出来但不 init
        std::fs::create_dir_all(repo.path.join("Nto.Pacs")).unwrap();
        std::fs::write(
            repo.path.join(".gitmodules"),
            "[submodule \"Nto.Pacs\"]
	path = Nto.Pacs
	url = git@example.com:x/pacs.git
",
        )
        .unwrap();

        let found = discover_repo_refs_blocking(repo.dir()).unwrap();
        let names: Vec<&str> = found.iter().map(|r| r.name.as_str()).collect();
        // 项目根本身是真仓库，要保留
        assert!(!names.is_empty(), "真仓库要保留：{names:?}");
        // 未初始化的子模块要排除（不重复父仓库分支）
        assert!(
            !names.iter().any(|n| n.contains("Nto.Pacs")),
            "未初始化子模块必须排除：{names:?}"
        );
    }

    // 「项目里没有可用仓库」是「不适用」而非错误：返回空列表，前端不报红条。
    #[test]
    fn discover_repo_refs_is_empty_when_nothing_is_usable() {
        let workspace = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("pending-mr-tests")
            .join(format!("ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(workspace.join("Fake.Sub")).unwrap();
        // 根不是仓库，唯一「仓库」是未初始化的子模块
        std::fs::write(
            workspace.join(".gitmodules"),
            "[submodule \"Fake.Sub\"]
	path = Fake.Sub
	url = git@example.com:x/y.git
",
        )
        .unwrap();
        let found = discover_repo_refs_blocking(workspace.to_str().unwrap()).unwrap();
        assert!(found.is_empty(), "不适用应返回空列表：{found:?}");
        let _ = std::fs::remove_dir_all(&workspace);
    }

    // 项目路径本身非法仍是错误（真故障要暴露，不能被当成「不适用」吞掉）。
    #[test]
    fn discover_repo_refs_still_errors_on_bad_project_path() {
        assert!(discover_repo_refs_blocking("relative/not/absolute").is_err());
    }

    // 路径安全：仓库路径必须落在项目内，越界路径在产生任何副作用前就被拒绝。
    // 未初始化的子模块：目录在但里面没有 `.git`。`git -C` 会向上找到父仓库，把父仓库的
    // 分支原样重复一遍（实测 HIS 的 Nto.Pacs 解析到 HIS）。发现阶段就要把它排除掉。

    // 一个可用仓库都没有时明确报错，不把「全都不适用」伪装成「没有待发起分支」。

    #[test]
    fn rejects_repo_path_outside_project() {
        let project = TempRepo::new();
        let outside = TempRepo::new();
        let err = crate::git::resolve_repo_path_blocking(project.dir(), Some(outside.dir()))
            .expect_err("项目外的仓库路径必须拒绝");
        assert!(err.contains("outside the project"), "{err}");

        // 项目内的子仓库路径照常放行。
        let inside = project.path.join("sub");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(crate::git::resolve_repo_path_blocking(project.dir(), Some(inside.to_str().unwrap())).is_ok());
    }

    // 未指定目标分支时拒绝删除，而不是退化成「猜一个」。
    #[test]
    fn prune_requires_a_target_branch() {
        let (repo, _origin) = repo_with_origin();
        let item = RemoteBranchTarget {
            repo_path: repo.dir().to_string(),
            repo: "HIS".to_string(),
            branch: "develop".to_string(),
            target_branch: "  ".to_string(),
        };
        let out = prune_remote_item_blocking(&item, false, None, "");
        assert!(!out.deletable);
        assert!(!out.deleted);
        assert!(out.reason.contains("未指定目标分支"));
    }
}
