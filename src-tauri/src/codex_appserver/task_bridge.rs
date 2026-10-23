//! codex app-server 会话与任务系统的集成桥（issue #116 阶段 2）。
//!
//! 职责：spawn 会话 → 订阅 `CodexEvent` → 转成**结构化 JSON 事件**经
//! `tauri::ipc::Channel` 直投前端（沿用 PTY 的 Channel 直投模式，绕开事件
//! 总线广播），同时把生命周期映射到现有 `task-status` / `task-session` 事件，
//! 让任务列表 / 会话发现 / 通知等既有 UI 无差别工作。
//!
//! 与 PTY 红线的关系：本模块只**新增**通路，不改 `pty.rs` 任何现有函数；
//! `run_task` 的分流入口见 `pty.rs::run_task`（structured 且非云效才进来）。

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast::Receiver;

use super::approval::ApprovalAction;
use super::{CodexAppServerSession, CodexEvent, SessionError, SessionPhase, SpawnRequest, ThreadInfo};
use crate::storage::Task;

/// Nezha 权限模式 → (approvalPolicy, sandbox)。
///
/// 与 PTY 模式的 CLI 标志映射（AGENTS.md 表）语义对齐：
/// - `ask`：默认档，只读沙箱 + 命令需审批；
/// - `auto_edit`：工作区内可写，越界才审批（等价 `--sandbox workspace-write -a on-request`）；
/// - `full_access`：无审批无沙箱（等价 `--dangerously-bypass-approvals-and-sandbox`，
///   计划 2.5：full_access 用 `approvalPolicy: never`）。
pub fn permission_mode_to_policy(mode: &str) -> (&'static str, &'static str) {
    match mode {
        "auto_edit" => ("on-request", "workspace-write"),
        "full_access" => ("never", "danger-full-access"),
        // 未知取值保守落回最受限档（与 dsh_permission_mode 同策略）
        _ => ("untrusted", "read-only"),
    }
}

/// structured 会话表的条目：会话句柄 + 事件转发是否已被取消。
/// 会话由 forwarder 任务独占推进；命令层（cancel/complete/respond）只读写表。
pub struct StructuredTaskEntry {
    pub session: Arc<CodexAppServerSession>,
}

/// structured 模式的启动参数：由 `run_task` 分流点从命令参数归集。
pub struct StructuredLaunch {
    pub task_id: String,
    pub project_path: String,
    pub prompt: String,
    pub permission_mode: String,
    pub unattended: bool,
}

/// 判定任务是否应走 structured 通道（2.2 分流判据，run_task 与前端共用语义）。
/// 云效直发任务在 `run_task` 侧强制 PTY（2.2a 防线），不依赖这里。
pub fn is_structured(task: &Task) -> bool {
    task.agent == "codex" && task.run_mode.as_deref() == Some("structured")
}

/// spawn `codex app-server` 会话并完成 initialize + thread/start。
/// 版本地板（≥0.156）与握手超时由 `CodexAppServerSession::spawn` / `initialize` 负责。
pub async fn spawn_session(
    agent_bin: &str,
    cwd: &str,
    permission_mode: &str,
) -> Result<CodexAppServerSession, SessionError> {
    let (approval_policy, sandbox) = permission_mode_to_policy(permission_mode);
    let request = SpawnRequest::codex_app_server(agent_bin, cwd, approval_policy, sandbox);
    let session = CodexAppServerSession::spawn(request).await?;
    session.start_thread().await?;
    Ok(session)
}

/// 注册会话到 TaskManager（cancel/complete/respond 命令可寻址）。
pub fn register_session(
    task_manager: &crate::TaskManager,
    task_id: &str,
    session: Arc<CodexAppServerSession>,
) {
    task_manager.codex_appserver_sessions.lock().insert(
        task_id.to_string(),
        StructuredTaskEntry { session },
    );
}

/// 取走并移除会话（收尾路径）。返回 None 表示任务不是 structured 或已收尾。
pub fn take_session(
    task_manager: &crate::TaskManager,
    task_id: &str,
) -> Option<Arc<CodexAppServerSession>> {
    task_manager
        .codex_appserver_sessions
        .lock()
        .remove(task_id)
        .map(|e| e.session)
}

/// structured 任务的 forwarder：唯一消费会话事件的地方。
///
/// 事件映射（计划 2.3/2.4/2.5）：
/// - delta/item 事件 → Channel 结构化 JSON（前端 `codex-event` 数据面）；
/// - `ThreadStarted` → emit `task-session`（sessionId 直接来自 thread，无需文件发现兜底）；
/// - `TurnCompleted{completed}` → `task-status: done`；`interrupted` → `interrupted`；`failed` → `failed`；
/// - `ApprovalRequested` → emit `codex-approval-requested` + `task-status: input_required`；
/// - `SessionError` → `task-status: failed` + failureReason。
pub fn spawn_forwarder(
    app: AppHandle,
    task_id: String,
    unattended: bool,
    on_output: Channel<String>,
    mut events: Receiver<CodexEvent>,
    mut errors: Receiver<SessionError>,
) {
    tokio::spawn(async move {
        // 先挂错误流再进事件循环：进程秒退时 EOF 错误可能先于残留事件到达
        loop {
            tokio::select! {
                event = events.recv() => {
                    match event {
                        Ok(event) => {
                            if !handle_event(&app, &on_output, &task_id, unattended, event).await {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("[codex_appserver] forwarder lagged, dropped {n} events");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                error = errors.recv() => {
                    match error {
                        Ok(err) => {
                            emit_failed(&app, &task_id, &format!("{err:?}"));
                            break;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("[codex_appserver] error stream lagged, dropped {n}");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
        // forwarder 退出即会话终结：清表并清理事件目录（与 PTY 的 cancel 收尾对齐）。
        // forwarder 是唯一消费方，状态经 app.state 自取（State 不是 'static，无法捕获）。
        if let Some(tm) = app.try_state::<crate::TaskManager>() {
            take_session(&tm, &task_id);
        }
        crate::event_watcher::cleanup_task_events(&task_id);
    });
}

/// 处理单个事件。返回 false 表示会话已终结（turn 完成/失败），forwarder 应退出。
async fn handle_event(
    app: &AppHandle,
    on_output: &Channel<String>,
    task_id: &str,
    unattended: bool,
    event: CodexEvent,
) -> bool {
    match event {
        CodexEvent::ThreadStarted { thread } => {
            emit_task_session(app, task_id, &thread);
            true
        }
        CodexEvent::TurnCompleted { turn, .. } => {
            match turn.status {
                codex_app_server_protocol::TurnStatus::Completed => {
                    emit_done(app, task_id, unattended);
                    false
                }
                codex_app_server_protocol::TurnStatus::Interrupted => {
                    // 计划 2.4：interrupted 首期不支持恢复，按失败收口（UI 隐藏恢复入口）。
                    // 会话随 forwarder 退出被 kill_on_drop 回收。
                    emit_failed(app, task_id, "turn interrupted");
                    false
                }
                codex_app_server_protocol::TurnStatus::Failed => {
                    emit_failed(app, task_id, "turn failed");
                    false
                }
                codex_app_server_protocol::TurnStatus::InProgress => true,
            }
        }
        CodexEvent::ApprovalRequested { params, .. } => {
            // 反向请求已在 mod.rs 入审批表；这里广播 UI 事件 + 状态。
            // params 是上游类型（Serialize），直接序列化给前端展示命令/cwd/建议决策。
            match serde_json::to_value(&params) {
                Ok(mut payload) => {
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("task_id".to_string(), serde_json::json!(task_id));
                    }
                    let _ = app.emit("codex-approval-requested", payload);
                }
                Err(e) => eprintln!("[codex_appserver] serialize approval: {e}"),
            }
            let _ = app.emit(
                "task-status",
                serde_json::json!({ "task_id": task_id, "status": "input_required" }),
            );
            crate::system_notify::notify_task_event(
                app,
                task_id,
                crate::system_notify::NotifyCategory::Confirm,
                None,
            );
            true
        }
        CodexEvent::UnsupportedServerRequest { .. } => {
            // mod.rs 已自动拒绝；事件不必下发前端
            true
        }
        CodexEvent::Ignored { .. } | CodexEvent::Unknown { .. } => true,
        CodexEvent::Initialized { .. } | CodexEvent::ThreadStatusChanged { .. } => true,
        CodexEvent::TurnStarted { .. } => true,
        // 数据面事件统一进 Channel（前端按 type 分发）
        CodexEvent::ItemStarted { thread_id, turn_id, item } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, "item", "started", &item);
            true
        }
        CodexEvent::ItemCompleted { thread_id, turn_id, item } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, "item", "completed", &item);
            true
        }
        CodexEvent::AgentMessageDelta { thread_id, turn_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, "agentMessageDelta", "delta", &serde_json::json!({ "delta": delta }));
            true
        }
        CodexEvent::ReasoningSummaryDelta { thread_id, turn_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, "reasoningDelta", "delta", &serde_json::json!({ "delta": delta }));
            true
        }
        CodexEvent::CommandExecutionOutputDelta { thread_id, turn_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, "commandOutputDelta", "delta", &serde_json::json!({ "delta": delta }));
            true
        }
        CodexEvent::TokenUsageUpdated { thread_id, usage } => {
            emit_stream_event(on_output, task_id, thread_id, String::new(), "tokenUsage", "updated", &usage);
            true
        }
    }
}

/// 数据面事件 → Channel 结构化 JSON（前端 `useCodexStream` 消费）。
/// 顶层形状：`{ taskId, type, phase, threadId, turnId, payload }`。
/// Channel 是 per-task 独占通路（与 PTY 的 on_output 同款直投，绕开事件总线
/// 广播——这是终端红线的同款约束），生命周期事件（task-status 等）才走 emit。
fn emit_stream_event(
    on_output: &Channel<String>,
    task_id: &str,
    thread_id: String,
    turn_id: String,
    kind: &str,
    phase: &str,
    payload: &impl serde::Serialize,
) {
    let frame = StreamFrame {
        task_id,
        kind,
        phase,
        thread_id: &thread_id,
        turn_id: &turn_id,
        payload: serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    };
    let line = serde_json::to_string(&frame).unwrap_or_default();
    let _ = on_output.send(line);
}

/// Channel 数据帧。字段名 camelCase 对齐前端约定。
#[derive(serde::Serialize)]
struct StreamFrame<'a> {
    #[serde(rename = "taskId")]
    task_id: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    phase: &'a str,
    #[serde(rename = "threadId")]
    thread_id: &'a str,
    #[serde(rename = "turnId")]
    turn_id: &'a str,
    payload: serde_json::Value,
}

fn emit_task_session(app: &AppHandle, task_id: &str, thread: &ThreadInfo) {
    let _ = app.emit(
        "task-session",
        serde_json::json!({
            "task_id": task_id,
            "session_id": thread.session_id,
            "session_path": thread.path.clone().unwrap_or_default(),
        }),
    );
}

/// turn 完成 → done。无人值守任务的前端自动收尾走 hook 事件（PTY 路径），
/// structured 路径这里直接置终态；通知语义与 PTY 的 exit monitor 对齐。
fn emit_done(app: &AppHandle, task_id: &str, unattended: bool) {
    let _ = app.emit(
        "task-status",
        serde_json::json!({ "task_id": task_id, "status": "done" }),
    );
    if !unattended {
        crate::system_notify::notify_task_event(
            app,
            task_id,
            crate::system_notify::NotifyCategory::Complete,
            None,
        );
    }
}

fn emit_failed(app: &AppHandle, task_id: &str, reason: &str) {
    let _ = app.emit(
        "task-status",
        serde_json::json!({ "task_id": task_id, "status": "failed", "failure_reason": reason }),
    );
    crate::system_notify::notify_task_event(
        app,
        task_id,
        crate::system_notify::NotifyCategory::Failed,
        Some(reason),
    );
}

/// structured 任务的取消：中断运行中的 turn 后优雅关闭会话。
/// 幂等：会话不存在（未启动/已收尾）时直接返回。
pub async fn cancel_structured_task(task_id: &str, task_manager: &crate::TaskManager) {
    let Some(session) = take_session(task_manager, task_id) else {
        return;
    };
    // turn 运行中先 interrupt（实测干净返回 turn/completed{interrupted}）；
    // 失败也无妨——shutdown 的 kill 路径兜底。
    let _ = session.interrupt().await;
    session.shutdown_shared().await;
}

/// 应答审批（命令 `respond_codex_approval` 的实现体）。
/// 决策合法性（availableDecisions）校验在 `respond_approval` 内。
pub async fn respond_approval(
    task_manager: &crate::TaskManager,
    task_id: &str,
    request_id: i64,
    action: ApprovalAction,
) -> Result<(), String> {
    let session = take_session_impl(task_manager, task_id)
        .ok_or_else(|| "structured session not found for task".to_string())?;
    session
        .respond_approval(codex_app_server_protocol::RequestId::Integer(request_id), action)
        .await
        .map_err(|e| format!("{e:?}"))
}

/// 只读借用（不移除）：审批应答不应终结会话。
fn take_session_impl(
    task_manager: &crate::TaskManager,
    task_id: &str,
) -> Option<Arc<CodexAppServerSession>> {
    task_manager
        .codex_appserver_sessions
        .lock()
        .get(task_id)
        .map(|e| e.session.clone())
}

/// 应答 structured 任务的命令执行审批（计划 2.5）。
/// `action` 取 `approve` / `decline` / `cancel`；决策不在服务端
/// `availableDecisions` 建议子集内时返回错误（不静默替换）。
/// 成功后回 `running` 状态——forwarder 的后续通知会继续修正。
#[tauri::command]
pub async fn respond_codex_approval(
    app: AppHandle,
    task_manager: State<'_, crate::TaskManager>,
    task_id: String,
    request_id: i64,
    action: String,
) -> Result<(), String> {
    let action = match action.as_str() {
        "approve" => ApprovalAction::Approve,
        "decline" => ApprovalAction::Decline,
        "cancel" => ApprovalAction::Cancel,
        other => return Err(format!("unknown approval action: {other}")),
    };
    respond_approval(&task_manager, &task_id, request_id, action).await?;
    let _ = app.emit(
        "task-status",
        serde_json::json!({ "task_id": task_id, "status": "running" }),
    );
    Ok(())
}

/// 检查状态机当前是否在等审批（`get_active_task_ids` 等上层判断用不上时忽略）。
pub fn session_phase(task_manager: &crate::TaskManager, task_id: &str) -> Option<SessionPhase> {
    task_manager
        .codex_appserver_sessions
        .lock()
        .get(task_id)
        .map(|e| e.session.status().phase)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mode_maps_to_policy_pairs() {
        assert_eq!(
            permission_mode_to_policy("ask"),
            ("untrusted", "read-only")
        );
        assert_eq!(
            permission_mode_to_policy("auto_edit"),
            ("on-request", "workspace-write")
        );
        assert_eq!(
            permission_mode_to_policy("full_access"),
            ("never", "danger-full-access")
        );
        // 未知取值保守落回最受限档
        assert_eq!(permission_mode_to_policy(""), ("untrusted", "read-only"));
        assert_eq!(
            permission_mode_to_policy("nonsense"),
            ("untrusted", "read-only")
        );
    }

    #[test]
    fn is_structured_requires_codex_and_mode() {
        let base = |agent: &str, run_mode: Option<&str>| Task {
            id: "t".into(),
            project_id: "p".into(),
            name: None,
            prompt: String::new(),
            agent: agent.into(),
            permission_mode: "ask".into(),
            run_mode: run_mode.map(Into::into),
            model: None,
            reasoning_effort: None,
            status: "pending".into(),
            created_at: 0,
            updated_at: None,
            attention_requested_at: None,
            claude_session_id: None,
            claude_session_path: None,
            codex_session_id: None,
            codex_session_path: None,
            dsh_session_id: None,
            dsh_session_path: None,
            starred: None,
            failure_reason: None,
            worktree_path: None,
            worktree_branch: None,
            worktree_repo: None,
            base_branch: None,
            delivery_plan_id: None,
            branch_kind: None,
            worktree_discarded: None,
            additions: None,
            deletions: None,
            yunxiao_workitem_id: None,
            yunxiao_serial_number: None,
            yunxiao_written_back_at: None,
            yunxiao_comment_id: None,
            knowledge_issue_ids: vec![],
            derived_from_task_id: None,
            derived_from_workitem_id: None,
            plan_id: None,
            plan_deps_ignored: None,
            yunxiao_plan_discussion: None,
            unattended: None,
            context_project_ids: vec![],
        };
        assert!(is_structured(&base("codex", Some("structured"))));
        // 非 structured 模式 / 非 codex 一律 PTY
        assert!(!is_structured(&base("codex", Some("pty"))));
        assert!(!is_structured(&base("codex", None)));
        assert!(!is_structured(&base("claude", Some("structured"))));
        // 云效直发任务即使误标 structured 也走 PTY（2.2a 防线由 run_task 兜底，
        // 这里验证判据本身不带云效豁免——豁免在分流点显式检查）
        assert!(is_structured(&base("codex", Some("structured"))));
    }

    #[test]
    fn stream_frame_serializes_camel_case() {
        let frame = StreamFrame {
            task_id: "t1",
            kind: "agentMessageDelta",
            phase: "delta",
            thread_id: "th1",
            turn_id: "turn1",
            payload: serde_json::json!({ "delta": "hi" }),
        };
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["taskId"], "t1");
        assert_eq!(v["type"], "agentMessageDelta");
        assert_eq!(v["threadId"], "th1");
        assert_eq!(v["turnId"], "turn1");
        assert_eq!(v["payload"]["delta"], "hi");
    }
}
