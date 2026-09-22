use std::fs;
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
    #[serde(
        rename = "attentionRequestedAt",
        skip_serializing_if = "Option::is_none"
    )]
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
    /// 所属交付计划 id；非空即该任务强制落在计划分支/worktree 上。
    /// 读侧兼容遗留 `batchId`（全库无写者，仅存量 JSON 可能带），映射一次。
    #[serde(
        rename = "deliveryPlanId",
        alias = "batchId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub delivery_plan_id: Option<String>,
    /// 该任务所在分支的类型（feature/fix/patch/project/hotfix）。
    #[serde(
        rename = "branchKind",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub branch_kind: Option<String>,
    #[serde(rename = "worktreeDiscarded", skip_serializing_if = "Option::is_none")]
    pub worktree_discarded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<i32>,
    /// 导入自云效 Projex 的工作项 id（去重键）。
    #[serde(
        rename = "yunxiaoWorkitemId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub yunxiao_workitem_id: Option<String>,
    /// 导入自云效 Projex 的工作项编号，如 QHDK-29728。
    #[serde(
        rename = "yunxiaoSerialNumber",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub yunxiao_serial_number: Option<String>,
    /// 修改方案回写云效评论的时间戳（幂等标记，非空即已回写）。
    #[serde(
        rename = "yunxiaoWrittenBackAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub yunxiao_written_back_at: Option<i64>,
    /// 回写成功后云效返回的评论 ID（审计/追查用）。
    #[serde(
        rename = "yunxiaoCommentId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub yunxiao_comment_id: Option<String>,
    /// 知识沉淀创建的云效审核议题 ID 列表（幂等标记：非空即已沉淀）。
    #[serde(
        rename = "knowledgeIssueIds",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub knowledge_issue_ids: Vec<String>,
    /// 起源任务 ID：本任务由哪个任务的讨论/执行中发现的问题补录而来（来源追溯）。
    #[serde(
        rename = "derivedFromTaskId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub derived_from_task_id: Option<String>,
    /// 起源云效议题 ID：补充的议题来自哪个已有议题的讨论发现（来源追溯）。
    #[serde(
        rename = "derivedFromWorkitemId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub derived_from_workitem_id: Option<String>,
    /// 多议题联合方案 id：执行任务与临时讨论任务通过它关联 Plan。
    #[serde(
        rename = "planId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub plan_id: Option<String>,
    /// 用户对异常/缺失前置选择「忽略依赖，仍然开始」后置 true。
    #[serde(
        rename = "planDepsIgnored",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub plan_deps_ignored: Option<bool>,
    /// 本任务是「方案讨论」临时任务（定稿后退场，不参与执行、不建 worktree）。
    #[serde(
        rename = "yunxiaoPlanDiscussion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub yunxiao_plan_discussion: Option<bool>,
}

/// 多议题联合方案（Plan）里的议题快照：发起时从云效列表抄录，预览/确认页离线可用。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanIssue {
    #[serde(rename = "workitemId")]
    pub workitem_id: String,
    #[serde(rename = "serialNumber")]
    pub serial_number: String,
    #[serde(default)]
    pub subject: String,
    /// 云效类别（Req / Task / Bug）；未知为空。
    #[serde(default)]
    pub category: String,
}

/// 多议题联合方案：一份方案覆盖 N 个云效议题；正文在项目内
/// `.nezha/plans/<planId>/plan.md`（含图片 images/），元数据持久化在 plans.json。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Plan {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(default)]
    pub name: String,
    /// 议题快照（有序 = 建议执行顺序）。
    #[serde(default)]
    pub issues: Vec<PlanIssue>,
    /// draft | finalized | executing | completed | cancelled
    #[serde(default)]
    pub status: String,
    /// 承载方案讨论的临时任务 id。
    #[serde(
        rename = "discussionTaskId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub discussion_task_id: Option<String>,
    /// 生成待办时创建的分支批 id。
    #[serde(
        rename = "batchId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub batch_id: Option<String>,
    /// 主方案 id：本方案是它的追加子方案（一次追加的一批议题合成）。
    #[serde(
        rename = "parentPlanId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_plan_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(
        rename = "finalizedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub finalized_at: Option<i64>,
    /// 归档时间戳：非空即不占方案看板主列（展示层标记，与 status 正交）。
    #[serde(
        rename = "archivedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub archived_at: Option<i64>,
}

/// 交付计划（DeliveryPlan）= 一个可独立交付的单元：一组有序云效议题成员＋一条分支
/// ＋可选一个 worktree＋至多一个 MR。由「分支批」就地升维（batches.json 文件名保留）。
/// 镜像 TypeScript 的 DeliveryPlan 接口。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeliveryPlan {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub name: String,
    /// 分支类型：feature/fix/patch/project/hotfix。
    pub kind: String,
    /// 计划的源分支名（如 fix/v2.20260901/develop/锁号地址挂号异常问题）。
    pub branch: String,
    #[serde(rename = "baseBranch")]
    pub base_branch: String,
    /// 合并回的目标分支；允许为空 = 暂不指定合并目标（该计划不能提交 MR / 合并回）。
    #[serde(rename = "targetBranch", default)]
    pub target_branch: String,
    /// 成员＝云效议题快照（有序＝任务顺序）。取代旧 taskIds / issueSerialNumbers。
    /// 必须始终序列化：缺失会让 TS 侧迭代 undefined 崩溃。
    #[serde(rename = "issues", default)]
    pub issues: Vec<PlanIssue>,
    /// 遗留成员（任务 id），迁移时消费：有 yunxiaoWorkitemId 的转 issues，全部回写
    /// task.deliveryPlanId。迁移后不再出现；读旧不写新。
    #[serde(rename = "taskIds", default, skip_serializing)]
    pub legacy_task_ids: Vec<String>,
    /// active | review | merged | closed
    #[serde(default)]
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "closedAt", default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
    /// Codeup 合并请求 id（提交 MR 成功后回填；存 localId，删除门禁 batch_mr_is_merged 依赖）。
    #[serde(rename = "mrId", default, skip_serializing_if = "Option::is_none")]
    pub mr_id: Option<String>,
    /// Codeup 合并请求状态（提交后跟随 MR 状态回填，计划详情展示）。
    #[serde(rename = "mrStatus", default, skip_serializing_if = "Option::is_none")]
    pub mr_status: Option<String>,
    /// 创建时实际落盘的 worktree 路径（优先于硬编码推导，兼容共享 hub / 自定义基路径）。
    #[serde(
        rename = "worktreePath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub worktree_path: Option<String>,
    /// 该计划是否另建 worktree。缺省（旧记录）为 true：改动前所有批次都带 worktree。
    /// 必须始终序列化：新计划为 false 时要能被读回，否则会被反序列化成旧语义。
    #[serde(rename = "useWorktree", default = "default_use_worktree")]
    pub use_worktree: bool,
    /// worktree 所属 sub-repo 路径（多仓库工作区）。缺省视为项目根，向后兼容旧记录。
    #[serde(
        rename = "worktreeRepo",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub worktree_repo: Option<String>,
    /// 提交 MR 时源分支 HEAD SHA；删除前校验本地/远端源分支未新增提交。
    #[serde(
        rename = "mrSourceSha",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub mr_source_sha: Option<String>,
}

/// 旧批次记录（字段缺失）一律按「有 worktree」读回——改动前创建的批次都带 worktree。
fn default_use_worktree() -> bool {
    true
}

// ── Path helpers ─────────────────────────────────────────────────────────────

pub(crate) fn nezha_dir() -> Result<PathBuf, String> {
    let home =
        crate::platform::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
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

fn plans_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("plans.json"))
}

/// 项目内方案目录：`<project>/.nezha/plans/<planId>/`（plan.md + images/）。
pub(crate) fn plan_dir(project_path: impl AsRef<Path>, plan_id: &str) -> PathBuf {
    Path::new(project_path.as_ref())
        .join(".nezha")
        .join("plans")
        .join(plan_id)
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

/// 加载某项目的交付计划列表（不存在则返回空列表）。
/// 首次加载自动做 legacy 迁移（taskIds → issues + 回写 task.deliveryPlanId），幂等。
#[tauri::command]
pub fn load_project_batches(project_id: String) -> Result<Vec<DeliveryPlan>, String> {
    let path = batches_path(&project_id)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut plans: Vec<DeliveryPlan> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if migrate_legacy_batches(&project_id, &mut plans)? {
        // 迁移后立即重写，让 taskIds/issueSerialNumbers 从此不再落盘。
        save_project_batches(project_id.clone(), plans.clone())?;
    }
    Ok(plans)
}

/// 保存某项目的交付计划列表（原子写入，空列表也照常写 "[]"，不删文件）。
#[tauri::command]
pub fn save_project_batches(project_id: String, batches: Vec<DeliveryPlan>) -> Result<(), String> {
    ensure_project_dir(&project_id)?;
    let raw = serde_json::to_string_pretty(&batches).map_err(|e| e.to_string())?;
    atomic_write(&batches_path(&project_id)?, &raw)
}

/// legacy 迁移（幂等）：检测到 `legacy_task_ids`（旧 taskIds）即执行——
/// 1) 逐 taskId 查 tasks.json：有 yunxiaoWorkitemId 的转 issues 成员（按旧顺序）；
/// 2) 全部（含自由文本任务）回写 `task.deliveryPlanId = plan.id`（删计划门禁不断链）；
/// 3) 钳制未知 status → closed；useWorktree 走反序列化缺省即显式化。
/// 首次迁移前把原 batches.json 留一份 `.bak`。返回是否发生了改写。
fn migrate_legacy_batches(
    project_id: &str,
    plans: &mut Vec<DeliveryPlan>,
) -> Result<bool, String> {
    let dirty = plans.iter().any(|p| !p.legacy_task_ids.is_empty());
    let status_dirty = plans
        .iter()
        .any(|p| !matches!(p.status.as_str(), "active" | "review" | "merged" | "closed" | ""));
    if !dirty && !status_dirty {
        return Ok(false);
    }

    // 留 .bak（仅首次，已存在不覆盖）。
    if dirty {
        if let Ok(path) = batches_path(project_id) {
            if path.exists() {
                let bak = path.with_file_name("batches.json.bak");
                if !bak.exists() {
                    let _ = fs::copy(&path, &bak);
                }
            }
        }
    }

    let mut tasks = load_project_tasks(project_id.to_string())?;
    let mut tasks_changed = false;
    for plan in plans.iter_mut() {
        if !plan.legacy_task_ids.is_empty() {
            let legacy = std::mem::take(&mut plan.legacy_task_ids);
            for tid in legacy {
                if let Some(task) = tasks.iter_mut().find(|t| t.id == tid) {
                    task.delivery_plan_id = Some(plan.id.clone());
                    tasks_changed = true;
                    if let Some(wid) = task.yunxiao_workitem_id.clone() {
                        if !plan.issues.iter().any(|i| i.workitem_id == wid) {
                            plan.issues.push(PlanIssue {
                                workitem_id: wid,
                                serial_number: task.yunxiao_serial_number.clone().unwrap_or_default(),
                                subject: task.name.clone().unwrap_or_default(),
                                category: String::new(),
                            });
                        }
                    }
                }
            }
        }
        // 状态机收敛：未知值（draft/conflict/approved/rejected 等历史垃圾）钳为 closed。
        if !matches!(plan.status.as_str(), "active" | "review" | "merged" | "closed" | "") {
            plan.status = "closed".to_string();
        }
        if plan.status.is_empty() {
            plan.status = "active".to_string();
        }
    }
    if tasks_changed {
        save_project_tasks(project_id.to_string(), tasks)?;
    }
    Ok(true)
}

/// 加载某项目的多议题联合方案列表（不存在则返回空列表）。
#[tauri::command]
pub fn load_project_plans(project_id: String) -> Result<Vec<Plan>, String> {
    let path = plans_path(&project_id)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// 保存某项目的多议题联合方案列表（原子写入，空列表也照常写 "[]"，不删文件）。
#[tauri::command]
pub fn save_project_plans(project_id: String, plans: Vec<Plan>) -> Result<(), String> {
    ensure_project_dir(&project_id)?;
    let raw = serde_json::to_string_pretty(&plans).map_err(|e| e.to_string())?;
    atomic_write(&plans_path(&project_id)?, &raw)
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
    fn delivery_plan_serde_round_trip() {
        let plan = DeliveryPlan {
            id: "b1".into(),
            project_id: "p1".into(),
            name: "门诊挂号优化".into(),
            kind: "feature".into(),
            branch: "feature/plan-p01".into(),
            base_branch: "develop".into(),
            target_branch: "develop".into(),
            issues: vec![PlanIssue {
                workitem_id: "w1".into(),
                serial_number: "QHDK-29312".into(),
                subject: "挂号回写".into(),
                category: "Bug".into(),
            }],
            legacy_task_ids: vec![],
            status: "active".into(),
            created_at: 1_700_000_000_000,
            closed_at: None,
            mr_id: None,
            mr_status: None,
            worktree_path: None,
            worktree_repo: None,
            use_worktree: false,
            mr_source_sha: None,
        };
        let json = serde_json::to_string(&plan).unwrap();
        // taskIds / issueSerialNumbers 不再序列化。
        assert!(!json.contains("taskIds"));
        assert!(!json.contains("issueSerialNumbers"));
        let back: DeliveryPlan = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "b1");
        assert_eq!(back.kind, "feature");
        assert_eq!(back.branch, "feature/plan-p01");
        assert_eq!(back.issues.len(), 1);
        assert_eq!(back.issues[0].serial_number, "QHDK-29312");
        assert_eq!(back.status, "active");
        // false 必须能被序列化并读回，否则「不建 worktree」的计划会被读成旧语义。
        assert!(!back.use_worktree);
    }

    #[test]
    fn delivery_plan_without_use_worktree_field_defaults_to_true() {
        // 改动前落盘的记录没有 useWorktree 字段——那时批次都带 worktree，必须按 true 读回。
        let legacy = r#"{"id":"b1","projectId":"p1","name":"n","kind":"feature",
            "branch":"feature/x","baseBranch":"develop","targetBranch":"develop",
            "taskIds":[],"status":"active","createdAt":1}"#;
        let plan: DeliveryPlan = serde_json::from_str(legacy).unwrap();
        assert!(plan.use_worktree);
    }

    #[test]
    fn delivery_plan_legacy_task_ids_reads_old_json() {
        // 旧记录的 taskIds 读入 legacy_task_ids（skip_serializing，迁移时消费）。
        let legacy = r#"{"id":"b1","projectId":"p1","name":"n","kind":"feature",
            "branch":"feature/x","baseBranch":"develop","targetBranch":"develop",
            "taskIds":["t1","t2"],"issueSerialNumbers":["QHDK-1"],
            "status":"draft","createdAt":1}"#;
        let plan: DeliveryPlan = serde_json::from_str(legacy).unwrap();
        assert_eq!(plan.legacy_task_ids, vec!["t1", "t2"]);
        assert!(plan.issues.is_empty());
    }

    #[test]
    fn task_legacy_json_without_batch_fields_defaults_none() {
        let legacy = r#"{"id":"t1","projectId":"p1","name":"x","prompt":"p","agent":"claude","permissionMode":"ask","status":"todo","createdAt":1}"#;
        let task: Task = serde_json::from_str(legacy).unwrap();
        assert_eq!(task.delivery_plan_id, None);
        assert_eq!(task.branch_kind, None);
        assert_eq!(task.plan_id, None);
        assert_eq!(task.yunxiao_plan_discussion, None);
    }

    #[test]
    fn task_legacy_batch_id_maps_to_delivery_plan_id() {
        // 遗留 batchId 读侧映射一次（无写者，仅存量 JSON）；新键恒为 deliveryPlanId。
        let legacy = r#"{"id":"t1","projectId":"p1","prompt":"p","agent":"claude","permissionMode":"ask","status":"todo","createdAt":1,"batchId":"b9"}"#;
        let task: Task = serde_json::from_str(legacy).unwrap();
        assert_eq!(task.delivery_plan_id.as_deref(), Some("b9"));
        let json = serde_json::to_string(&task).unwrap();
        assert!(json.contains("deliveryPlanId"));
        assert!(!json.contains("\"batchId\""));
    }

    #[test]
    fn plan_serde_round_trip() {
        let plan = Plan {
            id: "plan1".into(),
            project_id: "p1".into(),
            name: "医保目录联合方案".into(),
            issues: vec![PlanIssue {
                workitem_id: "w1".into(),
                serial_number: "QHDK-29728".into(),
                subject: "主表回写不匹配".into(),
                category: "Bug".into(),
            }],
            status: "draft".into(),
            discussion_task_id: Some("t9".into()),
            batch_id: None,
            parent_plan_id: None,
            created_at: 1_700_000_000_000,
            finalized_at: None,
            archived_at: None,
        };
        let json = serde_json::to_string(&plan).unwrap();
        let back: Plan = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "plan1");
        assert_eq!(back.issues.len(), 1);
        assert_eq!(back.issues[0].serial_number, "QHDK-29728");
        assert_eq!(back.discussion_task_id.as_deref(), Some("t9"));
        assert_eq!(back.parent_plan_id, None);
        assert_eq!(back.archived_at, None);
    }

    #[test]
    fn plan_legacy_json_defaults() {
        let legacy = r#"{"id":"plan1","projectId":"p1","createdAt":1}"#;
        let plan: Plan = serde_json::from_str(legacy).unwrap();
        assert_eq!(plan.status, "");
        assert!(plan.issues.is_empty());
        assert_eq!(plan.batch_id, None);
        // 看板新增字段：旧 plans.json 缺字段时按 None 反序列化（不静默丢状态）。
        assert_eq!(plan.parent_plan_id, None);
        assert_eq!(plan.archived_at, None);
    }
}
