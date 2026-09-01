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

const VALID_KINDS: &[&str] = &["feature", "patch", "release", "hotfix"];

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

/// 按分支类型与批名生成目标分支名（如 feature/batch-p01、hotfix/2.5.1-xxx）。
pub(crate) fn batch_branch_name(kind: &str, name: &str) -> String {
    let prefix = match kind {
        "patch" => "patch",
        "release" => "release",
        "hotfix" => "hotfix",
        _ => "feature",
    };
    let slug = sanitize_branch_slug(name);
    // 名过长时截断，避免分支名超 git 限制；保留足够可读前缀。
    let slug: String = slug.chars().take(48).collect();
    format!("{prefix}/{slug}")
}

/// 创建分支批：校验入参 → 生成分支名 → 建 worktree/分支 → 落盘到 batches.json。
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

    let branch = source_branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| batch_branch_name(&kind, &name));
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

    // 计划路径：创建者选的目录优先，缺省回落配置基路径 / 共享 hub / 项目内默认。
    let worktree_path = match worktree_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(dir) => PathBuf::from(dir).join(&id),
        None => worktree_base_dir(&project_path, &cwd).join(&id),
    };
    if !worktree_path.is_absolute() {
        return Err("代码目录必须是绝对路径".to_string());
    }
    let worktree_str = path_to_string(&worktree_path)?;
    let owner_repo = repo_path.clone().or_else(|| Some(cwd.clone()));

    // 阻塞的 git 创建与文件落盘统一放到 spawn_blocking，避免占用 Tokio 运行时。
    // 建成功才落盘批次记录；git 失败就地回滚，不留半态记录。
    tokio::task::spawn_blocking(move || -> Result<Batch, String> {
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
            issue_serial_numbers: vec![],
            mr_id: None,
            mr_status: None,
            worktree_path: Some(worktree_str.clone()),
            worktree_repo: owner_repo,
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
                let worktree_path = match b.worktree_path.as_deref() {
                    Some(path) => PathBuf::from(path),
                    None => match project_path.as_deref() {
                        Some(path) if !path.trim().is_empty() => {
                            Path::new(path).join(".nezha").join("worktrees").join(&b.id)
                        }
                        _ => PathBuf::new(),
                    },
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

/// 合并分支批到目标分支（复用 worktree 合并），成功后自动关批并删除 worktree/分支。
/// 批 = 一个分支 + 一个 worktree，故 worktree 路径由批 id 推导。
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
    let worktree_path = batch.worktree_path.clone().unwrap_or(worktree_str.clone());
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
    // 合并成功后自动关批（status = merged）并删除 worktree/分支。
    let closed = close_branch_batch(project_id.clone(), batch_id, true)?;
    let _ =
        crate::git::remove_task_worktree(project_path, effective_repo, worktree_path, batch.branch)
            .await;
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

/// 打开 PR worktree（专用命令，用 projectId+batchId 找持久化/兼容路径，放宽项目外共享 hub 限制的同时做路径校验）。
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
    let worktree_path = batch.worktree_path.clone().unwrap_or(worktree_str);

    let target = Path::new(&worktree_path)
        .canonicalize()
        .map_err(|e| format!("无法解析 worktree 路径: {e}"))?;
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
    let worktree_exists = Path::new(&worktree_path).is_dir();
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
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if Path::new(&wt).is_dir() {
            let _ = run_git(&cwd2, &["worktree", "remove", "--force", &wt]);
        }
        let _ = run_git(&cwd2, &["worktree", "prune"]);
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
    fn branch_name_generates_feature_prefix() {
        assert_eq!(
            batch_branch_name("feature", "门诊挂号优化"),
            "feature/门诊挂号优化"
        );
        assert_eq!(
            batch_branch_name("feature", "batch p01"),
            "feature/batch-p01"
        );
    }

    #[test]
    fn branch_name_respects_kind_prefix() {
        assert_eq!(batch_branch_name("patch", "HIS 现场"), "patch/his-现场");
        assert_eq!(
            batch_branch_name("hotfix", "2.5.1 收费端"),
            "hotfix/2.5.1-收费端"
        );
        assert_eq!(batch_branch_name("release", "v2.6.0"), "release/v2.6.0");
    }

    #[test]
    fn sanitize_collapses_separators_and_empties_fallback() {
        assert_eq!(sanitize_branch_slug("  A B C  "), "a-b-c");
        assert_eq!(sanitize_branch_slug("a..b"), "a.b");
        assert_eq!(sanitize_branch_slug("!!!"), "batch");
    }

    #[test]
    fn merge_allows_feature_patch_release_but_not_pick_only_hotfix() {
        assert!(merge_allows_kind("feature"));
        assert!(merge_allows_kind("patch"));
        assert!(merge_allows_kind("release"));
        assert!(!merge_allows_kind("hotfix"));
    }
}
