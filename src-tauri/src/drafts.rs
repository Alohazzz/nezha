//! 云效议题工作产物草稿（draft）管理。
//!
//! 讨论/修改过程中，Agent 按提示词把「方案汇总」和「知识沉淀候选」落到
//! `.nezha/drafts/<taskId>/`（相对 Agent 当前工作目录，可能是 worktree）。
//! 任务收尾时由后端收拢到项目根 `.nezha/drafts/<taskId>/`，「回写云效」与
//! 「知识沉淀」按钮直接读取草稿，避免点击时重新跑 headless 生成。

use std::fs;
use std::path::{Path, PathBuf};

/// 允许读取/收拢的草稿文件名（白名单，防目录遍历/任意文件读取）。
const ALLOWED_DRAFT_FILES: &[&str] = &["discussion.md", "knowledge.json", "backfill-issue.json"];
/// 单文件读取大小上限（草稿是提示词引导的小文件；超限视为异常跳过）。
const MAX_DRAFT_READ_BYTES: u64 = 2 * 1024 * 1024;

/// task_id 会拼进草稿目录名：拒绝路径分隔符与 `..`，防目录穿越。
fn validate_task_id(task_id: &str) -> Result<(), String> {
    if task_id.is_empty()
        || task_id.contains('/')
        || task_id.contains('\\')
        || task_id.contains("..")
        || task_id.contains(':')
    {
        return Err("Invalid task id".to_string());
    }
    Ok(())
}

/// 项目根下的草稿目录：`<project>/.nezha/drafts/<taskId>/`。
pub(crate) fn task_drafts_dir(project_path: impl AsRef<Path>, task_id: &str) -> PathBuf {
    Path::new(project_path.as_ref())
        .join(".nezha")
        .join("drafts")
        .join(task_id)
}

/// 校验草稿文件路径必须落在 `<project>/.nezha/drafts/<taskId>/` 内且文件名白名单。
/// 返回解析后的绝对路径（文件不存在时返回未 canonicalize 的目标路径）。
fn validate_draft_file(
    project_path: &str,
    task_id: &str,
    file_name: &str,
) -> Result<PathBuf, String> {
    if !ALLOWED_DRAFT_FILES.contains(&file_name) {
        return Err(format!("Draft file name not allowed: {}", file_name));
    }
    validate_task_id(task_id)?;
    let root = Path::new(project_path);
    if !root.is_absolute() {
        return Err("Project path must be absolute".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project root: {}", e))?;
    let draft_dir = task_drafts_dir(&canonical_root, task_id);
    let target = draft_dir.join(file_name);

    // 文件已存在 → 整体 canonicalize 后必须仍落在 draft_dir 内（防符号链接逃逸）。
    if let Ok(canonical_target) = target.canonicalize() {
        if !canonical_target.starts_with(&draft_dir) {
            return Err("Draft path is outside the allowed directory".to_string());
        }
        return Ok(canonical_target);
    }
    // 文件不存在（读取侧视为无草稿）→ 校验父目录仍落在项目根内。
    if let Ok(canonical_parent) = draft_dir.canonicalize() {
        if !canonical_parent.starts_with(&canonical_root) {
            return Err("Draft directory is outside the project root".to_string());
        }
    }
    Ok(target)
}

/// 读取草稿文件内容。文件不存在返回 `Ok(None)`；路径非法/超限返回 `Err`。
pub(crate) fn read_draft_file(
    project_path: &str,
    task_id: &str,
    file_name: &str,
) -> Result<Option<String>, String> {
    let target = validate_draft_file(project_path, task_id, file_name)?;
    if !target.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(&target).map_err(|e| format!("Failed to read draft metadata: {}", e))?;
    if meta.len() > MAX_DRAFT_READ_BYTES {
        return Err(format!(
            "Draft file too large ({} bytes, max {} bytes)",
            meta.len(),
            MAX_DRAFT_READ_BYTES
        ));
    }
    let content =
        fs::read_to_string(&target).map_err(|e| format!("Failed to read draft: {}", e))?;
    Ok(Some(content))
}

/// 任务收尾时把 Agent 写在「有效工作目录」（可能是 worktree）下的草稿收拢到项目根。
///
/// - 有效路径与项目根一致（无 worktree）时是 no-op；
/// - worktree 场景把 `<effective>/.nezha/drafts/<taskId>/` 下的白名单文件拷贝到
///   `<project>/.nezha/drafts/<taskId>/`，使回写/沉淀读取位置与 worktree 生命周期解耦。
///
/// 返回是否发生了拷贝。
pub(crate) fn gather_task_drafts(
    effective_path: &str,
    real_project_path: &str,
    task_id: &str,
) -> Result<bool, String> {
    validate_task_id(task_id)?;
    if effective_path == real_project_path {
        return Ok(false);
    }
    let effective = Path::new(effective_path);
    let real = Path::new(real_project_path);
    if !effective.is_absolute() || !real.is_absolute() {
        return Err("Draft gather requires absolute paths".to_string());
    }
    let source_dir = effective.join(".nezha").join("drafts").join(task_id);
    if !source_dir.is_dir() {
        return Ok(false);
    }
    let dest_dir = real.join(".nezha").join("drafts").join(task_id);
    fs::create_dir_all(&dest_dir).map_err(|e| format!("Failed to create draft dir: {}", e))?;

    let mut copied = false;
    for entry in fs::read_dir(&source_dir).map_err(|e| format!("Failed to read draft dir: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read draft entry: {}", e))?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !ALLOWED_DRAFT_FILES.contains(&name.as_str()) {
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|e| format!("Failed to read draft metadata: {}", e))?;
        if meta.len() > MAX_DRAFT_READ_BYTES {
            continue;
        }
        let dest = dest_dir.join(&name);
        fs::copy(entry.path(), &dest)
            .map_err(|e| format!("Failed to copy draft {}: {}", name, e))?;
        copied = true;
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nezha-drafts-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_draft_returns_none_when_missing() {
        let proj = temp_project("missing");
        let result = read_draft_file(proj.to_str().unwrap(), "t1", "discussion.md").unwrap();
        assert!(result.is_none());
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn read_draft_rejects_unknown_file_and_bad_task_id() {
        let proj = temp_project("unknown");
        assert!(read_draft_file(proj.to_str().unwrap(), "t1", "evil.txt").is_err());
        assert!(read_draft_file(proj.to_str().unwrap(), "../t1", "discussion.md").is_err());
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn read_draft_roundtrip() {
        let proj = temp_project("roundtrip");
        let dir = task_drafts_dir(proj.to_str().unwrap(), "t1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("discussion.md"), "# 方案\n").unwrap();
        let content = read_draft_file(proj.to_str().unwrap(), "t1", "discussion.md")
            .unwrap()
            .unwrap();
        assert_eq!(content, "# 方案\n");
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn gather_copies_from_worktree_to_project_root() {
        let proj = temp_project("gather");
        let wt = proj.join(".nezha").join("worktrees").join("t1");
        let src = wt.join(".nezha").join("drafts").join("t1");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("discussion.md"), "draft").unwrap();
        fs::write(src.join("knowledge.json"), "[]").unwrap();
        fs::write(src.join("junk.txt"), "ignored").unwrap();

        let copied = gather_task_drafts(wt.to_str().unwrap(), proj.to_str().unwrap(), "t1").unwrap();
        assert!(copied);
        let dest = proj.join(".nezha").join("drafts").join("t1");
        assert_eq!(
            fs::read_to_string(dest.join("discussion.md")).unwrap(),
            "draft"
        );
        assert_eq!(fs::read_to_string(dest.join("knowledge.json")).unwrap(), "[]");
        assert!(!dest.join("junk.txt").exists());
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn gather_same_path_is_noop_and_no_source_is_noop() {
        let proj = temp_project("noop");
        assert!(!gather_task_drafts(proj.to_str().unwrap(), proj.to_str().unwrap(), "t1").unwrap());
        let other = temp_project("nosrc");
        assert!(!gather_task_drafts(other.to_str().unwrap(), proj.to_str().unwrap(), "t1").unwrap());
        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&other);
    }
}
