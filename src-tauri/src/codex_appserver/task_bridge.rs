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
use std::time::Duration;

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
    /// 任务名（系统通知文案用；与 PTY 路径的 `task_names` 登记同语义）。
    pub task_name: String,
    /// agent 的 cwd（可能是 worktree）。
    pub project_path: String,
    /// 真实项目根（主检出）：项目配置、图谱绑定、草稿收拢都按它定位。
    pub real_project_path: String,
    pub prompt: String,
    /// 首轮图片附件（dataUrl，可为空）：落盘后以 localImage 输入项进首个 turn
    /// （issue #118）。落盘发生在 `run_structured_task`（会话拉起前）。
    pub images: Vec<String>,
    /// 首轮文本附件正文：落盘到附件目录后以路径追加进提示词（与 PTY 同语义）。
    pub texts: Vec<String>,
    /// 本任务要求产出知识沉淀产物：决定是否注入产出契约、收尾是否跑沉淀。
    pub sediment_required: bool,
    pub permission_mode: String,
    pub unattended: bool,
    /// 任务快照携带的模型 / 推理深度（新建任务表单选择）：经 turn/start 的
    /// model/effort override 下发（与 PTY 的 `--model` 语义对齐）。
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

/// 判定任务是否应走 structured 通道（2.2 分流判据）。云效生产链路不再特殊：
/// 运行通道由任务快照（应用级设置写入）决定，`run_task` 侧与这里同判据。
pub fn is_structured(task: &Task) -> bool {
    task.agent == "codex" && task.run_mode.as_deref() == Some("structured")
}

/// spawn `codex app-server` 会话并完成 initialize + thread/start。
/// 版本地板（≥0.156）与握手超时由 `CodexAppServerSession::spawn` / `initialize` 负责。
pub async fn spawn_session(
    agent_bin: &str,
    cwd: &str,
    permission_mode: &str,
    extra_envs: Vec<(String, String)>,
) -> Result<CodexAppServerSession, SessionError> {
    let (approval_policy, sandbox) = permission_mode_to_policy(permission_mode);
    let mut request = SpawnRequest::codex_app_server(agent_bin, cwd, approval_policy, sandbox);
    request.extra_envs = extra_envs;
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
    extra_envs: Vec<(String, String)>,
) -> Result<CodexAppServerSession, SessionError> {
    let (approval_policy, sandbox) = permission_mode_to_policy(permission_mode);
    let mut request = SpawnRequest::codex_app_server(agent_bin, cwd, approval_policy, sandbox);
    request.extra_envs = extra_envs;
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
/// `auto_answer_questions`（full_access 专属）：模型提问照常弹卡片，但 30s
/// 无人应答时自动按推荐项（首个 option）应答，turn 不无限挂起。
///
/// 返回 `ForwarderGuard`：启动序列（spawn → turn/start）失败时先 `cancel()`
/// 再收口会话，保证降级重跑后迟到的通知不会污染新任务状态。
pub fn spawn_forwarder(
    app: AppHandle,
    task_id: String,
    // agent 的 cwd（可能是 worktree）；收尾时据此收拢草稿到真实项目根。
    effective_path: String,
    unattended: bool,
    auto_answer_questions: bool,
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
                                || !handle_event(&app, &on_output, &task_id, &effective_path, unattended, auto_answer_questions, event).await
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
        // 任务附件（首轮 / steer / resume 带图的落盘产物）随任务收尾清理：
        // 落盘用的是 agent cwd（可能是 worktree），清理也必须按同一个路径，
        // 不能用 task_real_paths（主检出）。cancel_task / complete_task 仍会
        // 按前端传入的 project_path 再清一次。
        {
            let dir = crate::attachments::task_attachments_dir(&effective_path, &task_id);
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
        }
    });
    guard
}

/// full_access 下模型提问的自动应答等待窗口。30s 足够在场用户点掉卡片，
/// 又不至于让无人值守任务干等——到期即按推荐项（首个 option）继续。
const USER_INPUT_AUTO_ANSWER_MS: u64 = 30_000;

/// full_access 专属：模型提问 30s 无人应答时按推荐项自动应答。
///
/// 取消安全：`respond_user_input_once` 先原子取走 pending 条目再应答——用户
/// 先答（`respond_user_input` 会删条目）、任务被取消收口（forwarder 退出时
/// `shutdown_shared`，会话表已清）都会让这里取到 None 而静默放弃，不存在
/// 答复写到已关闭进程的路径。应答成功后广播 `codex-user-input-auto-answered`，
/// 前端把问答卡片转成「已自动选择」态。
fn spawn_user_input_auto_answer(
    app: AppHandle,
    task_id: String,
    request_id: codex_app_server_protocol::RequestId,
    params: codex_app_server_protocol::ToolRequestUserInputParams,
) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(USER_INPUT_AUTO_ANSWER_MS)).await;
        let Some(tm) = app.try_state::<crate::TaskManager>() else {
            return;
        };
        let Some(session) = take_session(&tm, &task_id) else {
            return; // 会话已收口/降级，问题随进程终结，无需应答
        };
        let answers = super::recommended_answers(&params);
        match session.respond_user_input_once(request_id.clone(), answers).await {
            Ok(true) => {
                let _ = app.emit(
                    "codex-user-input-auto-answered",
                    serde_json::json!({
                        "task_id": task_id,
                        "request_id": request_id,
                    }),
                );
                let _ = app.emit(
                    "task-status",
                    serde_json::json!({ "task_id": task_id, "status": "running" }),
                );
            }
            Ok(false) => {} // 用户先答了或已被应答，静默让位
            Err(e) => eprintln!("[codex_appserver] auto answer user input: {e:?}"),
        }
    });
}

/// 处理单个事件。返回 false 表示会话已终结（turn 完成/失败），forwarder 应退出。
async fn handle_event(
    app: &AppHandle,
    on_output: &Channel<String>,
    task_id: &str,
    effective_path: &str,
    unattended: bool,
    auto_answer_questions: bool,
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
                    finish_done(app, task_id, effective_path, unattended).await;
                    false
                }
                codex_app_server_protocol::TurnStatus::Interrupted => {
                    // 用户主动中断（/stop 内置命令 / composer 停止按钮 / ESC →
                    // `interrupt_codex_structured`）：置 interrupted，与 PTY 模式
                    // ESC 中断同语义（可经 resume 恢复），不是 failed——失败态带
                    // 系统通知与失败横幅，主动打断不该报错。会话进程随 forwarder
                    // 退出被回收，继续对话走 thread/resume（rollout 已逐事件落盘）。
                    let _ = app.emit(
                        "task-status",
                        serde_json::json!({ "task_id": task_id, "status": "interrupted" }),
                    );
                    false
                }
                codex_app_server_protocol::TurnStatus::Failed => {
                    // 带上游的失败原因（TurnError.message）：早先写死 "turn failed"，
                    // 用户只能看到一句无信息量的话，看不出是配额、鉴权还是模型报错。
                    let reason = turn.error_message().unwrap_or_else(|| "turn failed".to_string());
                    emit_failed(app, task_id, &reason);
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
        CodexEvent::UserInputRequested { request_id, params } => {
            // 与审批同款：反向请求已在 mod.rs 入等待表，这里广播 UI 事件 + 置状态。
            // 前端问答卡片回传 `respond_codex_user_input` 靠 request_id。
            match serde_json::to_value(&params) {
                Ok(mut payload) => {
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("task_id".to_string(), serde_json::json!(task_id));
                        obj.insert("request_id".to_string(), serde_json::json!(request_id));
                        // full_access 下卡片会倒计时自动选推荐项，前端据此渲染提示。
                        if auto_answer_questions {
                            obj.insert(
                                "auto_answer_timeout_ms".to_string(),
                                serde_json::json!(USER_INPUT_AUTO_ANSWER_MS),
                            );
                        }
                    }
                    let _ = app.emit("codex-user-input-requested", payload);
                }
                Err(e) => eprintln!("[codex_appserver] serialize user input: {e}"),
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
            if auto_answer_questions {
                spawn_user_input_auto_answer(
                    app.clone(),
                    task_id.to_string(),
                    request_id,
                    params,
                );
            }
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
        // item 帧透传信封毫秒时间戳（#119）：started → tsMs，completed → tsMs，
        // 前端据此做思考/命令的动态计时；缺失时字段省略，前端本地时钟兜底。
        CodexEvent::ItemStarted { thread_id, turn_id, item, started_at_ms } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, None, "item", "started", &item, started_at_ms);
            true
        }
        CodexEvent::ItemCompleted { thread_id, turn_id, item, completed_at_ms } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, None, "item", "completed", &item, completed_at_ms);
            true
        }
        CodexEvent::AgentMessageDelta { thread_id, turn_id, item_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, Some(item_id), "agentMessageDelta", "delta", &serde_json::json!({ "delta": delta }), None);
            true
        }
        CodexEvent::ReasoningSummaryDelta { thread_id, turn_id, item_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, Some(item_id), "reasoningDelta", "delta", &serde_json::json!({ "delta": delta }), None);
            true
        }
        CodexEvent::CommandExecutionOutputDelta { thread_id, turn_id, item_id, delta } => {
            emit_stream_event(on_output, task_id, thread_id, turn_id, Some(item_id), "commandOutputDelta", "delta", &serde_json::json!({ "delta": delta }), None);
            true
        }
        CodexEvent::FileChangeOutputDelta { thread_id, turn_id, item_id, delta } => {
            // 编辑 diff 增量:前端把 delta 追加到对应 fileChange 条目的 diff 上,
            // 编辑期间实时出内容(参照 ZCode 的编辑流式渲染),不再黑盒等 completed。
            emit_stream_event(on_output, task_id, thread_id, turn_id, Some(item_id), "fileChangeDelta", "delta", &serde_json::json!({ "delta": delta }), None);
            true
        }
        CodexEvent::TokenUsageUpdated { thread_id, usage } => {
            emit_stream_event(on_output, task_id, thread_id, String::new(), None, "tokenUsage", "updated", &usage, None);
            true
        }
    }
}

/// 数据面事件 → Channel 结构化 JSON（前端 `useCodexStream` 消费）。
/// 顶层形状：`{ taskId, type, phase, itemId?, tsMs?, threadId, turnId, payload }`。
/// Channel 是 per-task 独占通路（与 PTY 的 on_output 同款直投，绕开事件总线
/// 广播——这是终端红线的同款约束），生命周期事件（task-status 等）才走 emit。
#[allow(clippy::too_many_arguments)]
fn emit_stream_event(
    on_output: &Channel<String>,
    task_id: &str,
    thread_id: String,
    turn_id: String,
    item_id: Option<String>,
    kind: &str,
    phase: &str,
    payload: &impl serde::Serialize,
    ts_ms: Option<i64>,
) {
    let frame = StreamFrame {
        task_id,
        kind,
        phase,
        item_id: item_id.as_deref(),
        thread_id: &thread_id,
        turn_id: &turn_id,
        payload: serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
        ts_ms,
    };
    let line = serde_json::to_string(&frame).unwrap_or_default();
    let _ = on_output.send(line);
}

/// Channel 数据帧。字段名 camelCase 对齐前端约定；itemId 仅 delta 类事件携带，
/// tsMs 仅 item 帧透传信封时间戳（缺失时省略，前端本地时钟兜底）。
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
    #[serde(rename = "tsMs", skip_serializing_if = "Option::is_none")]
    ts_ms: Option<i64>,
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
///
/// **收尾前先把草稿与沉淀补齐**（与 PTY `finalize_task_exit` 同序）：Agent 可能
/// 把 `knowledge.json` / 回写产物写在 worktree 里，不先收拢到项目根，沉淀与云效
/// 回写都会读不到。structured 是「一个 turn 一个终态」，所以这里是它唯一的收尾点。
async fn finish_done(
    app: &AppHandle,
    task_id: &str,
    effective_path: &str,
    unattended: bool,
) {
    settle_task_artifacts(app, task_id, effective_path).await;
    emit_done(app, task_id, unattended);
}

/// 收拢草稿并触发知识沉淀（仅当本次启动标记了 require_sediment）。
/// 与 PTY 路径共用同一套集合（`task_real_paths` / `sediment_expected`），
/// 标记「取走即消费」，重复收尾不会双跑。
///
/// **必须先 await 草稿收拢再做沉淀**（与 PTY `finalize_task_exit` 同序）：worktree
/// 里的 `knowledge.json` 收拢到项目根之前，沉淀侧读不到产物，会被判成漏产出。
async fn settle_task_artifacts(app: &AppHandle, task_id: &str, effective_path: &str) {
    let Some(tm) = app.try_state::<crate::TaskManager>() else {
        return;
    };
    let sediment_expected = tm.take_sediment_marker(task_id);
    let Some(real_path) = tm.task_real_paths.lock().get(task_id).cloned() else {
        return;
    };
    let effective_path = effective_path.to_string();
    let task_id_for_gather = task_id.to_string();
    let real_for_gather = real_path.clone();
    let gathered = tokio::task::spawn_blocking(move || {
        crate::drafts::gather_task_drafts(
            &effective_path,
            &real_for_gather,
            &task_id_for_gather,
        )
    })
    .await;
    if let Err(e) = gathered {
        eprintln!("[codex_appserver] draft gather task failed: {e}");
    }
    if sediment_expected {
        crate::knowledge::spawn_auto_sedimentation(
            app.clone(),
            task_id.to_string(),
            real_path,
            "codex".to_string(),
        );
    }
}

/// 置任务终态并发送系统通知（纯事件发射，收尾动作见 `finish_done`）。
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
/// `model` / `effort`（任务快照的会话级 override，`/model` `/effort` 写入）经
/// resume 后的首个 turn/start 携带，与新建任务的 override 语义一致。
#[allow(clippy::too_many_arguments)]
pub async fn resume_structured_task(
    app: AppHandle,
    task_manager: &crate::TaskManager,
    task_id: String,
    project_path: String,
    permission_mode: String,
    thread_id: String,
    prompt: String,
    images: Vec<String>,
    model: Option<String>,
    effort: Option<String>,
    on_output: Channel<String>,
) -> Result<(), String> {
    // 图片落盘先于会话拉起：落盘失败直接 Err，不留下半启动的会话。
    let image_paths = save_structured_images(&project_path, &task_id, images).await?;
    let launch_spec = crate::app_settings::get_agent_launch_spec("codex");
    // 与 run_structured_task 同一套环境变量：续跑同样要能定位草稿目录 / 图谱。
    let extra_envs = crate::pty::structured_session_envs(&task_id, &project_path);
    let session = spawn_session_resume(
        &launch_spec.program,
        &project_path,
        &permission_mode,
        &thread_id,
        extra_envs,
    )
    .await
    .map_err(|e| format!("codex app-server resume failed: {e:?}"))?;
    let session = Arc::new(session);
    // 任务快照携带的模型 / 推理深度设为会话级 override（新进程新状态机，
    // 与 run_structured_task 同款写入；turn/start 携带，thread/resume 的
    // override 缺省时沿用 rollout 里的 thread 设置，这里以显式 override 为准）。
    if model.is_some() || effort.is_some() {
        session.set_model_override(model.as_deref().map(Some), effort.as_deref().map(Some));
    }

    // 与 run_task 同序的登记：清取消/手动完成标记（done 后继续对话是新的一轮）。
    task_manager.cancelled_tasks.lock().remove(&task_id);
    task_manager.manually_completed_tasks.lock().remove(&task_id);
    task_manager.unattended_tasks.lock().remove(&task_id);
    task_manager.task_names.lock().remove(&task_id);

    // 先起 forwarder 拿 guard，与会话成对登记：取消/重置路径据此收口迟到通知。
    let events = session.subscribe();
    let errors = session.subscribe_errors();
    // 继续对话默认有人值守：unattended=false 让完成通知正常发。
    // full_access 同新建任务：提问 30s 无人应答自动选推荐项。
    let guard = spawn_forwarder(
        app.clone(),
        task_id.clone(),
        project_path.clone(),
        false,
        permission_mode == "full_access",
        on_output,
        events,
        errors,
    );
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
/// `model` / `effort` 为任务快照的会话级 override（`/model` `/effort` 写入，
/// 缺省沿用 thread 原设置）。
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
    model: Option<String>,
    effort: Option<String>,
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
        model,
        effort,
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

/// structured 任务的中断当前 turn（/stop 内置命令 / composer 停止按钮 / ESC）：
/// 上游 `turn/interrupt`，与 `cancel_structured_task` 的区别是**不关会话**——
/// `turn/completed{interrupted}` 照常经 forwarder 到达并置任务 interrupted
/// （PTY 模式 ESC 同语义，可 resume 恢复），会话进程由 forwarder 退出统一回收。
/// 无运行中 turn 时 `interrupt` 幂等成功，无副作用。
#[tauri::command]
pub async fn interrupt_codex_structured(
    task_manager: State<'_, crate::TaskManager>,
    task_id: String,
) -> Result<(), String> {
    let session = take_session_impl(&task_manager, &task_id)
        .ok_or_else(|| "structured session not active for task".to_string())?;
    session
        .interrupt()
        .await
        .map_err(|e| format!("{e:?}"))
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

/// 应答 structured 任务的模型提问（`request_user_input` 工具）。
///
/// `answers` 是 question id → 用户选中的答案数组（多选即多条）。空 map 表示
/// 用户放弃作答——**必须回**，否则 core 侧 `rx_response.await` 让 turn 永挂。
/// 成功后回 `running` 状态，与审批应答同语义。
#[tauri::command]
pub async fn respond_codex_user_input(
    app: AppHandle,
    task_manager: State<'_, crate::TaskManager>,
    task_id: String,
    request_id: i64,
    answers: std::collections::HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let session = take_session_impl(&task_manager, &task_id)
        .ok_or_else(|| "structured session not found for task".to_string())?;
    session
        .respond_user_input(
            codex_app_server_protocol::RequestId::Integer(request_id),
            answers,
        )
        .await
        .map_err(|e| format!("{e:?}"))?;
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

/// structured 任务的模型切换（composer `/model` `/effort` 内置命令，对齐 Codex
/// CLI TUI 的同名能力）。`model` / `effort` 任一可空：
/// - `model` 传 `"default"`（或空串）表示清除 override 回到 thread 默认；
/// - 运行中有活 turn 时先经 `turn/settings/update` 热更当前 turn（失败不回滚——
///   turn 恰好刚结束时上游会拒绝，会话级 override 已写入，下一 turn 生效）。
/// 无活会话（done 态会话已收尾）**不算错误**：任务快照的 model/reasoningEffort
/// 由前端持久化，resume 拉起新会话时经 turn/start override 生效。
#[tauri::command]
pub async fn set_codex_structured_model(
    task_manager: State<'_, crate::TaskManager>,
    task_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    let normalized = |value: Option<String>| match value {
        Some(v) => {
            let trimmed = v.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        None => None,
    };
    let model = normalized(model);
    let effort = normalized(effort);
    // done 态（无活会话）直接成功——切换结果落任务快照，下次 resume 生效。
    let Some(session) = take_session_impl(&task_manager, &task_id) else {
        return Ok(());
    };
    // 会话级 override 是权威落点：无论当前是否有 turn，后续 turn/start 都带上。
    session.set_model_override(
        model.as_deref().map(Some),
        effort.as_deref().map(Some),
    );
    // 运行中的 turn 尝试热更；无 turn / turn 恰好结束都属良性（下一 turn 生效）。
    if session.status().phase == SessionPhase::TurnRunning {
        let _ = session.update_turn_settings(model.as_deref(), effort.as_deref()).await;
    }
    Ok(())
}

/// structured 任务的上下文压缩（composer `/compact` 内置命令，对齐 Codex CLI
/// TUI 同名能力）：上游 `thread/compact/start`。压缩作为特殊 turn 跑，进度与
/// 结果经既有 forwarder 事件流回前端；任务结束态由 turn/completed 收口。
/// done 态（无活会话）返回 Err——压缩需要活线程，前端 toast 提示。
#[tauri::command]
pub async fn compact_codex_structured(
    task_manager: State<'_, crate::TaskManager>,
    task_id: String,
) -> Result<(), String> {
    let session = take_session_impl(&task_manager, &task_id)
        .ok_or_else(|| "structured session not active for task".to_string())?;
    session
        .compact_thread()
        .await
        .map_err(|e| format!("{e:?}"))
}

/// structured 任务审查当前未提交变更（composer `/review` 内置命令）：上游
/// `review/start`，inline 跑在当前 thread，结果作为普通 item 流回前端。
#[tauri::command]
pub async fn review_codex_structured(
    task_manager: State<'_, crate::TaskManager>,
    task_id: String,
) -> Result<(), String> {
    let session = take_session_impl(&task_manager, &task_id)
        .ok_or_else(|| "structured session not active for task".to_string())?;
    session
        .start_review_uncommitted()
        .await
        .map_err(|e| format!("{e:?}"))
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
            unread_at: None,
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
            ts_ms: None,
        };
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["taskId"], "t1");
        assert_eq!(v["type"], "agentMessageDelta");
        assert_eq!(v["itemId"], "item1");
        assert_eq!(v["threadId"], "th1");
        assert_eq!(v["turnId"], "turn1");
        assert_eq!(v["payload"]["delta"], "hi");
        // tsMs 为 None 时字段整体省略而不是下发 null
        assert!(v.get("tsMs").is_none());

        // item 类事件不带 itemId；tsMs 有值时以 camelCase 下发（#119 信封时间戳）
        let frame = StreamFrame {
            task_id: "t1",
            kind: "item",
            phase: "started",
            item_id: None,
            thread_id: "th1",
            turn_id: "turn1",
            payload: serde_json::json!({ "type": "agentMessage" }),
            ts_ms: Some(1_792_725_191_199),
        };
        let v = serde_json::to_value(&frame).unwrap();
        assert!(v.get("itemId").is_none());
        assert_eq!(v["tsMs"], 1_792_725_191_199i64);
    }
}
