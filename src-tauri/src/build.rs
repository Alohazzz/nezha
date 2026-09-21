use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;

/// Running build processes: build_id -> child OS pid (for tree-kill on cancel).
static RUNNING_BUILDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn running_builds() -> &'static Mutex<HashMap<String, u32>> {
    RUNNING_BUILDS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BuildConfig {
    #[serde(default)]
    pub script_path: String,
    #[serde(default)]
    pub msbuild_path: String,
    #[serde(default = "default_solution")]
    pub solution: String,
    #[serde(default = "default_configuration")]
    pub configuration: String,
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default)]
    pub external_dll_dir: String,
    #[serde(default)]
    pub skip_external_check: bool,
    #[serde(default)]
    pub skip_restore: bool,
    #[serde(default)]
    pub skip_clean: bool,
    #[serde(default)]
    pub default_branch: String,
    /// 构建面板「可选子仓库」白名单：主仓库恒显示；子模块的名称或路径命中任一关键字
    /// （忽略大小写）才列出。留空表示列出全部子模块。可在项目设置页编辑。
    #[serde(default = "default_visible_subrepos")]
    pub visible_subrepos: Vec<String>,
    #[serde(default = "default_max_parallel")]
    pub max_parallel: u32,
    /// 构建失败后自动创建修复任务（full_access）。默认关闭：不经确认就拉起智能体进程
    /// 属于有副作用的行为，需要用户显式打开。前端读取该开关决定是否自动发起修复任务。
    #[serde(default)]
    pub auto_fix_on_failure: bool,
}

fn default_solution() -> String {
    "Hsp v2.0.sln".to_string()
}
fn default_configuration() -> String {
    "Debug".to_string()
}
fn default_platform() -> String {
    "AnyCPU".to_string()
}
fn default_visible_subrepos() -> Vec<String> {
    vec![
        "DrugInOut".to_string(),
        "Term".to_string(),
        "Hsp.Win".to_string(),
    ]
}
fn default_max_parallel() -> u32 {
    2
}

impl Default for BuildConfig {
    fn default() -> Self {
        BuildConfig {
            script_path: String::new(),
            msbuild_path: String::new(),
            solution: default_solution(),
            configuration: default_configuration(),
            platform: default_platform(),
            external_dll_dir: String::new(),
            skip_external_check: false,
            skip_restore: false,
            skip_clean: false,
            default_branch: String::new(),
            visible_subrepos: default_visible_subrepos(),
            max_parallel: default_max_parallel(),
            auto_fix_on_failure: false,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BuildRepo {
    pub name: String,
    pub path: String,
    pub remote: String,
    pub branch: String,
    pub branches: Vec<String>,
    /// 远端跟踪分支（`origin/xxx` 形态）。已存在同名本地分支的远端项不列出。
    #[serde(default)]
    pub remote_branches: Vec<String>,
    pub is_submodule: bool,
    pub dirty: bool,
    pub missing: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PullResult {
    pub name: String,
    pub ok: bool,
    pub message: String,
}

/// 「远端已不存在的本地分支」的判定 / 删除结果。
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StaleBranchItem {
    /// 本地分支名。
    pub branch: String,
    /// 本次是否已删除（dry_run 时恒为 false）。
    pub deleted: bool,
    /// 是否满足删除条件（分支提交已存在于远端）。
    pub deletable: bool,
    /// 跳过原因；可删除时给出判定依据（如「已合入 origin/main」）。
    pub reason: String,
}

/// 单个仓库的失效分支清理结果。
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StaleBranchRepoResult {
    /// 仓库名（与 `BuildRepo.name` 一致）。
    pub name: String,
    /// 仓库绝对路径（前端据此就地更新分支列表）。
    pub path: String,
    /// 远端刷新 / 扫描是否成功。
    pub ok: bool,
    /// `ok = false` 时的失败原因。
    pub message: String,
    /// 失效分支明细（无失效分支时为空）。
    pub branches: Vec<StaleBranchItem>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BuildState {
    /// repo name -> last successfully built commit (diff baseline for incremental builds).
    #[serde(default)]
    pub last_built: HashMap<String, String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RunBuildOptions {
    #[serde(default)]
    pub continue_on_error: bool,
    /// Incremental include list (project paths / assemblies / file names). Empty = full build.
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub skip_external_check: bool,
    #[serde(default)]
    pub skip_restore: bool,
    #[serde(default)]
    pub skip_clean: bool,
    /// Selected git repo names (build scope). Empty = full solution.
    #[serde(default)]
    pub selected: Vec<String>,
    /// 覆盖构建输出目录（如 worktree 运行根）。为空则用项目配置 external_dll_dir / 自动探测。
    #[serde(default)]
    pub external_dll_dir: String,
}

fn validate_project_path(project_path: &str) -> Result<(), String> {
    let path = Path::new(project_path);
    if !path.is_absolute() {
        return Err("Project path must be absolute".to_string());
    }
    if !path.exists() {
        return Err("Project path does not exist".to_string());
    }
    path.canonicalize()
        .map(|_| ())
        .map_err(|e| format!("Cannot resolve project path: {e}"))
}

fn read_project_path(project_path: &str) -> Result<PathBuf, String> {
    validate_project_path(project_path)?;
    Ok(Path::new(project_path).to_path_buf())
}

fn run_git_in(dir: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("git");
    crate::subprocess::configure_background_command(&mut cmd);
    cmd.args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git failed: {e}"))
}

fn git_ok(dir: &str, args: &[&str]) -> bool {
    matches!(run_git_in(dir, args), Ok(out) if out.status.success())
}

fn is_repo(dir: &str) -> bool {
    git_ok(dir, &["rev-parse", "--git-dir"])
}

fn git_remote(dir: &str) -> String {
    if let Ok(out) = run_git_in(dir, &["remote", "get-url", "origin"]) {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        String::new()
    }
}

fn git_branch(dir: &str) -> String {
    if let Ok(out) = run_git_in(dir, &["symbolic-ref", "--short", "HEAD"]) {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        // detached HEAD — fall back to rev-parse short
        if let Ok(out) = run_git_in(dir, &["rev-parse", "--short", "HEAD"]) {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            String::new()
        }
    }
}

fn git_branches(dir: &str) -> Vec<String> {
    if let Ok(out) = run_git_in(
        dir,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    ) {
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        Vec::new()
    }
}

/// 远端跟踪分支列表（`origin/xxx` 短名）。剔除 `*/HEAD` 符号引用，
/// 以及已存在同名本地分支的远端项（切到它直接选本地分支即可，重复展示徒增噪音）。
fn git_remote_branches(dir: &str, local: &[String]) -> Vec<String> {
    let out = match run_git_in(
        dir,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    ) {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| {
            if s.is_empty() {
                return false;
            }
            // origin/HEAD、upstream/HEAD 等符号引用
            if s.ends_with("/HEAD") {
                return false;
            }
            // 远端短名去掉首个路径段（remote 名）即本地分支名
            match s.split_once('/') {
                Some((_, local_name)) => !local.iter().any(|l| l == local_name),
                None => false,
            }
        })
        .collect()
}

fn git_dirty(dir: &str) -> bool {
    // 忽略子模块改动：子仓库常因本地改动/commit 指针不同导致主仓库误报脏。
    // 叶仓库（无子模块）此开关为 no-op，仍能反映自身真实改动。
    // 再忽略未跟踪文件（--untracked-files=no）：未跟踪/未纳入 Git 的内容不参与 `git pull --ff-only`，
    // 不能因为工作区里有本地生成物（如构建产物）就把整个仓库误判为脏并阻断拉取。
    // 只有受跟踪文件的改动/暂存改动才真正可能阻碍快进合并。
    if let Ok(out) = run_git_in(
        dir,
        &[
            "status",
            "--porcelain",
            "--ignore-submodules=all",
            "--untracked-files=no",
        ],
    ) {
        !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    } else {
        false
    }
}

fn git_head(dir: &str) -> Result<String, String> {
    let out = run_git_in(dir, &["rev-parse", "HEAD"])?;
    if !out.status.success() {
        return Err("not a commit".to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Parse `.gitmodules` for `[submodule "name"]` entries with `path` / `url`.
///
/// `pub(crate)`：`pending_mr` 的轻量仓库发现（只列仓库、不读分支）复用它，
/// 保证两处对子模块的命名口径一致——仓库名是 `list_branch_pr_candidates` 的过滤键。
pub(crate) fn parse_gitmodules(gitmodules: &str) -> Vec<(String, String, String)> {
    let mut entries = Vec::new();
    let mut cur: Option<String> = None;
    let mut path = String::new();
    let mut url = String::new();
    for line in gitmodules.lines() {
        let t = line.trim();
        if t.starts_with("[submodule ") && t.ends_with(']') {
            if let Some(n) = cur.take() {
                if !path.trim().is_empty() {
                    entries.push((n, path.trim().to_string(), url.trim().to_string()));
                }
            }
            let inner = &t["[submodule ".len()..t.len() - 1];
            cur = Some(inner.trim_matches('"').trim().to_string());
            path = String::new();
            url = String::new();
            continue;
        }
        if let Some(v) = t
            .strip_prefix("path")
            .map(|s| s.trim().trim_start_matches('=').trim())
        {
            if !v.is_empty() {
                path = v.to_string();
            }
        } else if let Some(v) = t
            .strip_prefix("url")
            .map(|s| s.trim().trim_start_matches('=').trim())
        {
            if !v.is_empty() {
                url = v.to_string();
            }
        }
    }
    if let Some(n) = cur.take() {
        if !path.trim().is_empty() {
            entries.push((n, path.trim().to_string(), url.trim().to_string()));
        }
    }
    entries
}

#[tauri::command]
pub fn read_build_config(project_path: String) -> Result<BuildConfig, String> {
    validate_project_path(&project_path)?;
    let cfg = crate::config::read_project_config(project_path)?;
    Ok(cfg.build)
}

#[tauri::command]
pub fn write_build_config(project_path: String, build: BuildConfig) -> Result<(), String> {
    validate_project_path(&project_path)?;
    let mut cfg = crate::config::read_project_config(project_path.clone())?;
    cfg.build = build;
    crate::config::write_project_config(project_path, cfg)
}

/// 仅从 `.gitmodules` 读出的子仓库条目（名称 + 绝对路径）。
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BuildSubrepo {
    pub name: String,
    pub path: String,
}

/// 轻量列出项目的子仓库（只读 `.gitmodules`，**不跑任何 git 命令**）。
///
/// 用途：只需要「有哪些子仓库可勾选」的场景（如设置页的「可选子仓库」下拉）。
/// 完整 `discover_build_repos` 即使已并发化，仍要为每个仓库跑数条 git 命令
/// （每条都是一次约 80ms 的进程启动），只为填一个下拉框不值当——这里约 5ms。
/// 命名口径与 `discover_repos_blocking` 一致（均取自 `parse_gitmodules`），
/// 因此列表里的名字可以直接作为构建面板白名单的匹配值。
#[tauri::command]
pub async fn list_build_subrepos(project_path: String) -> Result<Vec<BuildSubrepo>, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || list_subrepos_blocking(&project_path))
        .await
        .map_err(|e| format!("list_build_subrepos panicked: {e}"))?
}

/// `list_build_subrepos` 的同步实现（无 git 调用，只解析 `.gitmodules`）。
fn list_subrepos_blocking(project_path: &str) -> Result<Vec<BuildSubrepo>, String> {
    let root = read_project_path(project_path)?;
    let gitmodules = root.join(".gitmodules");
    if !gitmodules.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&gitmodules).unwrap_or_default();
    Ok(parse_gitmodules(&content)
        .into_iter()
        .map(|(name, rel, _)| BuildSubrepo {
            name,
            path: root.join(&rel).to_string_lossy().into_owned(),
        })
        .collect())
}

/// 自动推导仓库清单：主仓库 + `.gitmodules` 子模块。
/// 在阻塞线程执行（涉及 git / 文件 IO）。
#[tauri::command]
pub async fn discover_build_repos(project_path: String) -> Result<Vec<BuildRepo>, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || discover_repos_blocking(&project_path))
        .await
        .map_err(|e| format!("discover_build_repos panicked: {e}"))?
}

pub(crate) fn discover_repos_blocking(project_path: &str) -> Result<Vec<BuildRepo>, String> {
    let root = read_project_path(project_path)?;
    let mut repos = Vec::new();

    if is_repo(project_path) {
        let name = root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "root".to_string());
        let branches = git_branches(project_path);
        repos.push(BuildRepo {
            name,
            path: project_path.to_string(),
            remote: git_remote(project_path),
            branch: git_branch(project_path),
            remote_branches: git_remote_branches(project_path, &branches),
            branches,
            is_submodule: false,
            dirty: git_dirty(project_path),
            missing: false,
        });
    }

    let gitmodules = root.join(".gitmodules");
    if gitmodules.exists() {
        let content = std::fs::read_to_string(&gitmodules).unwrap_or_default();
        for (name, rel, url) in parse_gitmodules(&content) {
            let full = root.join(&rel);
            let full_str = full.to_string_lossy().into_owned();
            let missing = !full.exists();
            let branches = if !missing {
                git_branches(&full_str)
            } else {
                Vec::new()
            };
            repos.push(BuildRepo {
                name,
                path: full_str.clone(),
                remote: url,
                branch: if !missing {
                    git_branch(&full_str)
                } else {
                    String::new()
                },
                remote_branches: if !missing {
                    git_remote_branches(&full_str, &branches)
                } else {
                    Vec::new()
                },
                branches,
                is_submodule: true,
                dirty: if !missing {
                    git_dirty(&full_str)
                } else {
                    false
                },
                missing,
            });
        }
    }
    Ok(repos)
}

/// 切到指定仓库的指定分支（用于在 Build 面板选择子模块/主仓库分支）。
/// 传本地分支名做 `git checkout <branch>`；传远端短名（`origin/xxx`）时
/// 自动建立同名本地跟踪分支（`git checkout -b xxx --track origin/xxx`），
/// 本地已存在同名分支则直接切本地。不自动 pull。
/// 返回切换后的实际本地分支名（前端据此更新状态）。
#[tauri::command]
pub async fn build_checkout_branch(
    project_path: String,
    repo_path: String,
    branch: String,
) -> Result<String, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_project_path(&repo_path)?;

        let local_exists = git_ok(&repo_path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]);
        let remote_exists = git_ok(
            &repo_path,
            &["show-ref", "--verify", "--quiet", &format!("refs/remotes/{branch}")],
        );

        let final_branch = if local_exists || !remote_exists {
            // 本地分支，或不在任何一侧（让 git 自己报错）
            branch.clone()
        } else {
            // 远端跟踪分支：切过去要落到同名本地分支上，不能 detached HEAD。
            // 若本地同名分支已存在，`-b` 会失败，由下方回退直接切本地分支。
            branch.split_once('/').map(|(_, rest)| rest).unwrap_or(&branch).to_string()
        };

        let checkout_args: Vec<&str> = if local_exists || !remote_exists {
            vec!["checkout", &branch]
        } else {
            vec!["checkout", "-b", &final_branch, "--track", &branch]
        };
        let out = run_git_in(&repo_path, &checkout_args)?;
        if !out.status.success() {
            // 本地同名分支已存在等场景导致 -b 失败：回退为直接切本地分支
            let fallback = run_git_in(&repo_path, &["checkout", &final_branch])?;
            if !fallback.status.success() {
                return Err(git_error_text(&out));
            }
        }
        Ok(final_branch)
    })
    .await
    .map_err(|e| format!("build_checkout_branch panicked: {e}"))?
}

fn git_error_text(out: &std::process::Output) -> String {
    let s = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .trim()
    .to_string();
    if s.is_empty() {
        "git command failed".to_string()
    } else {
        s
    }
}

/// 对勾选的仓库执行 `git pull --ff-only`；工作区不干净则阻断（绝不 stash/reset）。
#[tauri::command]
pub async fn build_pull_repos(
    project_path: String,
    selected: Vec<String>,
) -> Result<Vec<PullResult>, String> {
    validate_project_path(&project_path)?;
    let selected = selected;
    tauri::async_runtime::spawn_blocking(move || {
        let repos = discover_repos_blocking(&project_path)?;
        let mut out = Vec::new();
        for r in repos {
            if !selected.iter().any(|s| s == &r.name) {
                continue;
            }
            if r.missing {
                out.push(PullResult {
                    name: r.name,
                    ok: false,
                    message: "仓库目录不存在（子模块未初始化？）".to_string(),
                });
                continue;
            }
            if r.dirty {
                out.push(PullResult {
                    name: r.name,
                    ok: false,
                    message: "工作区不干净，已阻断（绝不 stash/reset）。先提交或暂存后再拉取。"
                        .to_string(),
                });
                continue;
            }
            let mut res = run_git_in(&r.path, &["pull", "--ff-only", "--no-rebase"]);
            // 若失败（常见：pull.rebase 干扰 / 远端跟踪引用陈旧导致 cannot lock ref），
            // 先刷新远端跟踪引用（prune + force fetch，仅改 remote-tracking ref，不动工作区），再重试。
            if let Ok(out) = &res {
                if !out.status.success() {
                    let _ = run_git_in(&r.path, &["fetch", "--prune", "--force", "origin"]);
                    res = run_git_in(&r.path, &["pull", "--ff-only", "--no-rebase"]);
                }
            }
            match res {
                Ok(out2) if out2.status.success() => {
                    let msg = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out2.stdout),
                        String::from_utf8_lossy(&out2.stderr)
                    )
                    .trim()
                    .to_string();
                    out.push(PullResult {
                        name: r.name,
                        ok: true,
                        message: if msg.is_empty() {
                            "已更新".to_string()
                        } else {
                            msg
                        },
                    });
                }
                Ok(out2) => {
                    let msg = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out2.stdout),
                        String::from_utf8_lossy(&out2.stderr)
                    )
                    .trim()
                    .to_string();
                    out.push(PullResult {
                        name: r.name,
                        ok: false,
                        message: msg,
                    });
                }
                Err(e) => out.push(PullResult {
                    name: r.name,
                    ok: false,
                    message: e,
                }),
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("build_pull_repos panicked: {e}"))?
}

/// `refs/remotes/origin/*` 的短名（去掉 `origin/` 前缀，剔除 `origin/HEAD` 符号引用）。
/// 调用前须先 `fetch --prune`，否则拿到的是陈旧引用。
fn git_origin_branch_names(dir: &str) -> HashSet<String> {
    let out = match run_git_in(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin",
        ],
    ) {
        Ok(o) if o.status.success() => o,
        _ => return HashSet::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim())
        .filter_map(|s| s.strip_prefix("origin/"))
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("HEAD"))
        .map(|s| s.to_string())
        .collect()
}

/// 已被 worktree 检出的本地分支名（含主工作区当前分支）——这些分支删不掉，清理时直接跳过。
fn git_worktree_branches(dir: &str) -> HashSet<String> {
    let out = match run_git_in(dir, &["worktree", "list", "--porcelain"]) {
        Ok(o) if o.status.success() => o,
        _ => return HashSet::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().strip_prefix("branch refs/heads/"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 找出包含该分支提交的远端跟踪分支（如 `origin/v2.20260901`）。
/// 命中即说明分支内容已经在远端存在，本地删除不会丢内容。
fn git_remote_branch_containing(dir: &str, branch: &str) -> Option<String> {
    let out = run_git_in(dir, &["branch", "-r", "--contains", branch]).ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with("origin/") && !l.contains("->"))
        .map(|l| l.to_string())
}

/// 受保护分支：默认分支与主干分支永不参与清理。
///
/// `pub(crate)`：`pending_mr` 的平台侧受保护标志不可用时要回落这套 git 侧口径。
pub(crate) fn is_protected_branch(branch: &str, default_branch: &str) -> bool {
    const PROTECTED: [&str; 3] = ["main", "master", "develop"];
    let name = branch.to_lowercase();
    let configured = default_branch.trim().to_lowercase();
    (!configured.is_empty() && name == configured) || PROTECTED.contains(&name.as_str())
}

/// 删除本地分支。先 `-d`（用 Git 自带的合并校验）；分支上游已被远端删除、或 HEAD 不在同一条
/// 线上时 `-d` 会误报「未合并」，此时调用方已用 `branch -r --contains` 证明提交存在于远端，
/// 再用 `-D` 收口。分支被 worktree 占用等硬性拒绝两种方式都会失败，故不会绕过校验。
fn delete_local_branch(dir: &str, branch: &str) -> Result<(), String> {
    if let Ok(out) = run_git_in(dir, &["branch", "-d", branch]) {
        if out.status.success() {
            return Ok(());
        }
    }
    let out = run_git_in(dir, &["branch", "-D", branch])?;
    if out.status.success() {
        Ok(())
    } else {
        Err(git_error_text(&out))
    }
}

/// 单仓库失效分支清理。
///
/// 判定「可删」需同时满足：远端刷新成功 → 本地有、`origin` 上已无同名分支 →
/// 提交已存在于某个 `origin/*` 分支 → 未受保护 → 未被任何 worktree 检出。
/// 任何一条不满足都只记录跳过原因，绝不删除。
fn prune_repo_stale_branches(
    repo: &BuildRepo,
    default_branch: &str,
    dry_run: bool,
) -> StaleBranchRepoResult {
    let mut result = StaleBranchRepoResult {
        name: repo.name.clone(),
        path: repo.path.clone(),
        ok: true,
        message: String::new(),
        branches: Vec::new(),
    };
    if repo.missing {
        result.ok = false;
        result.message = "仓库目录不存在（子模块未初始化？）".to_string();
        return result;
    }

    // 远端已删除的分支只有刷新远端跟踪引用后才会从 refs/remotes/origin 消失，
    // 先 fetch --prune 再判断「远端是否还存在」，否则是拿陈旧引用做结论。
    match run_git_in(&repo.path, &["fetch", "--prune", "origin"]) {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            result.ok = false;
            result.message = format!("远端刷新失败：{}", git_error_text(&out));
            return result;
        }
        Err(e) => {
            result.ok = false;
            result.message = format!("远端刷新失败：{e}");
            return result;
        }
    }

    let remote = git_origin_branch_names(&repo.path);
    let occupied = git_worktree_branches(&repo.path);
    for branch in git_branches(&repo.path) {
        // 远端仍有同名分支：不是失效分支，不产生明细噪音。
        if remote.contains(&branch) {
            continue;
        }
        if occupied.contains(&branch) {
            result.branches.push(StaleBranchItem {
                branch,
                deleted: false,
                deletable: false,
                reason: "当前检出分支（或被 worktree 占用），需先切走".to_string(),
            });
            continue;
        }
        if is_protected_branch(&branch, default_branch) {
            result.branches.push(StaleBranchItem {
                branch,
                deleted: false,
                deletable: false,
                reason: "受保护分支（默认分支 / main / master / develop）".to_string(),
            });
            continue;
        }
        let Some(merged_into) = git_remote_branch_containing(&repo.path, &branch) else {
            result.branches.push(StaleBranchItem {
                branch,
                deleted: false,
                deletable: false,
                reason: "提交未合入任何远端分支（可能有未提交内容），已跳过".to_string(),
            });
            continue;
        };
        if dry_run {
            result.branches.push(StaleBranchItem {
                branch,
                deleted: false,
                deletable: true,
                reason: format!("已合入 {merged_into}"),
            });
            continue;
        }
        match delete_local_branch(&repo.path, &branch) {
            Ok(()) => result.branches.push(StaleBranchItem {
                branch,
                deleted: true,
                deletable: true,
                reason: format!("已删除（已合入 {merged_into}）"),
            }),
            Err(e) => result.branches.push(StaleBranchItem {
                branch,
                deleted: false,
                deletable: true,
                reason: format!("删除失败：{e}"),
            }),
        }
    }
    result
}

fn prune_stale_branches_blocking(
    project_path: &str,
    selected: &[String],
    dry_run: bool,
) -> Result<Vec<StaleBranchRepoResult>, String> {
    // 默认分支名只在配置里（可空），用于保护骨干分支不被清理。
    let default_branch = crate::config::read_project_config(project_path.to_string())
        .map(|c| c.build.default_branch)
        .unwrap_or_default();
    let mut out = Vec::new();
    for repo in discover_repos_blocking(project_path)? {
        if !selected.iter().any(|s| s == &repo.name) {
            continue;
        }
        out.push(prune_repo_stale_branches(&repo, &default_branch, dry_run));
    }
    Ok(out)
}

/// 清理「远端已不存在的本地分支」（勾选的仓库）。
/// `dry_run = true` 只扫描并列候选，供前端展示确认；`false` 才真正删除。
/// 只删提交已合入远端分支的本地分支——有未提交内容 / 未合并的本地分支永远只报跳过。
#[tauri::command]
pub async fn build_prune_stale_branches(
    project_path: String,
    selected: Vec<String>,
    dry_run: bool,
) -> Result<Vec<StaleBranchRepoResult>, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        prune_stale_branches_blocking(&project_path, &selected, dry_run)
    })
    .await
    .map_err(|e| format!("build_prune_stale_branches panicked: {e}"))?
}

fn build_state_path(project_path: &str) -> Result<PathBuf, String> {
    Ok(Path::new(project_path)
        .join(".nezha")
        .join("build-state.json"))
}

#[tauri::command]
pub fn read_build_state(project_path: String) -> Result<BuildState, String> {
    validate_project_path(&project_path)?;
    let p = build_state_path(&project_path)?;
    if !p.exists() {
        return Ok(BuildState::default());
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_build_state(project_path: String, state: BuildState) -> Result<(), String> {
    validate_project_path(&project_path)?;
    let p = build_state_path(&project_path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&p, &raw)
}

/// 立即用当前所有仓库 HEAD 刷新增量基线（无需先跑一次成功的 `run_build`）。
/// 用于：Agent 修复任务 / 外部全量构建之后，让下次「增量」能直接基于当前代码 diff。
/// 复刻 `run_build` 成功回调的写基线路，返回刷新后的 `BuildState` 供前端直接更新 UI。
#[tauri::command]
pub async fn refresh_build_state(project_path: String) -> Result<BuildState, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repos = discover_repos_blocking(&project_path)?;
        let mut state = read_build_state_blocking(&project_path);
        for r in &repos {
            if r.missing {
                continue;
            }
            if let Ok(sha) = git_head(&r.path) {
                state.last_built.insert(r.name.clone(), sha);
            }
        }
        state.updated_at = Some(now_iso());
        write_build_state_blocking(&project_path, &state)?;
        Ok(state)
    })
    .await
    .map_err(|e| format!("refresh_build_state panicked: {e}"))?
}

/// 读取 ps1 生成的 `Log/build-plan.json`（环境检查 + 阶段计划 + 外部依赖清单）。
#[tauri::command]
pub fn read_build_plan(project_path: String) -> Result<Option<serde_json::Value>, String> {
    validate_project_path(&project_path)?;
    let plan = Path::new(&project_path).join("Log").join("build-plan.json");
    if !plan.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&plan).map_err(|e| e.to_string())?;
    // ps1 用 Out-File -Encoding utf8 会在文件头加 BOM，serde_json 不接受，先去掉
    let raw = raw.trim_start_matches('\u{feff}');
    // 空文件 / 解析失败不当作错误：前端仅少展示计划，不因此让整面板失败。
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => Ok(Some(v)),
        Err(_) => Ok(None),
    }
}

fn build_fix_status_path(project_path: &str) -> Result<PathBuf, String> {
    Ok(Path::new(project_path)
        .join(".nezha")
        .join("build-fix-status.json"))
}

/// 读取「已修复完成」的项目名列表（agent 修完会写入，用户可手动勾选）。
#[tauri::command]
pub fn read_build_fix_status(project_path: String) -> Result<Vec<String>, String> {
    validate_project_path(&project_path)?;
    let p = build_fix_status_path(&project_path)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    match serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}')) {
        Ok(v) => Ok(v
            .get("fixed")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()),
        Err(_) => Ok(vec![]),
    }
}

#[tauri::command]
pub fn write_build_fix_status(project_path: String, fixed: Vec<String>) -> Result<(), String> {
    validate_project_path(&project_path)?;
    let p = build_fix_status_path(&project_path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let obj = serde_json::json!({ "fixed": fixed });
    let raw = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&p, &raw)
}

/// 把错误信息文本写入项目的 Log/build-errors.txt，返回文件路径。
#[tauri::command]
pub fn export_build_errors(project_path: String, content: String) -> Result<String, String> {
    validate_project_path(&project_path)?;
    let log_dir = Path::new(&project_path).join("Log");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let path = log_dir.join("build-errors.txt");
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
pub struct BuildOutputProgress {
    pub done: u32,
    pub total: u32,
}

/// 定时读取共享输出目录：统计「本轮构建（mtime 晚于 since_ms）新产出」的 dll 数，
/// 用更细的粒度反映实时进度（dll 写到哪进度就到哪）。
#[tauri::command]
pub async fn read_build_output_progress(
    project_path: String,
    since_ms: i64,
) -> Result<BuildOutputProgress, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let plan_path = Path::new(&project_path).join("Log").join("build-plan.json");
        // 构建 ps1 可能正在重写 build-plan.json，读到空/坏文件时重试几次
        let mut v: Option<serde_json::Value> = None;
        for _ in 0..4 {
            if let Ok(raw) = std::fs::read_to_string(&plan_path) {
                if let Ok(parsed) =
                    serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}'))
                {
                    v = Some(parsed);
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        let Some(v) = v else {
            return Ok(BuildOutputProgress { done: 0, total: 0 });
        };
        let ext_dir = v
            .get("ExternalDllDir")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .or_else(|| {
                crate::config::read_project_config(project_path.clone())
                    .ok()
                    .map(|c| c.build.external_dll_dir)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_default();
        if ext_dir.is_empty() {
            return Ok(BuildOutputProgress { done: 0, total: 0 });
        }
        let assemblies = v
            .get("Projects")
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|proj| {
                        proj.get("Assembly")
                            .and_then(|a| a.as_str())
                            .map(str::to_string)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let total = assemblies.len() as u32;
        let mut done = 0u32;
        for a in &assemblies {
            let dll = Path::new(&ext_dir).join(format!("{a}.dll"));
            if let Ok(meta) = std::fs::metadata(&dll) {
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                        if (dur.as_millis() as i64) >= since_ms {
                            done += 1;
                        }
                    }
                }
            }
        }
        Ok(BuildOutputProgress { done, total })
    })
    .await
    .map_err(|e| format!("read_build_output_progress panicked: {e}"))?
}

/// 解析 ps1 脚本路径：先配置覆盖，再 HIS 本地，再 SkillHub 克隆。
fn resolve_script_path(project_path: &str, cfg: &BuildConfig) -> Result<PathBuf, String> {
    if !cfg.script_path.is_empty() {
        let p = PathBuf::from(&cfg.script_path);
        if p.exists() {
            return Ok(p);
        }
        return Err(format!("script_path 不存在: {}", p.to_string_lossy()));
    }
    let local = Path::new(project_path)
        .join(".agents")
        .join("skills")
        .join("hsp-build-order")
        .join("scripts")
        .join("hsp-build-order.ps1");
    if local.exists() {
        return Ok(local);
    }
    if let Some(home) = crate::platform::home_dir() {
        let skill_repos = home.join(".nezha").join("skill_repos");
        if let Ok(rd) = std::fs::read_dir(&skill_repos) {
            for e in rd.flatten() {
                let cand = e
                    .path()
                    .join("hsp-build-order")
                    .join("scripts")
                    .join("hsp-build-order.ps1");
                if cand.exists() {
                    return Ok(cand);
                }
            }
        }
    }
    Err("找不到 hsp-build-order.ps1，请在构建配置里填写 script_path".to_string())
}

/// 启动构建：以流式方式跑 `hsp-build-order.ps1`，输出通过 `Channel` 直投前端。
/// 返回 build_id（前端可据此取消）；后台任务结束时在成功时更新构建基准 commit。
#[tauri::command]
pub async fn run_build(
    project_path: String,
    options: RunBuildOptions,
    on_output: Channel<String>,
) -> Result<String, String> {
    validate_project_path(&project_path)?;
    let cfg = crate::config::read_project_config(project_path.clone())?.build;
    let script = resolve_script_path(&project_path, &cfg)?;

    let mut cmd = tokio::process::Command::new("powershell.exe");
    crate::subprocess::configure_background_tokio_command(&mut cmd);
    cmd.arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg("-Root")
        .arg(&project_path)
        .arg("-PlanJson");
    if options.continue_on_error {
        cmd.arg("-Continue");
    }
    if options.skip_external_check {
        cmd.arg("-SkipExternalCheck");
    }
    if options.skip_restore {
        cmd.arg("-SkipRestore");
    }
    if options.skip_clean {
        cmd.arg("-SkipClean");
    }
    if !options.include.is_empty() {
        let inc = options.include.join(",");
        cmd.arg("-IncludeProjects").arg(inc);
    }
    if !cfg.msbuild_path.is_empty() {
        cmd.arg("-MsbuildPath").arg(&cfg.msbuild_path);
    }
    if !options.external_dll_dir.is_empty() {
        cmd.arg("-ExternalDllDir").arg(&options.external_dll_dir);
    } else if !cfg.external_dll_dir.is_empty() {
        cmd.arg("-ExternalDllDir").arg(&cfg.external_dll_dir);
    }
    if !cfg.solution.is_empty() {
        cmd.arg("-Solution").arg(&cfg.solution);
    }
    if !cfg.configuration.is_empty() {
        cmd.arg("-Configuration").arg(&cfg.configuration);
    }
    if !cfg.platform.is_empty() {
        cmd.arg("-Platform").arg(&cfg.platform);
    }
    if !options.selected.is_empty() {
        cmd.arg("-SelectedRepos").arg(options.selected.join(","));
    }
    let max_parallel = cfg.max_parallel.clamp(1, 8);
    cmd.arg("-MaxParallel").arg(max_parallel.to_string());
    cmd.current_dir(&project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn powershell failed: {e}"))?;
    let pid = child.id();
    let build_id = uuid::Uuid::new_v4().to_string();
    if let Some(pid) = pid {
        running_builds()
            .lock()
            .unwrap()
            .insert(build_id.clone(), pid);
    }

    let task_id = build_id.clone();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output = on_output.clone();
    tauri::async_runtime::spawn(async move {
        let mut pump_handle = None;
        if let Some(out) = stdout {
            let ch = output.clone();
            pump_handle = Some(tauri::async_runtime::spawn(async move {
                pump_pipe(out, ch).await;
            }));
        }
        let mut pump_err = None;
        if let Some(err) = stderr {
            let ch = output.clone();
            pump_err = Some(tauri::async_runtime::spawn(async move {
                pump_pipe(err, ch).await;
            }));
        }

        let status = child.wait().await;
        if let Some(h) = pump_handle {
            let _ = h.await;
        }
        if let Some(h) = pump_err {
            let _ = h.await;
        }

        running_builds().lock().unwrap().remove(&task_id);

        let exit_code = status
            .as_ref()
            .map(|s| s.code().unwrap_or(-1))
            .unwrap_or(-1);
        let _ = output.send(format!("\n@@NEZHA_BUILD_DONE@@ exit={}\n", exit_code));

        // 成功时才刷新基准 commit（下一轮增量 diff 以此为基线）。
        if matches!(status, Ok(s) if s.success()) {
            let project = project_path.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Ok(repos) = discover_repos_blocking(&project) {
                    let mut state = read_build_state_blocking(&project);
                    for r in repos {
                        if let Ok(sha) = git_head(&r.path) {
                            state.last_built.insert(r.name, sha);
                        }
                    }
                    state.updated_at = Some(now_iso());
                    let _ = write_build_state_blocking(&project, &state);
                }
            })
            .await;
        }
    });

    Ok(build_id)
}

/// 仅分析（`-DryRun -PlanJson`）：不编译，只生成 `Log/build-plan.json` 供面板可视化。
/// 返回脚本输出尾部；失败时返回错误文本。
#[tauri::command]
pub async fn analyze_build(
    project_path: String,
    options: RunBuildOptions,
) -> Result<String, String> {
    validate_project_path(&project_path)?;
    let cfg = crate::config::read_project_config(project_path.clone())?.build;
    let script = resolve_script_path(&project_path, &cfg)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("powershell.exe");
        crate::subprocess::configure_background_command(&mut cmd);
        cmd.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script)
            .arg("-Root")
            .arg(&project_path)
            .arg("-DryRun")
            .arg("-PlanJson")
            .arg("-SkipExternalCheck");
        // DryRun 分析始终跳过外部缺失阻断，只看计划与依赖。
        if options.skip_restore {
            cmd.arg("-SkipRestore");
        }
        if options.skip_clean {
            cmd.arg("-SkipClean");
        }
        if !cfg.msbuild_path.is_empty() {
            cmd.arg("-MsbuildPath").arg(&cfg.msbuild_path);
        }
        if !cfg.external_dll_dir.is_empty() {
            cmd.arg("-ExternalDllDir").arg(&cfg.external_dll_dir);
        }
        if !cfg.solution.is_empty() {
            cmd.arg("-Solution").arg(&cfg.solution);
        }
        if !cfg.configuration.is_empty() {
            cmd.arg("-Configuration").arg(&cfg.configuration);
        }
        if !cfg.platform.is_empty() {
            cmd.arg("-Platform").arg(&cfg.platform);
        }
        if !options.selected.is_empty() {
            cmd.arg("-SelectedRepos").arg(options.selected.join(","));
        }
        cmd.current_dir(&project_path);
        let out = cmd.output().map_err(|e| format!("analyze failed: {e}"))?;
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if !out.status.success() {
            return Err(combined.trim().to_string());
        }
        Ok(combined.trim().to_string())
    })
    .await
    .map_err(|e| format!("analyze_build panicked: {e}"))?
}

/// 用 headless AI 分析构建失败日志，给出可执行的修复建议。
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct IncrementalPlan {
    #[serde(default)]
    projects: Vec<IncrementalProject>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct IncrementalProject {
    path: String,
    name: String,
    #[serde(default)]
    dependents: Vec<String>,
}

/// 计算增量编译的 include 集合：以 build-state 的 last_built 为基准，对勾选仓库做
/// git diff → 变更文件映射到所属项目。
///
/// 默认**只返回变更文件直接命中的工程**，不扩散反向依赖闭包。原因：本解决方案的工程之间
/// 用 HintPath 引用共享输出目录里的 dll（不是 ProjectReference），MSBuild 不会因为被引用
/// 的 dll 更新而重编依赖方；把反向依赖闭包一起塞进 include，会把实测 4 个变更工程放大成
/// 100+ 个工程，每次「增量」都要几十分钟，等于没有增量。改了公共 API 导致的依赖方编译错误
/// 交给「仅失败 / 修复任务」兜底。
///
/// `include_dependents` 为 true 时恢复旧的闭包语义（变更工程 + 全部反向依赖方）。
#[tauri::command]
pub async fn compute_incremental_include(
    project_path: String,
    selected: Vec<String>,
    include_dependents: Option<bool>,
) -> Result<Vec<String>, String> {
    validate_project_path(&project_path)?;
    let include_dependents = include_dependents.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        compute_incremental_blocking(&project_path, &selected, include_dependents)
    })
    .await
    .map_err(|e| format!("compute_incremental_include panicked: {e}"))?
}

/// 相对当前基线收集「git 修改的内容」。以基线 commit 为基准对比工作区（`git diff <base>`），
/// 因此同时覆盖：基线之后的新提交、已暂存、以及未暂存的本地修改——只比 `base..HEAD` 会漏掉
/// 未提交的改动，而那恰恰是增量构建最常见的触发场景。另外把未跟踪文件（新建、尚未 `git add`
/// 的源码）也算进来。
fn git_changed_files(dir: &str, base: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    if let Ok(out) = run_git_in(dir, &["diff", base, "--name-only"]) {
        if out.status.success() {
            for l in String::from_utf8_lossy(&out.stdout).lines() {
                let l = l.trim();
                if !l.is_empty() {
                    files.push(l.to_string());
                }
            }
        }
    }
    if let Ok(out) = run_git_in(dir, &["ls-files", "--others", "--exclude-standard"]) {
        if out.status.success() {
            for l in String::from_utf8_lossy(&out.stdout).lines() {
                let l = l.trim();
                if !l.is_empty() {
                    files.push(l.to_string());
                }
            }
        }
    }
    files
}

/// 子模块 gitlink 路径（`git ls-files -s` 中 mode=160000 的条目）。主仓库的 diff 会把子模块
/// 指针变更列成一个普通路径（如 `Nto.Emr`），若不剔除，会被误映射到根目录下的首个工程。
/// 子模块自身的改动由 `discover_repos_blocking` 单独发现、单独 diff，不会漏。
fn git_submodule_paths(dir: &str) -> Vec<String> {
    let out = match run_git_in(dir, &["ls-files", "-s"]) {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut parts = l.splitn(2, '\t');
            let mode = parts.next()?.split_whitespace().next()?;
            let path = parts.next()?;
            if mode == "160000" {
                Some(path.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// `rel` 是否落在某个子模块目录内（本身或其后代）。
fn is_submodule_path(rel: &str, submodules: &[String]) -> bool {
    let rel = rel.replace('\\', "/");
    submodules.iter().any(|s| {
        let s = s.replace('\\', "/");
        rel == s || rel.starts_with(&format!("{s}/"))
    })
}

fn compute_incremental_blocking(
    project_path: &str,
    selected: &[String],
    include_dependents: bool,
) -> Result<Vec<String>, String> {
    let repos = discover_repos_blocking(project_path)?;
    let state = read_build_state_blocking(project_path);

    // 1) 汇总变更文件（绝对路径）
    let mut changed_abs: Vec<String> = Vec::new();
    let mut had_baseline = false;
    for r in &repos {
        if !selected.iter().any(|s| s == &r.name) {
            continue;
        }
        if r.missing {
            continue;
        }
        let Some(base) = state.last_built.get(&r.name) else {
            continue;
        };
        if base.is_empty() {
            continue;
        }
        had_baseline = true;
        let submodules = git_submodule_paths(&r.path);
        for rel in git_changed_files(&r.path, base) {
            if is_submodule_path(&rel, &submodules) {
                continue;
            }
            changed_abs.push(format!("{}/{}", r.path, rel));
        }
    }
    if changed_abs.is_empty() {
        if !had_baseline {
            return Err(
                "缺少构建基线（.nezha/build-state.json），无法进行增量编译；请先执行「全量构建」或点「刷新基线」建立基线。".to_string(),
            );
        }
        return Err(
            "自上次构建基线以来未检测到变更，无需增量编译；若确认有改动，请检查仓库/分支选择是否正确。"
                .to_string(),
        );
    }

    // 2) 读计划（含反向依赖）
    let plan_path = Path::new(project_path).join("Log").join("build-plan.json");
    if !plan_path.exists() {
        return Err("缺少 build-plan.json，请先执行「分析/计划」".to_string());
    }
    let raw = std::fs::read_to_string(&plan_path).map_err(|e| e.to_string())?;
    let plan: IncrementalPlan = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    // 3) 变更文件 → 所属项目（取最深匹配目录）
    let mut changed_projects: Vec<String> = Vec::new();
    for cp in &changed_abs {
        let mut best: Option<(usize, &IncrementalProject)> = None;
        for p in &plan.projects {
            let Some(parent) = Path::new(&p.path).parent() else {
                continue;
            };
            let dir = normalize_path(&parent.to_string_lossy());
            if path_starts_with(cp, &dir) {
                let len = dir.len();
                if best.as_ref().map(|(l, _)| len > *l).unwrap_or(true) {
                    best = Some((len, p));
                }
            }
        }
        if let Some((_, p)) = best {
            if !changed_projects.contains(&p.name) {
                changed_projects.push(p.name.clone());
            }
        }
    }
    if changed_projects.is_empty() {
        return Err("无法把变更文件映射到工程".to_string());
    }

    // 默认只编变更工程，不做反向依赖扩散（见函数上方说明）。
    if !include_dependents {
        return Ok(changed_projects);
    }

    // 4) 反向依赖闭包（仅在 include_dependents 时启用）
    let mut name_deps: HashMap<String, Vec<String>> = HashMap::new();
    for p in &plan.projects {
        name_deps.insert(p.name.clone(), p.dependents.clone());
    }
    let mut include: Vec<String> = changed_projects.clone();
    let mut seen: std::collections::HashSet<String> = changed_projects.iter().cloned().collect();
    let mut queue: Vec<String> = changed_projects.clone();
    while let Some(n) = queue.pop() {
        let deps = name_deps.get(&n).cloned().unwrap_or_default();
        for d in deps {
            if seen.insert(d.clone()) {
                include.push(d.clone());
                queue.push(d);
            }
        }
    }
    Ok(include)
}

fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
}

fn path_starts_with(child: &str, dir: &str) -> bool {
    let c = normalize_path(child);
    let d = normalize_path(dir);
    if c.eq_ignore_ascii_case(&d) {
        return true;
    }
    let lower_c = c.to_lowercase();
    let lower_d = d.to_lowercase();
    lower_c.starts_with(&format!("{}/", lower_d))
}

async fn pump_pipe<R: tokio::io::AsyncRead + Unpin>(mut r: R, sink: Channel<String>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
        if buf.len() >= 4 * 1024 {
            let s = String::from_utf8_lossy(&buf).into_owned();
            let _ = sink.send(s);
            buf.clear();
        }
    }
    if !buf.is_empty() {
        let s = String::from_utf8_lossy(&buf).into_owned();
        let _ = sink.send(s);
    }
}

fn now_iso() -> String {
    use chrono::Utc;
    Utc::now().to_rfc3339()
}

fn read_build_state_blocking(project_path: &str) -> BuildState {
    let p = build_state_path(project_path).unwrap_or_else(|_| PathBuf::from(""));
    if p.exists() {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str::<BuildState>(&raw) {
                return s;
            }
        }
    }
    BuildState::default()
}

fn write_build_state_blocking(project_path: &str, state: &BuildState) -> Result<(), String> {
    let p = build_state_path(project_path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&p, &raw)
}

/// 取消构建：Windows 用 `taskkill /T /F` 清整棵进程树（powershell + MSBuild + dotnet restore），
/// 避免孤儿进程占用共享输出目录锁。等价于 Job Object 的一次性整树清理。
#[tauri::command]
pub fn cancel_build(build_id: String) -> Result<(), String> {
    let pid = running_builds()
        .lock()
        .unwrap()
        .remove(&build_id)
        .ok_or_else(|| "build not running".to_string())?;
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("taskkill");
        crate::subprocess::configure_background_command(&mut cmd);
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let out = cmd.output().map_err(|e| format!("taskkill failed: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 非 Windows：kill 进程组（构建脚本为 powershell，其子进程默认同组）。
        let mut cmd = std::process::Command::new("kill");
        cmd.args(["-9", &pid.to_string()]);
        let _ = cmd.output();
    }
    Ok(())
}

/// 当前正在运行的构建 id 列表（供面板恢复状态）。
#[tauri::command]
pub fn get_running_builds() -> Result<Vec<String>, String> {
    Ok(running_builds().lock().unwrap().keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::Command;

    use super::*;

    struct TempRepo {
        path: PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("nezha-build-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            let out = Command::new("git").arg("init").arg(&path).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            for (k, v) in [("user.email", "test@test.test"), ("user.name", "test")] {
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

        /// 仓库名：与 `discover_repos_blocking` 对主仓库的命名一致（目录名）。
        fn name(&self) -> String {
            self.path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap()
        }

        fn head(&self) -> String {
            let o = Command::new("git")
                .arg("-C")
                .arg(&self.path)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }

        /// 写 `.nezha/build-state.json`（基线）与 `Log/build-plan.json`。
        /// `projects`：工程目录名 → 其反向依赖方（Dependents）名字列表。
        fn write_plan_and_state(&self, base: &str, projects: &[(&str, &[&str])]) {
            let nezha = self.path.join(".nezha");
            std::fs::create_dir_all(&nezha).unwrap();
            std::fs::write(
                nezha.join("build-state.json"),
                format!("{{\"last_built\":{{\"{}\":\"{base}\"}}}}", self.name()),
            )
            .unwrap();
            let log = self.path.join("Log");
            std::fs::create_dir_all(&log).unwrap();
            let entries: Vec<String> = projects
                .iter()
                .map(|(pname, deps)| {
                    let path = self.path.join(pname).join(format!("{pname}.csproj"));
                    let deps_json: Vec<String> =
                        deps.iter().map(|d| format!("\"{d}\"")).collect();
                    format!(
                        "{{\"Path\":\"{}\",\"Name\":\"{pname}\",\"Dependents\":[{}]}}",
                        path.to_string_lossy().replace('\\', "\\\\"),
                        deps_json.join(",")
                    )
                })
                .collect();
            std::fs::write(
                log.join("build-plan.json"),
                format!("{{\"Projects\":[{}]}}", entries.join(",")),
            )
            .unwrap();
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // 未跟踪（未纳入 Git）的内容不应当把仓库判脏：`git pull --ff-only` 不会被它们阻断。
    #[test]
    fn git_dirty_ignores_untracked_files() {
        let repo = TempRepo::new();
        std::fs::write(repo.path.join("tracked.txt"), "hello").unwrap();
        repo.git(&["add", "tracked.txt"]);
        repo.git(&["commit", "-m", "init"]);

        // 只加一个未跟踪文件（本地生成物，不在 Git 上）
        std::fs::write(repo.path.join("local-only.txt"), "not on git").unwrap();

        assert!(!git_dirty(repo.dir()));
    }

    // 受跟踪文件的改动/暂存改动仍会判脏——这些才可能真正阻碍快进合并。
    #[test]
    fn git_dirty_still_detects_tracked_changes() {
        let repo = TempRepo::new();
        std::fs::write(repo.path.join("tracked.txt"), "hello").unwrap();
        repo.git(&["add", "tracked.txt"]);
        repo.git(&["commit", "-m", "init"]);

        // 修改受跟踪文件
        std::fs::write(repo.path.join("tracked.txt"), "changed").unwrap();
        assert!(git_dirty(repo.dir()));

        // 暂存后仍为脏
        repo.git(&["add", "tracked.txt"]);
        assert!(git_dirty(repo.dir()));
    }

    // 增量必须把「基线之后未提交」的本地改动算进来：只比 base..HEAD 会漏掉它，
    // 而那正是增量构建最常见的触发场景。
    #[test]
    fn incremental_detects_uncommitted_working_tree_changes() {
        let repo = TempRepo::new();
        std::fs::create_dir_all(repo.path.join("Proj")).unwrap();
        std::fs::write(repo.path.join("Proj/Proj.csproj"), "<Project/>").unwrap();
        repo.git(&["add", "."]);
        repo.git(&["commit", "-m", "init"]);
        repo.write_plan_and_state(&repo.head(), &[("Proj", &[])]);

        // 未提交、未暂存的改动
        std::fs::write(repo.path.join("Proj/File.cs"), "class C {}").unwrap();

        let inc =
            compute_incremental_blocking(repo.dir(), &[repo.name()], false).unwrap();
        assert_eq!(inc, vec!["Proj".to_string()]);
    }

    // 默认只编变更工程；只有显式 include_dependents 才扩散反向依赖闭包。
    #[test]
    fn incremental_closure_is_opt_in() {
        let repo = TempRepo::new();
        for p in ["A", "B"] {
            std::fs::create_dir_all(repo.path.join(p)).unwrap();
            std::fs::write(repo.path.join(p).join(format!("{p}.csproj")), "<Project/>")
                .unwrap();
        }
        repo.git(&["add", "."]);
        repo.git(&["commit", "-m", "init"]);
        // A 的反向依赖方是 B：改了 A，闭包应把 B 也带上。
        repo.write_plan_and_state(&repo.head(), &[("A", &["B"]), ("B", &[])]);

        std::fs::write(repo.path.join("A/File.cs"), "class A {}").unwrap();

        let only_changed =
            compute_incremental_blocking(repo.dir(), &[repo.name()], false).unwrap();
        assert_eq!(only_changed, vec!["A".to_string()]);

        let with_deps =
            compute_incremental_blocking(repo.dir(), &[repo.name()], true).unwrap();
        assert!(with_deps.contains(&"A".to_string()));
        assert!(with_deps.contains(&"B".to_string()));
    }

    // 主仓库 diff 里的子模块 gitlink（如 `Nto.Emr`）不应被误映射到同前缀的普通工程。
    #[test]
    fn submodule_gitlink_paths_are_filtered() {
        let subs = vec!["Nto.Emr".to_string(), "Nto.His/Term".to_string()];
        assert!(is_submodule_path("Nto.Emr", &subs));
        assert!(is_submodule_path("Nto.Emr\\x.cs", &subs));
        assert!(is_submodule_path("Nto.His/Term/foo.cs", &subs));
        assert!(!is_submodule_path("Nto.Emr2", &subs));
        assert!(!is_submodule_path("Nto.His/DrugInOut", &subs));
    }

    // 构建面板的「可选子仓库」白名单：缺省必须含 Hsp.Win；显式空数组表示不限制
    // （前端据此展示全部子模块），因此不能把「缺失」与「空」混为一谈。
    #[test]
    fn visible_subrepos_default_includes_hsp_win_and_empty_means_unrestricted() {
        assert!(default_visible_subrepos().iter().any(|s| s == "Hsp.Win"));
        assert_eq!(BuildConfig::default().visible_subrepos, default_visible_subrepos());

        // 配置里缺该字段（老配置文件）→ 落到默认白名单
        let legacy: BuildConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.visible_subrepos, default_visible_subrepos());

        // 显式空数组 → 保持为空（前端不过滤）
        let unrestricted: BuildConfig =
            serde_json::from_str("{\"visible_subrepos\":[]}").unwrap();
        assert!(unrestricted.visible_subrepos.is_empty());
    }

    // 轻量列举（只读 .gitmodules）必须与完整 discover 用同一套子模块命名口径——
    // 设置页的下拉值就是这些名字，构建面板按名字匹配白名单，两者不一致会「勾了不生效」。
    #[test]
    fn list_subrepos_names_match_gitmodules_entries() {
        let repo = TempRepo::new();
        std::fs::create_dir_all(repo.path.join("Nto.His/Nto.His.Term")).unwrap();
        std::fs::write(
            repo.path.join(".gitmodules"),
            "[submodule \"Hsp.Win\"]\n\tpath = Hsp.Win\n\turl = git@example.com:Hsp_Main.git\n\
             [submodule \"Nto.His/Nto.His.Term\"]\n\tpath = Nto.His/Nto.His.Term\n\turl = git@example.com:Term.git\n",
        )
        .unwrap();

        let subs = list_subrepos_blocking(repo.dir()).unwrap();
        let names: Vec<&str> = subs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["Hsp.Win", "Nto.His/Nto.His.Term"]);
        // 路径是「项目根 + 相对路径」，下拉的 tooltip 用它区分同名子仓库。
        assert!(subs[0].path.replace('\\', "/").ends_with("/Hsp.Win"));
        assert!(subs[1].path.replace('\\', "/").ends_with("/Nto.His/Nto.His.Term"));
    }

    // 没有 .gitmodules 的项目应返回空列表，而不是报错（设置页据此展示空态）。
    #[test]
    fn list_subrepos_is_empty_without_gitmodules() {
        let repo = TempRepo::new();
        assert!(list_subrepos_blocking(repo.dir()).unwrap().is_empty());
    }

    /// 临时 bare 远端仓库（Drop 时删除）。
    struct TempBareRemote {
        path: PathBuf,
    }

    impl TempBareRemote {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("nezha-build-origin-{}", uuid::Uuid::new_v4()));
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

    /// 建好「本地仓库 + 本地 bare origin」并推送初始提交，返回（本地仓库, 远端, 初始分支名）。
    fn repo_with_origin() -> (TempRepo, TempBareRemote, String) {
        let repo = TempRepo::new();
        let origin = TempBareRemote::new();
        std::fs::write(repo.path.join("tracked.txt"), "hello").unwrap();
        repo.git(&["add", "tracked.txt"]);
        repo.git(&["commit", "-m", "init"]);
        repo.git(&["remote", "add", "origin", origin.dir()]);
        repo.git(&["push", "-u", "origin", "HEAD"]);
        let base = git_branch(repo.dir());
        (repo, origin, base)
    }

    /// 本地提交并推送到远端分支 `name`。
    fn commit_and_push(repo: &TempRepo, branch: &str, file: &str) {
        repo.git(&["checkout", "-b", branch]);
        std::fs::write(repo.path.join(file), file).unwrap();
        repo.git(&["add", file]);
        repo.git(&["commit", "-m", branch]);
        repo.git(&["push", "-u", "origin", branch]);
    }

    // 只清理「远端已删除 + 提交已存在于远端」的本地分支：
    //   1. 合并到当前分支并推走的 → 删；
    //   2. 只合入远端另一条分支（HEAD 线上没有）→ 也要删（Git `-d` 会误报，需要兜底）；
    //   3. 本地还有未推送提交的 → 一律只报跳过，绝不删。
    #[test]
    fn prune_stale_branches_only_deletes_content_preserved_remotely() {
        let (repo, _origin, base) = repo_with_origin();

        // 1) 已合入当前分支（远端该线已包含它的提交），远端删掉同名分支
        commit_and_push(&repo, "fix/merged", "merged.txt");
        repo.git(&["checkout", &base]);
        repo.git(&["merge", "--no-edit", "fix/merged"]);
        repo.git(&["push", "origin", &base]);
        repo.git(&["push", "origin", "--delete", "fix/merged"]);

        // 2) 已合入远端另一条分支，而当前 HEAD 线上没有它的提交
        commit_and_push(&repo, "release", "release.txt");
        commit_and_push(&repo, "fix/landed", "landed.txt");
        repo.git(&["checkout", "release"]);
        repo.git(&["merge", "--no-edit", "fix/landed"]);
        repo.git(&["push", "origin", "release"]);
        repo.git(&["push", "origin", "--delete", "fix/landed"]);
        repo.git(&["checkout", &base]);

        // 3) 只有本地提交、远端从未有过同名分支，内容也不在任何远端分支上
        repo.git(&["checkout", "-b", "fix/unmerged"]);
        std::fs::write(repo.path.join("unmerged.txt"), "unmerged").unwrap();
        repo.git(&["add", "unmerged.txt"]);
        repo.git(&["commit", "-m", "unmerged work"]);
        repo.git(&["checkout", &base]);

        // dry-run：只判定，不动分支
        let scan = prune_stale_branches_blocking(repo.dir(), &[repo.name()], true).unwrap();
        assert_eq!(scan.len(), 1, "只有主仓库参与扫描");
        let scan_repo = &scan[0];
        assert!(scan_repo.ok, "{}", scan_repo.message);
        let item = |name: &str| {
            scan_repo
                .branches
                .iter()
                .find(|b| b.branch == name)
                .unwrap_or_else(|| panic!("缺少分支明细: {name}"))
        };
        assert!(item("fix/merged").deletable);
        assert!(item("fix/landed").deletable);
        assert!(!item("fix/unmerged").deletable);
        assert!(!item("fix/merged").deleted, "dry-run 不得真删");
        assert!(git_branches(repo.dir()).contains(&"fix/merged".to_string()));

        // 执行：只删前两个
        let done = prune_stale_branches_blocking(repo.dir(), &[repo.name()], false).unwrap();
        let done_repo = &done[0];
        let deleted: Vec<&str> = done_repo
            .branches
            .iter()
            .filter(|b| b.deleted)
            .map(|b| b.branch.as_str())
            .collect();
        assert!(deleted.contains(&"fix/merged"));
        assert!(deleted.contains(&"fix/landed"));
        assert!(!deleted.contains(&"fix/unmerged"));

        let left = git_branches(repo.dir());
        assert!(!left.contains(&"fix/merged".to_string()));
        assert!(!left.contains(&"fix/landed".to_string()));
        assert!(left.contains(&"fix/unmerged".to_string()));
        assert!(left.contains(&base));
    }

    // 远端仍存在的分支不是「失效分支」，不得进入清理候选（哪怕本地未合并）。
    #[test]
    fn prune_stale_branches_ignores_branches_still_on_remote() {
        let (repo, _origin, base) = repo_with_origin();
        commit_and_push(&repo, "fix/alive", "alive.txt");
        repo.git(&["checkout", &base]);

        let scan = prune_stale_branches_blocking(repo.dir(), &[repo.name()], true).unwrap();
        assert!(
            scan[0].branches.iter().all(|b| b.branch != "fix/alive"),
            "远端仍存在的分支不应出现在清理明细里"
        );
    }
}
