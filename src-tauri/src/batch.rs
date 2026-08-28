//! 分支批（Branch Batch）管理：一个批 = 一个可独立验收的 PR，
//! 对应一个分支 + 一个 worktree，批内议题任务顺序共用该工作区。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::git::{path_to_string, resolve_repo_path, run_git};
use crate::storage::{Batch, load_project_batches, save_project_batches};

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

    let branch = batch_branch_name(&kind, &name);
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    // 阻塞的 git 创建与文件落盘统一放到 spawn_blocking，避免占用 Tokio 运行时。
    tokio::task::spawn_blocking(move || {
        let worktrees_dir = Path::new(&cwd).join(".nezha").join("worktrees");
        std::fs::create_dir_all(&worktrees_dir)
            .map_err(|e| format!("Failed to create worktrees dir: {e}"))?;
        let worktree_path = worktrees_dir.join(&id);
        if worktree_path.exists() {
            return Err(format!("Worktree path already exists: {}", worktree_path.display()));
        }
        let worktree_str = path_to_string(&worktree_path)?;
        let output = run_git(&cwd, &["worktree", "add", &worktree_str, "-b", &branch, &base_branch])?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let batch = Batch {
            id: id.clone(),
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
        };

        let mut batches = load_project_batches(project_id.clone())?;
        batches.push(batch.clone());
        save_project_batches(project_id, batches)?;
        Ok(batch)
    })
    .await
    .map_err(|e| format!("Create batch task panicked: {}", e))?
}

/// 列出某项目的分支批。
#[tauri::command]
pub fn list_branch_batches(project_id: String) -> Result<Vec<Batch>, String> {
    load_project_batches(project_id)
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
pub fn close_branch_batch(project_id: String, batch_id: String, merged: bool) -> Result<Batch, String> {
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
    let cwd = crate::git::resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let batch = load_project_batches(project_id.clone())?
        .into_iter()
        .find(|b| b.id == batch_id)
        .ok_or_else(|| "Batch not found".to_string())?;
    if !merge_allows_kind(&batch.kind) {
        return Err(format!("批次类型 {} 是挑拣容器，不允许向上合并", batch.kind));
    }
    let worktree_path = Path::new(&cwd).join(".nezha").join("worktrees").join(&batch_id);
    let worktree_str = crate::git::path_to_string(&worktree_path)?;
    let message = crate::git::merge_task_worktree(
        project_path.clone(),
        repo_path.clone(),
        worktree_str.clone(),
        batch.branch.clone(),
        batch.target_branch.clone(),
        None,
    )
    .await?;
    // 合并成功后自动关批（status = merged）并删除 worktree/分支。
    let closed = close_branch_batch(project_id.clone(), batch_id, true)?;
    let _ = crate::git::remove_task_worktree(project_path, repo_path, worktree_str, batch.branch)
        .await;
    Ok(MergeBatchResult {
        message,
        batch: closed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_name_generates_feature_prefix() {
        assert_eq!(batch_branch_name("feature", "门诊挂号优化"), "feature/门诊挂号优化");
        assert_eq!(batch_branch_name("feature", "batch p01"), "feature/batch-p01");
    }

    #[test]
    fn branch_name_respects_kind_prefix() {
        assert_eq!(batch_branch_name("patch", "HIS 现场"), "patch/his-现场");
        assert_eq!(batch_branch_name("hotfix", "2.5.1 收费端"), "hotfix/2.5.1-收费端");
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
