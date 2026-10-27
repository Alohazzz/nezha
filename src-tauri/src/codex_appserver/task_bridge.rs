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
use super::{
    CodexAppServerSession, CodexEvent, SessionError, SessionPhase, SpawnRequest, ThreadInfo,
    TurnInputItem,
};
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
/// guard 与 forwarder 成对登记：turn 进行中用户取消 / 重置任务时先 cancel，
/// 再关会话——否则 turn/interrupt 触发的 `turn/completed{interrupted}` 等
/// 迟到事件会照常 emit，把已收口任务的状态打翻（与启动失败收口同防线）。
pub struct StructuredTaskEntry {
    pub session: Arc<CodexAppServerSession>,
    pub guard: ForwarderGuard,
}

/// forwarder 取消句柄（启动失败收口用）。置位后 forwarder 对后续到达的事件/
/// 错误**不再 emit 任何状态与通知**，只走清表退出——`turn/start` 超时时 turn
/// 可能实际已在跑，迟到的 approval/turn/completed 若照发，会把前端已经降级
/// 重跑的 PTY 任务状态打翻（4.1 回退降级的竞态防线）。
#[derive(Clone)]
pub struct ForwarderGuard {
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

impl ForwarderGuard {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// structured 模式的启动参数：由 `run_task` 分流点从命令参数归集。
pub struct StructuredLaunch {
    pub task_id: String,
    pub project_path: String,
    pub prompt: String,
    /// 首轮图片附件（dataUrl，可为空）：落盘后以 localImage 输入项进首个 turn
    /// （issue #118）。落盘发生在 `run_structured_task`（会话拉起前）。
    pub images: Vec<String>,
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

/// spawn 会话并按 threadId 恢复既有 thread（done 后继续对话，阶段 4 增强）。
/// 恢复复用当前 permissionMode 的审批/沙箱档——thread/resume 的 override 参数
/// 缺省时沿用 thread 原设置，这里显式传入与 Nezha 权限档保持一致。
pub async fn spawn_session_resume(
    agent_bin: &str,
    cwd: &str,
    permission_mode: &str,
    thread_id: &str,
) -> Result<CodexAppServerSession, SessionError> {
    let (approval_policy, sandbox) = permission_mode_to_policy(permission_mode);
    let request = SpawnRequest::codex_app_server(agent_bin, cwd, approval_policy, sandbox);
    let session = CodexAppServerSession::spawn(request).await?;
    session.resume_thread(thread_id).await?;
    Ok(session)
}

/// 注册会话到 TaskManager（cancel/complete/respond 命令可寻址）。
/// guard 与会话同表登记，取消/重置路径据此收口 forwarder 的迟到通知。
pub fn register_session(
    task_manager: &crate::TaskManager,
    task_id: &str,
    session: Arc<CodexAppServerSession>,
    guard: ForwarderGuard,
) {
    task_manager.codex_appserver_sessions.lock().insert(
        task_id.to_string(),
        StructuredTaskEntry { session, guard },
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
///
/// 返回 `ForwarderGuard`：启动序列（spawn → turn/start）失败时先 `cancel()`
/// 再收口会话，保证降级重跑后迟到的通知不会污染新任务状态。
pub fn spawn_forwarder(
    app: AppHandle,
    task_id: String,
    unattended: bool,
    on_output: Channel<String>,
    mut events: Receiver<CodexEvent>,
    mut errors: Receiver<SessionError>,
) -> ForwarderGuard {
    let guard = ForwarderGuard::new();
    let guard_for_loop = guard.clone();
    tokio::spawn(async move {
        // 先挂错误流再进事件循环：进程秒退时 EOF 错误可能先于残留事件到达
        loop {
            if guard_for_loop.is_cancelled() {
                break;
            }
            tokio::select! {
                event = events.recv() => {
                    match event {
                        Ok(event) => {
                            if guard_for_loop.is_cancelled()
                                || !handle_event(&app, &on_output, &task_id, unattended, event).await
                            {
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
                            if guard_for_loop.is_cancelled() {
                                break;
                            }
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
        // forwarder 退出即会话终结：清表 + 显式关闭子进程（与 PTY 的 cancel 收尾对齐）。
        // 不能指望 kill_on_drop 兜底：child 句柄活在 SessionCore 里，reader task
        // 持有 Arc<SessionCore> 直到进程退出——不显式 shutdown 的话引用计数永不
        // 归零，app-server 进程泄漏后占住 thread 写锁，resume 会撞
        // "already has an active writer"。forwarder 是唯一消费方，状态经
        // app.state 自取（State 不是 'static，无法捕获）。
        if let Some(tm) = app.try_state::<crate::TaskManager>() {
            if let Some(session) = take_session(&tm, &task_id) {
                session.shutdown_shared().await;
            }
        }
        crate::event_watcher::cleanup_task_events(&task_id);
        // 任务附件（steer/resume 带图的落盘产物）随任务收尾清理（issue #118）。
        // project root 从 task_real_paths 取；缺省（极端时序）则目录残留无害——
        // cancel_task / complete_task 路径仍会按前端传入的 project_path 清一次。
        if let Some(tm) = app.try_state::<crate::TaskManager>() {
            let project_path = tm.task_real_paths.lock().get(&task_id).cloned();
            if let Some(project_path) = project_path {
                let dir =
                    crate::attachments::task_attachments_dir(&project_path, &task_id);
                let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
            }
        }
    });
    guard
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
        CodexEvent::ApprovalRequested { request_id, params } => {
            // 反向请求已在 mod.rs 入审批表；这里广播 UI 事件 + 状态。
            // params 是上游类型（Serialize），直接序列化给前端展示命令/cwd/建议决策；
            // request_id 必须随事件下发——前端审批卡片回传 respond_codex_approval 全靠它。
            match serde_json::to_value(&params) {
                Ok(mut payload) => {
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("task_id".to_string(), serde_json::json!(task_id));
                        obj.insert("request_id".to_string(), serde_json::json!(request_id));
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
        // 数据面事件统一进 Channel（前端按 type 分发）。delta 类事件带 item_id，
        // 前端靠它把流式增量归并到 item/started 建立的那条条目上。
        CodexEvent::ItemStarted { thread_id, turn_id, item } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, None, "item", "started", &item);
            true
        }
        CodexEvent::ItemCompleted { thread_id, turn_id, item } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, None, "item", "completed", &item);
            true
        }
        CodexEvent::AgentMessageDelta { thread_id, turn_id, item_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, Some(item_id), "agentMessageDelta", "delta", &serde_json::json!({ "delta": delta }));
            true
        }
        CodexEvent::ReasoningSummaryDelta { thread_id, turn_id, item_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, Some(item_id), "reasoningDelta", "delta", &serde_json::json!({ "delta": delta }));
            true
        }
        CodexEvent::CommandExecutionOutputDelta { thread_id, turn_id, item_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, Some(item_id), "commandOutputDelta", "delta", &serde_json::json!({ "delta": delta }));
            true
        }
        CodexEvent::TokenUsageUpdated { thread_id, usage } => {
            emit_stream_event(on_output, task_id, thread_id, String::new(), None, "tokenUsage", "updated", &usage);
            true
        }
    }
}

/// 数据面事件 → Channel 结构化 JSON（前端 `useCodexStream` 消费）。
/// 顶层形状：`{ taskId, type, phase, itemId?, threadId, turnId, payload }`。
/// Channel 是 per-task 独占通路（与 PTY 的 on_output 同款直投，绕开事件总线
/// 广播——这是终端红线的同款约束），生命周期事件（task-status 等）才走 emit。
fn emit_stream_event(
    on_output: &Channel<String>,
    task_id: &str,
    thread_id: String,
    turn_id: String,
    item_id: Option<String>,
    kind: &str,
    phase: &str,
    payload: &impl serde::Serialize,
) {
    let frame = StreamFrame {
        task_id,
        kind,
        phase,
        item_id: item_id.as_deref(),
        thread_id: &thread_id,
        turn_id: &turn_id,
        payload: serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    };
    let line = serde_json::to_string(&frame).unwrap_or_default();
    let _ = on_output.send(line);
}

/// Channel 数据帧。字段名 camelCase 对齐前端约定；itemId 仅 delta 类事件携带。
#[derive(serde::Serialize)]
struct StreamFrame<'a> {
    #[serde(rename = "taskId")]
    task_id: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    phase: &'a str,
    #[serde(rename = "itemId", skip_serializing_if = "Option::is_none")]
    item_id: Option<&'a str>,
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

/// structured 任务的继续对话（done 后输入框提交，阶段 4 增强）：
/// spawn 新 app-server 进程 → `thread/resume` 恢复上下文 → 重挂 forwarder → 发起新 turn。
/// 与 `run_structured_task` 同序登记；失败即返回 Err，前端 toast。
pub async fn resume_structured_task(
    app: AppHandle,
    task_manager: &crate::TaskManager,
    task_id: String,
    project_path: String,
    permission_mode: String,
    thread_id: String,
    prompt: String,
    images: Vec<String>,
    on_output: Channel<String>,
) -> Result<(), String> {
    // 图片落盘先于会话拉起：落盘失败直接 Err，不留下半启动的会话。
    let image_paths = save_structured_images(&project_path, &task_id, images).await?;
    let launch_spec = crate::app_settings::get_agent_launch_spec("codex");
    let session = spawn_session_resume(
        &launch_spec.program,
        &project_path,
        &permission_mode,
        &thread_id,
    )
    .await
    .map_err(|e| format!("codex app-server resume failed: {e:?}"))?;
    let session = Arc::new(session);

    // 与 run_task 同序的登记：清取消/手动完成标记（done 后继续对话是新的一轮）。
    task_manager.cancelled_tasks.lock().remove(&task_id);
    task_manager.manually_completed_tasks.lock().remove(&task_id);
    task_manager.unattended_tasks.lock().remove(&task_id);
    task_manager.task_names.lock().remove(&task_id);

    // 先起 forwarder 拿 guard，与会话成对登记：取消/重置路径据此收口迟到通知。
    let events = session.subscribe();
    let errors = session.subscribe_errors();
    // 继续对话默认有人值守：unattended=false 让完成通知正常发。
    let guard = spawn_forwarder(app.clone(), task_id.clone(), false, on_output, events, errors);
    register_session(task_manager, &task_id, session.clone(), guard.clone());

    let _ = app.emit(
        "task-status",
        serde_json::json!({ "task_id": task_id, "status": "running" }),
    );

    // turn/start 失败：先取消 forwarder（迟到通知不得污染任务状态），
    // 再收口会话子进程，最后把错误交回前端 toast。
    if let Err(e) = session.start_turn_with_input(&build_turn_input(prompt, image_paths)).await {
        guard.cancel();
        if let Some(tm) = app.try_state::<crate::TaskManager>() {
            if let Some(session) = take_session(&tm, &task_id) {
                session.shutdown_shared().await;
            }
        }
        return Err(format!("turn/start failed: {e:?}"));
    }
    Ok(())
}

/// structured 任务的继续对话命令（前端 done 态输入框提交）。
/// `threadId` 用任务快照里的 `codexSessionId`（thread id，rollout 可从磁盘恢复）。
#[tauri::command]
pub async fn resume_codex_structured(
    app: AppHandle,
    task_manager: State<'_, crate::TaskManager>,
    task_id: String,
    project_path: String,
    permission_mode: String,
    thread_id: String,
    prompt: String,
    images: Option<Vec<String>>,
    on_output: Channel<String>,
) -> Result<(), String> {
    let images = images.unwrap_or_default();
    if prompt.trim().is_empty() && images.is_empty() {
        return Err("prompt and images are both empty".to_string());
    }
    resume_structured_task(
        app,
        &task_manager,
        task_id,
        project_path,
        permission_mode,
        thread_id,
        prompt,
        images,
        on_output,
    )
    .await
}

/// structured 任务运行中的追加指令（Paseo 式 composer：运行中发送 = steer）。
/// 只读借用活会话走上游 `turn/steer`——当前 turn 不中断，文本并入执行队列；
/// 会话不存在（未启动/已收尾）时返回 Err，前端回落 resume 通道。
/// `images` 为 dataUrl 数组：落盘后以 `localImage` 输入项随文本进 input
/// （issue #118）；纯图片发送时 prompt 可为空。
#[tauri::command]
pub async fn steer_codex_structured(
    task_manager: State<'_, crate::TaskManager>,
    task_id: String,
    project_path: String,
    prompt: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    let images = images.unwrap_or_default();
    if prompt.trim().is_empty() && images.is_empty() {
        return Err("prompt and images are both empty".to_string());
    }
    let image_paths = save_structured_images(&project_path, &task_id, images).await?;
    let input = build_turn_input(prompt, image_paths);
    let session = take_session_impl(&task_manager, &task_id)
        .ok_or_else(|| "structured session not active for task".to_string())?;
    session
        .steer_with_input(&input)
        .await
        .map_err(|e| format!("turn/steer failed: {e:?}"))
}

/// input 数组组装：非空文本在前、图片在后（TurnInputItem 顺序约定，issue #118）。
pub(crate) fn build_turn_input(prompt: String, image_paths: Vec<String>) -> Vec<TurnInputItem> {
    let mut input = Vec::with_capacity(image_paths.len() + 1);
    if !prompt.trim().is_empty() {
        input.push(TurnInputItem::Text(prompt));
    }
    input.extend(image_paths.into_iter().map(|path| TurnInputItem::LocalImage { path }));
    input
}

/// structured 链路的图片落盘：dataUrl → `.nezha/attachments/<taskId>/`，
/// 与 PTY 链路同一目录同一清理时点。路径校验与 PTY 命令同等级
/// （AGENTS.md 安全规范）；同步 I/O 走 spawn_blocking。
pub(crate) async fn save_structured_images(
    project_path: &str,
    task_id: &str,
    images: Vec<String>,
) -> Result<Vec<String>, String> {
    if images.is_empty() {
        return Ok(vec![]);
    }
    crate::pty::validate_task_project_path(project_path)?;
    // task_id 会拼进附件目录名：拒绝路径分隔符，防目录穿越。
    if task_id.is_empty() || task_id.contains('/') || task_id.contains('\\') || task_id.contains("..") {
        return Err("Invalid task id".to_string());
    }
    let project_path = project_path.to_string();
    let task_id = task_id.to_string();
    tokio::task::spawn_blocking(move || crate::attachments::save_task_images(&project_path, &task_id, &images))
        .await
        .map_err(|e| format!("image save task failed: {e}"))?
}

/// structured 任务的取消：中断运行中的 turn 后优雅关闭会话。
/// 幂等：会话不存在（未启动/已收尾）时直接返回。
pub async fn cancel_structured_task(task_id: &str, task_manager: &crate::TaskManager) {
    let Some(entry) = task_manager
        .codex_appserver_sessions
        .lock()
        .remove(task_id)
    else {
        return;
    };
    // 先收口 forwarder：turn/interrupt 会回 `turn/completed{interrupted}`，
    // 不 cancel 的话这个迟到事件会把取消误报成 failed（还带系统通知）。
    entry.guard.cancel();
    // turn 运行中先 interrupt（实测干净返回 turn/completed{interrupted}）；
    // 失败也无妨——shutdown 的 kill 路径兜底。
    let _ = entry.session.interrupt().await;
    entry.session.shutdown_shared().await;
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
            item_id: Some("item1"),
            thread_id: "th1",
            turn_id: "turn1",
            payload: serde_json::json!({ "delta": "hi" }),
        };
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["taskId"], "t1");
        assert_eq!(v["type"], "agentMessageDelta");
        assert_eq!(v["itemId"], "item1");
        assert_eq!(v["threadId"], "th1");
        assert_eq!(v["turnId"], "turn1");
        assert_eq!(v["payload"]["delta"], "hi");

        // item 类事件不带 itemId：字段应整体省略而不是下发 null
        let frame = StreamFrame {
            task_id: "t1",
            kind: "item",
            phase: "started",
            item_id: None,
            thread_id: "th1",
            turn_id: "turn1",
            payload: serde_json::json!({ "type": "agentMessage" }),
        };
        let v = serde_json::to_value(&frame).unwrap();
        assert!(v.get("itemId").is_none());
    }
}
