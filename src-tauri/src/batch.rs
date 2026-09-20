//! 分支批（Branch Batch）管理：一个批 = 一个可独立验收的 PR，
//! 对应一个分支 + 一个 worktree，批内议题任务顺序共用该工作区。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::git::{
    branch_unmerged_count, local_branch_exists, path_to_string, remote_branch_exists,
    remote_branch_unmerged_count, resolve_repo_path, run_git, worktree_base_dir,
    worktree_dirty_reason,
};
use crate::storage::{load_project_batches, load_project_tasks, save_project_batches, Batch};

const VALID_KINDS: &[&str] = &["feature", "fix", "patch", "project", "hotfix"];

/// 仅 hotfix 是“只挑拣、不开发、不向上合并”的补丁容器，其余类型都可合并到目标分支。
pub(crate) fn merge_allows_kind(kind: &str) -> bool {
    !kind.eq_ignore_ascii_case("hotfix")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 把用户输入的分支名清洗成合法的 slug：小写、非字母数字 → '-',折叠重复分隔符。
fn sanitize_branch_slug(input: &str) -> String {
    let mut out = String::new();
    let mut prev_sep = false;
    for ch in input.trim().to_lowercase().chars() {
        // 保留 Unicode 字母/数字（含中文）与 - _ .；git 禁制 ".." 与非开头/结尾的点。
        if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
            prev_sep = false;
        } else if ch == '.' {
            if !out.ends_with('.') {
                out.push('.');
            }
            prev_sep = false;
        } else if !prev_sep && !out.is_empty() {
            out.push('-');
            prev_sep = true;
        }
    }
    let out = out
        .trim_matches('-')
        .trim_matches('_')
        .trim_matches('.')
        .to_string();
    if out.is_empty() {
        "batch".to_string()
    } else {
        out
    }
}

/// 版本段判据：`v`/`V` 开头且紧跟数字（如 `v2.20260901` / `v20260501.41`）。
///
/// 生成的版本段必须满足它，否则「待发起」解析端（`pending_mr::is_version_like`）不会把
/// 这一段当版本跳过，目标分支段就会被错认成版本，目标推断随之失败。
fn is_version_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    matches!(chars.next(), Some('v' | 'V')) && chars.next().is_some_and(|c| c.is_ascii_digit())
}

/// 按「类型 / 版本 / 目标分支 / 批名」生成分支名。
///
/// 对齐 HIS 仓库的分支命名规范 `<type>/<版本>/<目标分支>/<简短描述>`：
/// `fix/v2.20260901/develop/锁号地址挂号异常问题`。
/// 版本段为空（或被清洗掉）时整段省略，回落 `feature/develop/<slug>`。
pub(crate) fn batch_branch_name(kind: &str, version: &str, target: &str, name: &str) -> String {
    let prefix = match kind {
        "fix" => "fix",
        "patch" => "patch",
        "project" => "project",
        "hotfix" => "hotfix",
        _ => "feature",
    };
    // sanitize_branch_slug 对空串返回 "batch"，用该哨兵值把空段整体丢掉。
    let version = sanitize_branch_slug(version);
    let target = sanitize_branch_slug(target);
    // 名过长时截断，避免分支名超 git 限制；保留足够可读前缀。
    let slug: String = sanitize_branch_slug(name).chars().take(48).collect();

    let mut out = prefix.to_string();
    if version != "batch" && is_version_segment(&version) {
        out.push('/');
        out.push_str(&version);
    }
    // 目标段恒有：target_branch 是必填项，清洗后为空说明传了空白，此时才退回省略。
    if target != "batch" {
        out.push('/');
        out.push_str(&target);
    }
    out.push('/');
    out.push_str(&slug);
    out
}

/// 分支名预览：与 `create_branch_batch` 生成逻辑同源，供对话框实时显示。
#[tauri::command]
pub fn preview_branch_batch_branch(
    kind: String,
    version: Option<String>,
    target_branch: Option<String>,
    name: String,
) -> String {
    batch_branch_name(
        kind.trim(),
        version.as_deref().unwrap_or(""),
        target_branch.as_deref().unwrap_or(""),
        &name,
    )
}

/// 创建分支批：校验入参 → 生成分支名 → 建分支（可选建 worktree）→ 落盘到 batches.json。
///
/// `use_worktree` 缺省 **false**：只在主工作区把分支切出来（`git checkout -b`），任务用
/// 「本地处理」模式在项目根跑，提交自然落在批分支上。需要并行隔离时才置 true 另建 worktree。
#[tauri::command]
pub async fn create_branch_batch(
    project_path: String,
    repo_path: Option<String>,
    project_id: String,
    id: String,
    name: String,
    kind: String,
    base_branch: String,
    target_branch: String,
    task_ids: Vec<String>,
    source_branch: Option<String>,
    use_existing_remote: bool,
    // 创建者自行选择的代码目录（worktree 落在其下的 `<目录>/<批id>`）；缺省回落配置基路径。
    worktree_dir: Option<String>,
    // 议题编号列表（commit 门禁与 MR 关联用）；多议题联合方案生成待办时传入。
    issue_serial_numbers: Option<Vec<String>>,
    // 分支名里的版本段（取自云效版本，如 `v2.20260901`）；空则不生成版本段。
    version: Option<String>,
    // 是否另建 worktree；缺省 false = 在主工作区直接切分支。
    use_worktree: Option<bool>,
) -> Result<Batch, String> {
    if id.trim().is_empty() {
        return Err("Batch id is required".to_string());
    }
    if name.trim().is_empty() {
        return Err("Batch name is required".to_string());
    }
    let kind = kind.trim().to_ascii_lowercase();
    if !VALID_KINDS.contains(&kind.as_str()) {
        return Err(format!("Unsupported branch kind: {kind}"));
    }
    if base_branch.trim().is_empty() || target_branch.trim().is_empty() {
        return Err("baseBranch and targetBranch are required".to_string());
    }
    let use_worktree = use_worktree.unwrap_or(false);

    let version = version.unwrap_or_default();
    let branch = source_branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| batch_branch_name(&kind, &version, target_branch.trim(), &name));
    if branch == target_branch.trim() {
        return Err("源分支不能与目标分支相同".to_string());
    }
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;

    // 分支冲突预检（live remote + local ref），把「继续使用 / 改名」的选择交给创建者。
    let remote_exists =
        remote_branch_exists(project_path.clone(), repo_path.clone(), branch.clone()).await?;
    let local_exists =
        local_branch_exists(project_path.clone(), repo_path.clone(), branch.clone()).await?;
    if local_exists {
        return Err("本地已存在同名分支，请改名后创建".to_string());
    }
    if remote_exists && !use_existing_remote {
        return Err("远端已存在同名分支，请选择「继续使用远端分支」或改名".to_string());
    }
    if !remote_exists && use_existing_remote {
        return Err("远端不存在此分支，请改名后重新创建".to_string());
    }

    // 计划路径（仅 use_worktree 时用）：创建者选的目录优先，缺省回落配置基路径 / 共享 hub / 项目内默认。
    let worktree_path = if use_worktree {
        let path = match worktree_dir
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(dir) => PathBuf::from(dir).join(&id),
            None => worktree_base_dir(&project_path, &cwd).join(&id),
        };
        if !path.is_absolute() {
            return Err("代码目录必须是绝对路径".to_string());
        }
        Some(path)
    } else {
        None
    };
    let owner_repo = repo_path.clone().or_else(|| Some(cwd.clone()));

    // 阻塞的 git 创建与文件落盘统一放到 spawn_blocking，避免占用 Tokio 运行时。
    // 建成功才落盘批次记录；git 失败就地回滚，不留半态记录。
    tokio::task::spawn_blocking(move || -> Result<Batch, String> {
        let worktree_str = if use_worktree {
            let worktree_path = worktree_path.expect("worktree path resolved when use_worktree");
            // 确保落盘父目录存在。
            if let Some(parent) = worktree_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create worktrees dir: {e}"))?;
            }
            if worktree_path.exists() {
                return Err(format!(
                    "Worktree path already exists: {}",
                    worktree_path.display()
                ));
            }
            let worktree_str = path_to_string(&worktree_path)?;
            let output = if use_existing_remote {
                let fetch = run_git(&cwd, &["fetch", "origin", &branch])?;
                if !fetch.status.success() {
                    return Err(String::from_utf8_lossy(&fetch.stderr).trim().to_string());
                }
                run_git(
                    &cwd,
                    &[
                        "worktree",
                        "add",
                        "--track",
                        "-b",
                        &branch,
                        &worktree_str,
                        &format!("origin/{branch}"),
                    ],
                )?
            } else {
                run_git(
                    &cwd,
                    &[
                        "worktree",
                        "add",
                        "-b",
                        &branch,
                        &worktree_str,
                        &base_branch,
                    ],
                )?
            };
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                // 回滚：worktree add 失败可能已创建分支 ref 或半成品目录。
                if worktree_path.is_dir() {
                    let _ = run_git(&cwd, &["worktree", "remove", "--force", &worktree_str]);
                }
                let _ = run_git(&cwd, &["worktree", "prune"]);
                let _ = run_git(&cwd, &["branch", "-D", &branch]);
                return Err(err);
            }
            Some(worktree_str)
        } else {
            // 不建 worktree：在主工作区把分支切出来，任务与提交都落在该分支上。
            let output = if use_existing_remote {
                let fetch = run_git(&cwd, &["fetch", "origin", &branch])?;
                if !fetch.status.success() {
                    return Err(String::from_utf8_lossy(&fetch.stderr).trim().to_string());
                }
                run_git(
                    &cwd,
                    &[
                        "checkout",
                        "-b",
                        &branch,
                        "--track",
                        &format!("origin/{branch}"),
                    ],
                )?
            } else {
                run_git(&cwd, &["checkout", "-b", &branch, &base_branch])?
            };
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                // 工作区脏 / 分支被占用是最常见的两类失败，给出可操作的中文提示。
                let lower = err.to_lowercase();
                if lower.contains("local changes") || lower.contains("would be overwritten") {
                    return Err(
                        "主工作区存在未提交改动，无法切换分支；请先提交或暂存后再创建".to_string(),
                    );
                }
                return Err(format!("在主工作区创建分支失败：{err}"));
            }
            None
        };

        let batch = Batch {
            id,
            project_id: project_id.clone(),
            name,
            kind,
            branch: branch.clone(),
            base_branch,
            target_branch,
            task_ids,
            status: "active".to_string(),
            created_at: now_ms(),
            closed_at: None,
            additions: None,
            deletions: None,
            issue_serial_numbers: issue_serial_numbers.unwrap_or_default(),
            mr_id: None,
            mr_status: None,
            worktree_path: worktree_str.clone(),
            // 批分支实际落在哪个 git 根（子仓库）就记录哪个，与是否另建 worktree 无关——
            // 否则无 worktree 的批后续 push / 提交 MR 时会回落到项目根，找错仓库。
            worktree_repo: owner_repo,
            use_worktree,
            mr_source_sha: None,
        };
        let mut batches = load_project_batches(project_id.clone())?;
        batches.push(batch.clone());
        save_project_batches(project_id, batches)?;
        Ok(batch)
    })
    .await
    .map_err(|e| format!("Create batch task panicked: {e}"))?
}

/// 批次视图：批次记录 + 实时探测的运行程序缺失提示（不落盘）。
#[derive(serde::Serialize, Clone)]
pub struct BatchView {
    #[serde(flatten)]
    pub batch: Batch,
    /// 未关闭批次的工作树下缺少运行程序目录（`_run`）时为 true；仅提示，不阻断操作。
    #[serde(rename = "runRootMissing")]
    pub run_root_missing: bool,
    /// 未关闭批次的 worktree 目录缺失时为 true；selector 不展示，PR 面板可提供清理入口。
    #[serde(rename = "worktreeMissing")]
    pub worktree_missing: bool,
}

/// 列出某项目的分支批。
#[tauri::command]
pub async fn list_branch_batches(
    project_id: String,
    project_path: Option<String>,
) -> Result<Vec<BatchView>, String> {
    let batches = load_project_batches(project_id)?;
    tokio::task::spawn_blocking(move || {
        Ok(batches
            .into_iter()
            .map(|b| {
                let is_open = b.status != "merged" && b.status != "closed";
                // 未启用 worktree 的批没有代码目录，「缺失」判定对它不成立（否则主工作区批次
                // 会全部被误标「WorkTree 缺失」并被 selector 隐藏）。
                let worktree_path = if b.use_worktree {
                    match b.worktree_path.as_deref() {
                        Some(path) => PathBuf::from(path),
                        None => match project_path.as_deref() {
                            Some(path) if !path.trim().is_empty() => {
                                Path::new(path).join(".nezha").join("worktrees").join(&b.id)
                            }
                            _ => PathBuf::new(),
                        },
                    }
                } else {
                    PathBuf::new()
                };
                let run_root_missing = is_open
                    && !worktree_path.as_os_str().is_empty()
                    && !worktree_path.join("_run").is_dir();
                let worktree_missing =
                    is_open && !worktree_path.as_os_str().is_empty() && !worktree_path.is_dir();
                BatchView {
                    batch: b,
                    run_root_missing,
                    worktree_missing,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| format!("List batches task panicked: {e}"))?
}

/// 获取单个分支批。
#[tauri::command]
pub fn get_branch_batch(project_id: String, batch_id: String) -> Result<Option<Batch>, String> {
    Ok(load_project_batches(project_id)?
        .into_iter()
        .find(|b| b.id == batch_id))
}

/// 关闭/合并分支批：merged=true 记为 merged，否则记为 closed，并写上 closedAt。
#[tauri::command]
pub fn close_branch_batch(
    project_id: String,
    batch_id: String,
    merged: bool,
) -> Result<Batch, String> {
    let mut batches = load_project_batches(project_id.clone())?;
    let batch = batches
        .iter_mut()
        .find(|b| b.id == batch_id)
        .ok_or_else(|| "Batch not found".to_string())?;
    batch.status = if merged { "merged" } else { "closed" }.to_string();
    batch.closed_at = Some(now_ms());
    let result = batch.clone();
    save_project_batches(project_id, batches)?;
    Ok(result)
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct MergeBatchResult {
    pub message: String,
    pub batch: Batch,
}

/// 合并分支批到目标分支（复用 worktree 合并），成功后自动关批并清理分支。
///
/// 启用 worktree 的批：合并后删除 worktree 与本地分支。
/// 未启用 worktree 的批：分支在主工作区里，先切回目标分支再删除批分支；工作区脏导致
/// 切不回去时保留分支（批已关闭，分支留待人工处理）。
#[tauri::command]
pub async fn merge_branch_batch(
    project_path: String,
    repo_path: Option<String>,
    project_id: String,
    batch_id: String,
) -> Result<MergeBatchResult, String> {
    let batch = load_project_batches(project_id.clone())?
        .into_iter()
        .find(|b| b.id == batch_id)
        .ok_or_else(|| "Batch not found".to_string())?;
    if !merge_allows_kind(&batch.kind) {
        return Err(format!(
            "批次类型 {} 是挑拣容器，不允许向上合并",
            batch.kind
        ));
    }
    let worktree_str = legacy_batch_worktree_path(&project_path, &batch_id)?;
    let effective_repo = batch.worktree_repo.clone().or(repo_path.clone());
    let message = crate::git::merge_task_worktree(
        project_path.clone(),
        effective_repo.clone(),
        worktree_str.clone(),
        batch.branch.clone(),
        batch.target_branch.clone(),
        None,
    )
    .await?;
    // 合并成功后自动关批（status = merged）。
    let closed = close_branch_batch(project_id.clone(), batch_id, true)?;
    if batch.use_worktree {
        let worktree_path = batch.worktree_path.clone().unwrap_or(worktree_str);
        let _ = crate::git::remove_task_worktree(
            project_path,
            effective_repo,
            worktree_path,
            batch.branch,
        )
        .await;
    } else {
        // 无 worktree：主工作区 HEAD 仍停在批分支上，先切回目标分支再删批分支。
        let cwd = resolve_repo_path(&project_path, effective_repo.as_deref()).await?;
        let branch = batch.branch.clone();
        let target = batch.target_branch.clone();
        tokio::task::spawn_blocking(move || {
            let _ = run_git(&cwd, &["checkout", &target]);
            let _ = run_git(&cwd, &["branch", "-D", &branch]);
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| format!("Cleanup batch branch panicked: {e}"))??;
    }
    Ok(MergeBatchResult {
        message,
        batch: closed,
    })
}

fn legacy_batch_worktree_path(project_path: &str, batch_id: &str) -> Result<String, String> {
    path_to_string(
        &Path::new(project_path)
            .join(".nezha")
            .join("worktrees")
            .join(batch_id),
    )
}

const NON_TERMINAL_TASK_STATUSES: &[&str] = &[
    "pending",
    "running",
    "input_required",
    "awaiting_review",
    "detached",
    "interrupted",
];

#[derive(serde::Serialize)]
pub struct BranchConflictCheck {
    #[serde(rename = "remoteExists")]
    pub remote_exists: bool,
    #[serde(rename = "localExists")]
    pub local_exists: bool,
}

/// 新建 PR 前检查源分支是否在远端/本地已存在（live remote，避免 stale remote-tracking）。
#[tauri::command]
pub async fn check_branch_batch_branch(
    project_path: String,
    repo_path: Option<String>,
    branch: String,
) -> Result<BranchConflictCheck, String> {
    if branch.trim().is_empty() {
        return Err("源分支不能为空".to_string());
    }
    let remote_exists =
        remote_branch_exists(project_path.clone(), repo_path.clone(), branch.clone()).await?;
    let local_exists =
        local_branch_exists(project_path.clone(), repo_path.clone(), branch.clone()).await?;
    Ok(BranchConflictCheck {
        remote_exists,
        local_exists,
    })
}

/// 打开批次代码目录：启用 worktree 的批打开 worktree 目录，否则打开仓库（主工作区）根。
#[tauri::command]
pub async fn open_branch_batch_worktree(
    project_path: String,
    project_id: String,
    batch_id: String,
) -> Result<(), String> {
    let batch = load_project_batches(project_id.clone())?
        .into_iter()
        .find(|b| b.id == batch_id)
        .ok_or_else(|| "Batch not found".to_string())?;
    let worktree_str = legacy_batch_worktree_path(&project_path, &batch_id)?;
    let target_path = if batch.use_worktree {
        batch.worktree_path.clone().unwrap_or(worktree_str)
    } else {
        // 无 worktree：批分支就在主工作区里，打开仓库根。
        resolve_repo_path(&project_path, batch.worktree_repo.as_deref()).await?
    };

    let target = Path::new(&target_path)
        .canonicalize()
        .map_err(|e| format!("无法解析目录路径: {e}"))?;
    let target_str = target.to_string_lossy().to_string();
    crate::fs::open_in_system_file_manager(target_str.clone(), target_str).await
}

/// 删除 PR worktree：只删代码目录与本地分支（任务/Shell 占用、未合并/脏文件/MR 状态校验后）并关批。
#[tauri::command]
pub async fn delete_branch_batch(
    project_path: String,
    project_id: String,
    batch_id: String,
    shell_open: bool,
) -> Result<Batch, String> {
    let batch = load_project_batches(project_id.clone())?
        .into_iter()
        .find(|b| b.id == batch_id)
        .ok_or_else(|| "Batch not found".to_string())?;
    let worktree_str = legacy_batch_worktree_path(&project_path, &batch_id)?;
    let worktree_path = batch.worktree_path.clone().unwrap_or(worktree_str);
    let effective_repo = batch.worktree_repo.clone().or_else(|| None);
    let cwd = resolve_repo_path(&project_path, effective_repo.as_deref()).await?;

    // 1) 任务占用
    let tasks = load_project_tasks(project_id.clone())?;
    let has_active = tasks.iter().any(|t| {
        batch.task_ids.contains(&t.id) && NON_TERMINAL_TASK_STATUSES.contains(&t.status.as_str())
    });
    if has_active {
        return Err("批次仍有未完成任务，请先完成/终止后再删除".to_string());
    }
    if shell_open {
        return Err("嵌入式 Shell 仍打开在该 worktree，请先关闭".to_string());
    }

    // 2) 未合并提交 / MR 状态 / 脏文件校验
    //   未启用 worktree 的批没有代码目录，脏文件判定改由主工作区负责，这里跳过。
    let worktree_exists = batch.use_worktree && Path::new(&worktree_path).is_dir();
    if worktree_exists {
        if let Some(dirty) = worktree_dirty_reason(&worktree_path)? {
            return Err(format!("worktree 仍有未提交内容，请先处理：{dirty}"));
        }
    }

    if let Some(mr_id) = batch.mr_id.as_deref() {
        let merged =
            crate::codeup::batch_mr_is_merged(&project_path, effective_repo.as_deref(), mr_id)
                .await?;
        if !merged {
            return Err("MR 尚未合并，禁止删除".to_string());
        }
        // 提交 MR 后本地不得新增提交：比对提交时记录的源分支 HEAD。
        if let Some(expected) = batch.mr_source_sha.as_deref() {
            let actual = if worktree_exists {
                run_git_head(&worktree_path)?
            } else {
                run_git_ref(&cwd, &batch.branch)?
            };
            if !actual.is_empty() && actual != expected {
                return Err("源分支在提交 MR 后新增了提交，禁止删除".to_string());
            }
        } else {
            // 旧批次无提交时 SHA：以远端源分支为参照，无法确认则 fail closed。
            let remote = run_git_ref(&cwd, &format!("origin/{}", batch.branch)).ok();
            match remote {
                Some(r) if !r.is_empty() => {
                    let actual = if worktree_exists {
                        run_git_head(&worktree_path)?
                    } else {
                        run_git_ref(&cwd, &batch.branch)?
                    };
                    if actual != r {
                        return Err(
                            "无法确认源分支最新提交（本地/远端不一致），禁止删除".to_string()
                        );
                    }
                }
                _ => return Err("无法确认远端源分支，禁止删除".to_string()),
            }
        }
    } else {
        let source_branch_exists = local_branch_exists(
            project_path.clone(),
            effective_repo.clone(),
            batch.branch.clone(),
        )
        .await?;
        let count = if source_branch_exists {
            branch_unmerged_count(
                cwd.clone(),
                batch.target_branch.clone(),
                batch.branch.clone(),
            )
            .await?
        } else {
            // worktree 和本地分支都可能已被外部清理；此时仍要检查远端分支，
            // 避免删除记录后掩盖一个还有未合并提交的 PR。
            let remote_source_exists = remote_branch_exists(
                project_path.clone(),
                effective_repo.clone(),
                batch.branch.clone(),
            )
            .await?;
            if remote_source_exists {
                remote_branch_unmerged_count(
                    cwd.clone(),
                    batch.target_branch.clone(),
                    batch.branch.clone(),
                )
                .await?
            } else {
                0
            }
        };
        if count > 0 {
            return Err("源分支仍有未合并提交，禁止删除".to_string());
        }
        if worktree_exists {
            let head = run_git_head(&worktree_path)?;
            let remote = run_git_ref(&cwd, &format!("origin/{}", batch.branch)).ok();
            if let Some(remote) = remote {
                if !remote.is_empty() && remote != head {
                    return Err("本地与远端源分支不一致，禁止删除".to_string());
                }
            }
        }
    }

    let batch2 = batch.clone();
    let wt = worktree_path.clone();
    let cwd2 = cwd.clone();
    let branch_name = batch.branch.clone();
    let use_worktree = batch.use_worktree;
    let target_branch = batch.target_branch.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if use_worktree && Path::new(&wt).is_dir() {
            let _ = run_git(&cwd2, &["worktree", "remove", "--force", &wt]);
            let _ = run_git(&cwd2, &["worktree", "prune"]);
        }
        if !use_worktree {
            // 无 worktree：分支可能正被主工作区检出，先切回目标分支才能删除。
            let head = run_git(&cwd2, &["rev-parse", "--abbrev-ref", "HEAD"])?;
            let current = String::from_utf8_lossy(&head.stdout).trim().to_string();
            if current == branch_name {
                let checkout = run_git(&cwd2, &["checkout", &target_branch])?;
                if !checkout.status.success() {
                    return Err(format!(
                        "主工作区仍检出在批分支上且无法切回 {}（可能有未提交改动），请处理后重试：{}",
                        target_branch,
                        String::from_utf8_lossy(&checkout.stderr).trim()
                    ));
                }
            }
        }
        let branch_out = run_git(&cwd2, &["branch", "-D", &branch_name])?;
        if !branch_out.status.success() {
            let err = String::from_utf8_lossy(&branch_out.stderr)
                .trim()
                .to_string();
            if !err.contains("not found") {
                return Err(format!("删除本地分支失败: {err}"));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Delete worktree task panicked: {e}"))??;

    close_branch_batch(project_id, batch_id, false).map(|_| batch2)
}

/// 新建 PR 对话框的默认代码目录（配置基路径 / 共享 hub / 项目内默认，实时解析）。
#[tauri::command]
pub async fn get_branch_batch_worktree_base(
    project_path: String,
    repo_path: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    tokio::task::spawn_blocking(move || {
        Ok(worktree_base_dir(&project_path, &cwd)
            .to_string_lossy()
            .to_string())
    })
    .await
    .map_err(|e| format!("Worktree base task panicked: {e}"))?
}

fn run_git_head(worktree_path: &str) -> Result<String, String> {
    let out = run_git(worktree_path, &["rev-parse", "HEAD"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn run_git_ref(cwd: &str, reference: &str) -> Result<String, String> {
    let out = run_git(cwd, &["rev-parse", reference])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_name_follows_his_type_version_target_desc_shape() {
        assert_eq!(
            batch_branch_name("fix", "v2.20260901", "develop", "锁号地址挂号异常问题"),
            "fix/v2.20260901/develop/锁号地址挂号异常问题"
        );
        assert_eq!(
            batch_branch_name("feature", "v2.20260501.44", "develop", "腾冲协同接口调试"),
            "feature/v2.20260501.44/develop/腾冲协同接口调试"
        );
        assert_eq!(
            batch_branch_name("project", "v2.20260501.20", "master", "富民上线开发分支"),
            "project/v2.20260501.20/master/富民上线开发分支"
        );
    }

    #[test]
    fn branch_name_always_carries_the_target_segment() {
        // 目标段不再可选：只要传了目标分支就带出（含无版本时的形态）。
        assert_eq!(
            batch_branch_name("feature", "", "develop", "门诊挂号优化"),
            "feature/develop/门诊挂号优化"
        );
        assert_eq!(
            batch_branch_name("patch", "v2.20250901", "master", "HIS 现场"),
            "patch/v2.20250901/master/his-现场"
        );
        // 目标段是空白（异常入参）时才退回省略，不让空段产生 `//`。
        assert_eq!(
            batch_branch_name("fix", "", "  ", "收费端"),
            "fix/收费端"
        );
    }

    #[test]
    fn branch_name_drops_version_segment_unless_v_prefixed() {
        // 版本段必须是 v+数字，否则整段丢弃（避免破坏「待发起」的目标分支推断）。
        assert_eq!(
            batch_branch_name("fix", "2.5.1", "develop", "收费端"),
            "fix/develop/收费端"
        );
    }

    #[test]
    fn branch_name_respects_kind_prefix() {
        assert_eq!(
            batch_branch_name("patch", "", "develop", "HIS 现场"),
            "patch/develop/his-现场"
        );
        assert_eq!(
            batch_branch_name("hotfix", "v2.20260901", "master", "收费端"),
            "hotfix/v2.20260901/master/收费端"
        );
        assert_eq!(batch_branch_name("fix", "", "develop", "挂号"), "fix/develop/挂号");
    }

    #[test]
    fn sanitize_collapses_separators_and_empties_fallback() {
        assert_eq!(sanitize_branch_slug("  A B C  "), "a-b-c");
        assert_eq!(sanitize_branch_slug("a..b"), "a.b");
        assert_eq!(sanitize_branch_slug("!!!"), "batch");
    }

    #[test]
    fn merge_allows_feature_fix_patch_project_but_not_pick_only_hotfix() {
        assert!(merge_allows_kind("feature"));
        assert!(merge_allows_kind("fix"));
        assert!(merge_allows_kind("patch"));
        assert!(merge_allows_kind("project"));
        assert!(!merge_allows_kind("hotfix"));
    }
}
