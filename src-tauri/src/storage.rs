use std::fs;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

// ── Data types (mirror TypeScript interfaces) ────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    #[serde(rename = "lastOpenedAt")]
    pub last_opened_at: i64,
    // 缺省=常驻；旧数据无此字段时默认 false，序列化时省略 false 以保持文件简洁。
    #[serde(
        rename = "hiddenFromRail",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub hidden_from_rail: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Task {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub prompt: String,
    pub agent: String,
    #[serde(rename = "permissionMode")]
    pub permission_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(
        rename = "reasoningEffort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning_effort: Option<String>,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt", default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(rename = "attentionRequestedAt", skip_serializing_if = "Option::is_none")]
    pub attention_requested_at: Option<i64>,
    #[serde(rename = "claudeSessionId", skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    #[serde(rename = "claudeSessionPath", skip_serializing_if = "Option::is_none")]
    pub claude_session_path: Option<String>,
    #[serde(rename = "codexSessionId", skip_serializing_if = "Option::is_none")]
    pub codex_session_id: Option<String>,
    #[serde(rename = "codexSessionPath", skip_serializing_if = "Option::is_none")]
    pub codex_session_path: Option<String>,
    #[serde(rename = "dshSessionId", skip_serializing_if = "Option::is_none")]
    pub dsh_session_id: Option<String>,
    #[serde(rename = "dshSessionPath", skip_serializing_if = "Option::is_none")]
    pub dsh_session_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starred: Option<bool>,
    #[serde(rename = "failureReason", skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    #[serde(rename = "worktreePath", skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(rename = "worktreeBranch", skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(rename = "worktreeRepo", skip_serializing_if = "Option::is_none")]
    pub worktree_repo: Option<String>,
    #[serde(rename = "baseBranch", skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// 所属分支批 id；非空即该任务属于某个可独立验收批次。
    #[serde(rename = "batchId", default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    /// 该任务所在分支的类型（feature/patch/release/hotfix）。
    #[serde(rename = "branchKind", default, skip_serializing_if = "Option::is_none")]
    pub branch_kind: Option<String>,
    #[serde(rename = "worktreeDiscarded", skip_serializing_if = "Option::is_none")]
    pub worktree_discarded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<i32>,
    /// 导入自云效 Projex 的工作项 id（去重键）。
    #[serde(rename = "yunxiaoWorkitemId", default, skip_serializing_if = "Option::is_none")]
    pub yunxiao_workitem_id: Option<String>,
    /// 导入自云效 Projex 的工作项编号，如 QHDK-29728。
    #[serde(rename = "yunxiaoSerialNumber", default, skip_serializing_if = "Option::is_none")]
    pub yunxiao_serial_number: Option<String>,
    /// 云效议题定稿数据（补充表单字段 + 定稿前原始 prompt）；切回待办时恢复表单。
    #[serde(rename = "yunxiaoSupplement", default, skip_serializing_if = "Option::is_none")]
    pub yunxiao_supplement: Option<YunxiaoSupplement>,
    /// 修改方案回写云效评论的时间戳（幂等标记，非空即已回写）。
    #[serde(rename = "yunxiaoWrittenBackAt", default, skip_serializing_if = "Option::is_none")]
    pub yunxiao_written_back_at: Option<i64>,
    /// 回写成功后云效返回的评论 ID（审计/追查用）。
    #[serde(rename = "yunxiaoCommentId", default, skip_serializing_if = "Option::is_none")]
    pub yunxiao_comment_id: Option<String>,
    /// 知识沉淀创建的云效审核议题 ID 列表（幂等标记：非空即已沉淀）。
    #[serde(rename = "knowledgeIssueIds", default, skip_serializing_if = "Vec::is_empty")]
    pub knowledge_issue_ids: Vec<String>,
    /// 起源任务 ID：本任务由哪个任务的讨论/执行中发现的问题补录而来（来源追溯）。
    #[serde(rename = "derivedFromTaskId", default, skip_serializing_if = "Option::is_none")]
    pub derived_from_task_id: Option<String>,
    /// 起源云效议题 ID：补充的议题来自哪个已有议题的讨论发现（来源追溯）。
    #[serde(rename = "derivedFromWorkitemId", default, skip_serializing_if = "Option::is_none")]
    pub derived_from_workitem_id: Option<String>,
}

/// 分支批 = 一个可独立验收的 PR（一个批对应一个分支 + 一个 worktree，批内任务顺序共用）。
/// 镜像 TypeScript 的 BranchBatch 接口。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Batch {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub name: String,
    /// 分支类型：feature/patch/release/hotfix。
    pub kind: String,
    /// 批的目标分支名（如 feature/batch-p01）。
    pub branch: String,
    #[serde(rename = "baseBranch")]
    pub base_branch: String,
    #[serde(rename = "targetBranch")]
    pub target_branch: String,
    /// 该批包含的议题任务 id 列表（顺序即验收批次内任务顺序）。
    /// 必须始终序列化：前端依赖字段存在（空批也不可缺省），缺失会让 TS 侧迭代 undefined 崩溃。
    #[serde(rename = "taskIds", default)]
    pub task_ids: Vec<String>,
    /// draft | active | review | conflict | merged | closed
    #[serde(default)]
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "closedAt", default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<i32>,
    /// 云效议题编号列表，用于 commit 门禁与回写（如 ["QHDK-29312"]）。
    #[serde(rename = "issueSerialNumbers", default, skip_serializing_if = "Vec::is_empty")]
    pub issue_serial_numbers: Vec<String>,
    /// Codeup 合并请求 id（提交 MR 成功后回填）。
    #[serde(rename = "mrId", default, skip_serializing_if = "Option::is_none")]
    pub mr_id: Option<String>,
    /// Codeup 合并请求状态（提交后跟随 MR 状态回填）。
    #[serde(rename = "mrStatus", default, skip_serializing_if = "Option::is_none")]
    pub mr_status: Option<String>,
    /// 创建时实际落盘的 worktree 路径（优先于硬编码推导，兼容共享 hub / 自定义基路径）。
    #[serde(rename = "worktreePath", default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// worktree 所属 sub-repo 路径（多仓库工作区）。缺省视为项目根，向后兼容旧批次。
    #[serde(rename = "worktreeRepo", default, skip_serializing_if = "Option::is_none")]
    pub worktree_repo: Option<String>,
    /// 提交 MR 时源分支 HEAD SHA；删除前校验本地/远端源分支未新增提交。
    #[serde(rename = "mrSourceSha", default, skip_serializing_if = "Option::is_none")]
    pub mr_source_sha: Option<String>,
}

/// 云效议题补充表单数据：字段随草稿防抖落盘；finalized 区分「已定稿」与「仅草稿」。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct YunxiaoSupplement {
    #[serde(default)]
    pub fields: HashMap<String, String>,
    #[serde(rename = "originalPrompt", default)]
    pub original_prompt: String,
    /// 是否已定稿；旧数据缺省为 None，前端按「有字段即已定稿」兼容。
    #[serde(rename = "finalized", default, skip_serializing_if = "Option::is_none")]
    pub finalized: Option<bool>,
}

// ── Path helpers ─────────────────────────────────────────────────────────────

pub(crate) fn nezha_dir() -> Result<PathBuf, String> {
    let home = crate::platform::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    Ok(home.join(".nezha"))
}

fn projects_path() -> Result<PathBuf, String> {
    Ok(nezha_dir()?.join("projects.json"))
}

fn tasks_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("tasks.json"))
}

fn batches_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("batches.json"))
}

fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(nezha_dir()?.join("projects").join(project_id))
}

pub(crate) fn ensure_nezha_dirs() -> Result<(), String> {
    fs::create_dir_all(nezha_dir()?).map_err(|e| e.to_string())
}

fn ensure_project_dir(project_id: &str) -> Result<(), String> {
    fs::create_dir_all(project_dir(project_id)?).map_err(|e| e.to_string())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn load_projects() -> Result<Vec<Project>, String> {
    let path = projects_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_projects(projects: Vec<Project>) -> Result<(), String> {
    ensure_nezha_dirs()?;
    let raw = serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())?;
    atomic_write(&projects_path()?, &raw)
}

#[tauri::command]
pub fn load_project_tasks(project_id: String) -> Result<Vec<Task>, String> {
    let path = tasks_path(&project_id)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|parse_err| {
        // 系统崩溃(掉电/蓝屏)可能留下空或截断的 tasks.json。把损坏文件挪走
        // 保留人工恢复现场,下次启动即回到正常空列表,不会永久卡死在解析报错上。
        let secs = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let backup = path.with_file_name(format!("tasks.json.corrupt-{secs}"));
        match fs::rename(&path, &backup) {
            Ok(()) => format!(
                "tasks.json is corrupted ({parse_err}); moved to {} for manual recovery",
                backup.display()
            ),
            Err(mv_err) => {
                format!("tasks.json is corrupted ({parse_err}); failed to move it aside: {mv_err}")
            }
        }
    })
}

#[tauri::command]
pub fn save_project_tasks(project_id: String, tasks: Vec<Task>) -> Result<(), String> {
    ensure_project_dir(&project_id)?;
    // 空列表也照常写 "[]",不删文件:删除路径曾放大过崩溃后的数据丢失
    // (加载失败 → 前端空 state → 空列表保存把磁盘上仅存的原始文件删掉)。
    let raw = serde_json::to_string_pretty(&tasks).map_err(|e| e.to_string())?;
    atomic_write(&tasks_path(&project_id)?, &raw)
}

/// 加载某项目的分支批列表（不存在则返回空列表）。
#[tauri::command]
pub fn load_project_batches(project_id: String) -> Result<Vec<Batch>, String> {
    let path = batches_path(&project_id)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// 保存某项目的分支批列表（原子写入，空列表也照常写 "[]"，不删文件）。
#[tauri::command]
pub fn save_project_batches(project_id: String, batches: Vec<Batch>) -> Result<(), String> {
    ensure_project_dir(&project_id)?;
    let raw = serde_json::to_string_pretty(&batches).map_err(|e| e.to_string())?;
    atomic_write(&batches_path(&project_id)?, &raw)
}

// ── Atomic write (write to tmp then rename) ───────────────────────────────────

/// 原子写入：先写入唯一临时文件，fsync 落盘后再 rename 到目标路径。
/// 临时文件名包含 pid + 纳秒时间戳，避免并发写入时临时文件相互覆盖。
///
/// rename 只保证元数据原子性,不保证数据先于 rename 落盘——NTFS/APFS 都只
/// journal 元数据,掉电/系统崩溃时会留下 0 字节或截断的目标文件(Windows 用户
/// 实际踩过:突然重启后 tasks.json 清空)。rename 前必须 sync_all
/// (Windows=FlushFileBuffers,macOS=F_FULLFSYNC)强制数据先持久化。
pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let uid = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{file_name}.{uid}.tmp"));
    let write_and_sync = || -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    };
    if let Err(e) = write_and_sync() {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_serde_round_trip() {
        let batch = Batch {
            id: "b1".into(),
            project_id: "p1".into(),
            name: "门诊挂号优化".into(),
            kind: "feature".into(),
            branch: "feature/batch-p01".into(),
            base_branch: "develop".into(),
            target_branch: "develop".into(),
            task_ids: vec!["t1".into(), "t2".into()],
            status: "active".into(),
            created_at: 1_700_000_000_000,
            closed_at: None,
            additions: Some(312),
            deletions: Some(48),
            issue_serial_numbers: vec!["QHDK-29312".into()],
            mr_id: None,
            mr_status: None,
            worktree_path: None,
            worktree_repo: None,
            prepare_status: None,
            prepare_error: None,
            prepare_pid: None,
            mr_source_sha: None,
        };
        let json = serde_json::to_string(&batch).unwrap();
        let back: Batch = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "b1");
        assert_eq!(back.kind, "feature");
        assert_eq!(back.branch, "feature/batch-p01");
        assert_eq!(back.task_ids, vec!["t1", "t2"]);
        assert_eq!(back.status, "active");
        assert_eq!(back.additions, Some(312));
        assert_eq!(back.issue_serial_numbers, vec!["QHDK-29312"]);
    }

    #[test]
    fn task_legacy_json_without_batch_fields_defaults_none() {
        let legacy = r#"{"id":"t1","projectId":"p1","name":"x","prompt":"p","agent":"claude","permissionMode":"ask","status":"todo","createdAt":1}"#;
        let task: Task = serde_json::from_str(legacy).unwrap();
        assert_eq!(task.batch_id, None);
        assert_eq!(task.branch_kind, None);
    }
}
