//! codex app-server 结构化接入的阶段 1 客户端模块(issue #116)。
//!
//! 每个任务一个 `codex app-server` 子进程实例,经 stdio 走 JSON-RPC(无
//! `"jsonrpc":"2.0"` 字段的变体,见 `rpc.rs`)。PTY 路径仍是默认与回退,本模块
//! **不触碰** `pty.rs` / `TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts`
//! 红线文件;阶段 2 才由 `run_task` 入口分流。
//!
//! 模块布局:
//! - `rpc.rs`     — JSON-RPC 帧 + pending 应答表 + 请求 id 分配
//! - `events.rs`  — 通知/反向请求 → `CodexEvent`(未知方法容错跳过)
//! - `approval.rs`— 审批决策枚举映射与应答构造(0.163 新枚举,findings D1)
//!
//! AGENTS.md 合规:锁用 `parking_lot` 且临界区内无 I/O;子进程 `kill_on_drop(true)`;
//! spawn 时 Windows 注入 `CREATE_NO_WINDOW`。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use codex_app_server_protocol as proto;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};
use tokio::time::timeout;

pub mod approval;
pub mod events;
pub mod rpc;
pub mod task_bridge;

pub use events::{CodexEvent, ThreadInfo};
pub use task_bridge::StructuredTaskEntry;

use rpc::{IncomingFrame, PendingTable, RequestIdAllocator, RpcError};

/// 优雅关闭等待窗口:先关 stdin 让对端自然退出,超时再杀(参照 Paseo 常量)。
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
/// 优雅关闭失败后的强杀等待窗口。
const SHUTDOWN_FORCE: Duration = Duration::from_secs(1);
/// 客户端请求的默认超时(initialize/thread/start/turn/start 都远快于此;
/// turn/start 是异步语义立即返回,真正的执行完成走通知,D3)。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 会话状态机(计划 1.4)。映射到现有 TaskStatus 的关系:
/// `TurnRunning` → running;`AwaitingApproval` → input_required;
/// `Failed` → failed;`Idle`(turn 完成)→ done 由上层按 turn/completed 判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    /// 进程已 spawn,initialize 握手未完成。
    Starting,
    /// 空闲:有 thread,无运行中的 turn。
    Idle,
    /// turn 运行中。
    TurnRunning,
    /// 等待审批反向请求应答。
    AwaitingApproval,
    /// 进程意外退出或协议错误,会话不可用。
    Failed,
}

/// 会话对外状态快照。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionStatus {
    pub phase: SessionPhase,
    pub thread: Option<ThreadInfo>,
    /// 当前运行中的 turn id(TurnRunning 时非空)。
    pub current_turn_id: Option<String>,
}

/// 会话级致命错误(进程退出 / 协议失步)。经错误流通知上层。
#[derive(Debug, Clone, PartialEq)]
pub enum SessionError {
    SpawnFailed(String),
    ProcessExited { code: Option<i32> },
    Protocol(String),
}

/// 审批等待表条目:反向请求到达后暂存,等待 `respond_approval`。
pub struct PendingApproval {
    pub params: proto::CommandExecutionRequestApprovalParams,
}

/// `/model` `/effort` 内置命令的会话级模型 override:写入后每个新 turn/start
/// 都带上;运行中的 turn 由 `update_turn_settings`（turn/settings/update）即时生效。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelOverride {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// 共享内核:reader task 与对外句柄共同持有。
struct SessionCore {
    pending: PendingTable,
    ids: RequestIdAllocator,
    events_tx: broadcast::Sender<CodexEvent>,
    errors_tx: broadcast::Sender<SessionError>,
    status: parking_lot::Mutex<SessionStatusInternal>,
    approvals: parking_lot::Mutex<HashMap<proto::RequestId, PendingApproval>>,
    cwd: String,
    approval_policy: String,
    sandbox: String,
    /// 子进程句柄:reader 在 EOF 后用它取退出码;shutdown 用它杀进程。
    child: AsyncMutex<Child>,
    /// 子进程 stdin:reader 直接写回不支持的反向请求应答(auto-decline)。
    stdin: AsyncMutex<tokio::process::ChildStdin>,
}

/// 状态机内部表示(parking_lot 同步锁,临界区只做字段读写)。
#[derive(Debug, Clone, PartialEq)]
struct SessionStatusInternal {
    phase: SessionPhase,
    thread: Option<ThreadInfo>,
    current_turn_id: Option<String>,
    /// 会话级模型 override（`/model` `/effort` 内置命令写入）；新 turn/start 带。
    model_override: ModelOverride,
}

impl Default for SessionStatusInternal {
    fn default() -> Self {
        Self {
            phase: SessionPhase::Starting,
            thread: None,
            current_turn_id: None,
            model_override: ModelOverride::default(),
        }
    }
}

/// spawn 参数:程序路径、附加参数与环境变量(测试 re-exec mock 进程、
/// 阶段 2 传 `--enable` 实验特性都走这里)。
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub extra_envs: Vec<(String, String)>,
    /// thread/start 用的审批策略(untrusted / on-request / never)。
    pub approval_policy: String,
    /// thread/start 用的沙箱模式(read-only / workspace-write / danger-full-access)。
    pub sandbox: String,
}

impl SpawnRequest {
    /// 标准 codex app-server 启动请求。
    pub fn codex_app_server(program: &str, cwd: &str, approval_policy: &str, sandbox: &str) -> Self {
        Self {
            program: program.to_string(),
            args: vec!["app-server".to_string()],
            cwd: cwd.to_string(),
            extra_envs: Vec::new(),
            approval_policy: approval_policy.to_string(),
            sandbox: sandbox.to_string(),
        }
    }
}

/// 一次 codex app-server 会话(句柄)。子进程句柄与 stdin 在 `SessionCore`
/// 里共享;`Drop` 经 `kill_on_drop` 兜底杀进程。
pub struct CodexAppServerSession {
    core: Arc<SessionCore>,
}

/// turn 输入项:turn/start 与 turn/steer 的 input 数组元素（issue #118）。
/// wire 形状 = codex-app-server-protocol `UserInput`（tagged camelCase）：
/// `{"type":"text","text":..}` / `{"type":"localImage","path":..}`——传本地
/// 路径由 Codex 自行读图，不内联数据。顺序约定：文本在前、图片在后。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnInputItem {
    Text(String),
    LocalImage { path: String },
}

impl TurnInputItem {
    fn to_wire(&self) -> serde_json::Value {
        match self {
            TurnInputItem::Text(text) => json!({ "type": "text", "text": text }),
            TurnInputItem::LocalImage { path } => json!({ "type": "localImage", "path": path }),
        }
    }
}

impl CodexAppServerSession {
    /// spawn `codex app-server` 并完成 initialize 握手。
    pub async fn spawn(request: SpawnRequest) -> Result<Self, SessionError> {
        let mut command = Command::new(&request.program);
        command
            .args(&request.args)
            .current_dir(&request.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, value) in &request.extra_envs {
            command.env(key, value);
        }
        crate::subprocess::configure_background_tokio_command(&mut command);

        let codex_bin = request.program.clone();
        let mut child = command.spawn().map_err(|e| {
            SessionError::SpawnFailed(format!("spawn `{codex_bin}`: {e}"))
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SessionError::SpawnFailed("stdin unavailable".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SessionError::SpawnFailed("stdout unavailable".to_string()))?;

        // delta 高频(实测 ~100 条/短回复),事件通道容量放宽;错误低频给小
        let (events_tx, _) = broadcast::channel(4096);
        let (errors_tx, _) = broadcast::channel(16);

        let core = Arc::new(SessionCore {
            pending: PendingTable::new(),
            ids: RequestIdAllocator::new(),
            events_tx,
            errors_tx,
            status: parking_lot::Mutex::new(SessionStatusInternal::default()),
            approvals: parking_lot::Mutex::new(HashMap::new()),
            cwd: request.cwd.clone(),
            approval_policy: request.approval_policy.clone(),
            sandbox: request.sandbox.clone(),
            child: AsyncMutex::new(child),
            stdin: AsyncMutex::new(stdin),
        });

        spawn_reader(core.clone(), stdout);

        let session = Self { core };
        session.initialize().await?;
        Ok(session)
    }

    /// initialize 握手:发请求、等应答、版本门控、置 Idle。
    async fn initialize(&self) -> Result<(), SessionError> {
        let params = proto::InitializeParams {
            client_info: proto::ClientInfo {
                name: "nezha".to_string(),
                title: Some("Nezha".to_string()),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            capabilities: Some(proto::InitializeCapabilities {
                experimental_api: true,
                ..Default::default()
            }),
        };
        let serialized = serde_json::to_value(&params)
            .map_err(|e| SessionError::Protocol(format!("serialize initialize: {e}")))?;
        let result = self
            .request("initialize", serialized)
            .await
            .map_err(|e| SessionError::Protocol(format!("initialize: {e}")))?;
        let response: proto::InitializeResponse = serde_json::from_value(result)
            .map_err(|e| SessionError::Protocol(format!("parse initialize: {e}")))?;

        // 版本地板 ≥0.156(findings §8.6):userAgent 形如
        // `codex_cli_rs/0.163.0 (Windows 10.0.26200; x86_64) xterm-256color`。
        // 与 `app_settings::CODEX_STRUCTURED_FLOOR`(UI 层前置探测)同源,改动须同步。
        if let Some(version) = parse_codex_version(&response.user_agent) {
            if version < (0, 156) {
                return Err(SessionError::Protocol(format!(
                    "codex {version:?} is below the structured-mode floor 0.156; use PTY mode"
                )));
            }
        }

        let _ = self.send_notification("initialized", json!({})).await;
        self.core.status.lock().phase = SessionPhase::Idle;
        Ok(())
    }

    /// 启动新 thread:cwd/approvalPolicy/sandbox 在 spawn 时已定,这里复用。
    pub async fn start_thread(&self) -> Result<ThreadInfo, SessionError> {
        let (cwd, approval_policy, sandbox) = {
            let core = &self.core;
            (core.cwd.clone(), core.approval_policy.clone(), core.sandbox.clone())
        };
        let params = json!({
            "cwd": cwd,
            "approvalPolicy": approval_policy,
            "sandbox": sandbox,
        });
        let result = self
            .request("thread/start", params)
            .await
            .map_err(|e| SessionError::Protocol(format!("thread/start: {e}")))?;
        // 不用上游 ThreadStartResponse:其内嵌 Thread 结构必填字段多且随版本
        // 膨胀(D6,0.163 已 31 键),宽松解析只取任务系统需要的字段。
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ThreadWire {
            id: String,
            #[serde(default)]
            session_id: String,
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            model: Option<String>,
            #[serde(default)]
            model_provider: Option<String>,
            #[serde(default)]
            cwd: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct StartResultWire {
            thread: ThreadWire,
        }
        let response: StartResultWire = serde_json::from_value(result)
            .map_err(|e| SessionError::Protocol(format!("parse thread/start: {e}")))?;
        let info = ThreadInfo {
            id: response.thread.id.clone(),
            session_id: {
                // 实测 sessionId == id(UUIDv7);缺省回落 id 保持兼容
                if response.thread.session_id.is_empty() {
                    response.thread.id.clone()
                } else {
                    response.thread.session_id.clone()
                }
            },
            // 统一 strip `\\?\` 防御(findings §5,resume 返回带前缀)
            path: response.thread.path.as_ref().map(|p| strip_verbatim_prefix(p)),
            model: response.thread.model.clone(),
            model_provider: response.thread.model_provider.clone(),
            cwd: response.thread.cwd.clone(),
            _rest: serde_json::Value::Null,
        };
        self.core.status.lock().thread = Some(info.clone());
        Ok(info)
    }

    /// 按 threadId 恢复已有 thread（done 后继续对话，阶段 4 增强）。
    /// rollout 文件从磁盘加载回上下文；path 仅作一致性校验传回。
    pub async fn resume_thread(&self, thread_id: &str) -> Result<ThreadInfo, SessionError> {
        let params = json!({ "threadId": thread_id });
        let result = self
            .request("thread/resume", params)
            .await
            .map_err(|e| SessionError::Protocol(format!("thread/resume: {e}")))?;
        // 与 start_thread 同款宽松解析（上游 Thread Serialize-only / 键位膨胀）
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ThreadWire {
            id: String,
            #[serde(default)]
            session_id: String,
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            model: Option<String>,
            #[serde(default)]
            model_provider: Option<String>,
            #[serde(default)]
            cwd: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ResumeResultWire {
            thread: ThreadWire,
        }
        let response: ResumeResultWire = serde_json::from_value(result)
            .map_err(|e| SessionError::Protocol(format!("parse thread/resume: {e}")))?;
        let info = ThreadInfo {
            id: response.thread.id.clone(),
            session_id: {
                if response.thread.session_id.is_empty() {
                    response.thread.id.clone()
                } else {
                    response.thread.session_id.clone()
                }
            },
            path: response.thread.path.as_ref().map(|p| strip_verbatim_prefix(p)),
            model: response.thread.model.clone(),
            model_provider: response.thread.model_provider.clone(),
            cwd: response.thread.cwd.clone(),
            _rest: serde_json::Value::Null,
        };
        self.core.status.lock().thread = Some(info.clone());
        Ok(info)
    }
    pub async fn start_turn(&self, prompt: &str) -> Result<String, SessionError> {
        self.start_turn_with_input(&[TurnInputItem::Text(prompt.to_string())])
            .await
    }
    /// turn/start 带混合输入（issue #118）：input 数组按调用方给的顺序组装
    /// （文本在前、图片在后），wire 元素形状见 `TurnInputItem::to_wire`。
    pub async fn start_turn_with_input(
        &self,
        input: &[TurnInputItem],
    ) -> Result<String, SessionError> {
        let thread_id = self
            .core
            .status
            .lock()
            .thread
            .as_ref()
            .map(|t| t.id.clone())
            .ok_or_else(|| SessionError::Protocol("thread not started".to_string()))?;
        let wire_input: Vec<serde_json::Value> = input.iter().map(|i| i.to_wire()).collect();
        let override_snapshot = {
            let status = self.core.status.lock();
            status.model_override.clone()
        };
        let params = build_turn_start_params(thread_id, wire_input, &override_snapshot);
        let result = self
            .request("turn/start", params)
            .await
            .map_err(|e| SessionError::Protocol(format!("turn/start: {e}")))?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TurnWire {
            id: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TurnStartResultWire {
            turn: TurnWire,
        }
        let response: TurnStartResultWire = serde_json::from_value(result)
            .map_err(|e| SessionError::Protocol(format!("parse turn/start: {e}")))?;
        let turn_id = response.turn.id;
        {
            let mut status = self.core.status.lock();
            status.phase = SessionPhase::TurnRunning;
            status.current_turn_id = Some(turn_id.clone());
        }
        Ok(turn_id)
    }

    /// 中断当前 turn。实测干净返回:`turn/completed{status:"interrupted"}`
    /// 随后到达,映射 `TaskStatus::interrupted`(findings §7)。
    pub async fn interrupt(&self) -> Result<(), SessionError> {
        let (thread_id, turn_id) = {
            let status = self.core.status.lock();
            let thread = status.thread.as_ref().map(|t| t.id.clone());
            let turn = status.current_turn_id.clone();
            (thread, turn)
        };
        let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) else {
            return Ok(()); // 无运行中 turn,幂等成功
        };
        let params = json!({ "threadId": thread_id, "turnId": turn_id });
        self.request("turn/interrupt", params)
            .await
            .map_err(|e| SessionError::Protocol(format!("turn/interrupt: {e}")))?;
        Ok(())
    }

    /// 向运行中的 turn 追加输入(上游 `turn/steer`)。composer 的「运行中发送」
    /// 走这里。`expectedTurnId` 是上游的乐观锁前置条件:必须等于当前活跃 turn,
    /// 不匹配(如 turn 恰好刚结束)服务端直接拒绝。
    pub async fn steer(&self, text: &str) -> Result<(), SessionError> {
        self.steer_with_input(&[TurnInputItem::Text(text.to_string())])
            .await
    }
    /// turn/steer 带混合输入（issue #118）：input 组装同 `start_turn_with_input`。
    pub async fn steer_with_input(&self, input: &[TurnInputItem]) -> Result<(), SessionError> {
        let (thread_id, turn_id) = {
            let status = self.core.status.lock();
            let thread = status.thread.as_ref().map(|t| t.id.clone());
            let turn = status.current_turn_id.clone();
            (thread, turn)
        };
        let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) else {
            return Err(SessionError::Protocol("no running turn to steer".to_string()));
        };
        let wire_input: Vec<serde_json::Value> = input.iter().map(|i| i.to_wire()).collect();
        let params = json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": wire_input,
        });
        self.request("turn/steer", params)
            .await
            .map_err(|e| SessionError::Protocol(format!("turn/steer: {e}")))?;
        Ok(())
    }

    /// 运行中热更新模型 / 推理深度(上游 `turn/settings/update`,experimental)。
    /// 只影响当前运行中的 turn(以及按上游语义其后续捕获的步骤);无运行中
    /// turn 时返回 targetUnavailable 语义的 Err,调用方回落下一轮 override。
    /// `model` / `effort` 均可独立省略(见 SetModelRequest)。
    pub async fn update_turn_settings(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<(), SessionError> {
        let (thread_id, turn_id) = {
            let status = self.core.status.lock();
            let thread = status.thread.as_ref().map(|t| t.id.clone());
            let turn = status.current_turn_id.clone();
            (thread, turn)
        };
        let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) else {
            return Err(SessionError::Protocol("no running turn to update".to_string()));
        };
        let mut params = json!({
            "threadId": thread_id,
            "turnId": turn_id,
        });
        let obj = params.as_object_mut().expect("params is object");
        if let Some(model) = model {
            obj.insert("model".to_string(), json!(model));
        }
        if let Some(effort) = effort {
            obj.insert("effort".to_string(), json!(effort));
        }
        let result = self
            .request("turn/settings/update", params)
            .await
            .map_err(|e| SessionError::Protocol(format!("turn/settings/update: {e}")))?;
        // status == "targetUnavailable" 表示没有存活的发布目标(turn 恰好结束),
        // 按可重试错误交上层回落
        if result.get("status").and_then(serde_json::Value::as_str) == Some("targetUnavailable") {
            return Err(SessionError::Protocol("turn settings target unavailable".to_string()));
        }
        Ok(())
    }

    /// 设置会话级模型 override（`/model` `/effort` 内置命令的落点）：
    /// `None` 字段保持不变；显式清空用 `Some(None)`（内部存 `Some(String)` 才下发）。
    /// 这里只写状态不发包——生效路径有两个：运行中的 turn 由调用方再调
    /// `update_turn_settings` 热更；后续 turn 由 `start_turn_with_input` 携带。
    pub fn set_model_override(&self, model: Option<Option<&str>>, effort: Option<Option<&str>>) {
        let mut status = self.core.status.lock();
        if let Some(model) = model {
            status.model_override.model = model.map(str::to_string);
        }
        if let Some(effort) = effort {
            status.model_override.effort = effort.map(str::to_string);
        }
    }

    /// 当前会话级模型 override 快照（前端回显当前选择用）。
    pub fn model_override(&self) -> ModelOverride {
        self.core.status.lock().model_override.clone()
    }

    /// 压缩上下文（`/compact` 内置命令）：上游 `thread/compact/start`。压缩过程
    /// 作为特殊 turn 跑，`thread/compacted` 通知与 item 事件照常经 forwarder
    /// 流给前端；完成/失败由 turn 生命周期事件收口。
    pub async fn compact_thread(&self) -> Result<(), SessionError> {
        let thread_id = self
            .core
            .status
            .lock()
            .thread
            .as_ref()
            .map(|t| t.id.clone())
            .ok_or_else(|| SessionError::Protocol("thread not started".to_string()))?;
        self.request("thread/compact/start", json!({ "threadId": thread_id }))
            .await
            .map_err(|e| SessionError::Protocol(format!("thread/compact/start: {e}")))?;
        Ok(())
    }

    /// 审当前未提交变更（`/review` 内置命令）：上游 `review/start`，inline 跑在
    /// 当前 thread 上，结果作为普通 item 流回前端。
    pub async fn start_review_uncommitted(&self) -> Result<(), SessionError> {
        let thread_id = self
            .core
            .status
            .lock()
            .thread
            .as_ref()
            .map(|t| t.id.clone())
            .ok_or_else(|| SessionError::Protocol("thread not started".to_string()))?;
        let params = json!({
            "threadId": thread_id,
            "target": { "type": "uncommittedChanges" },
        });
        self.request("review/start", params)
            .await
            .map_err(|e| SessionError::Protocol(format!("review/start: {e}")))?;
        Ok(())
    }

    /// 应答审批反向请求。决策经 `availableDecisions` 校验,不在建议子集内
    /// 返回错误(不静默替换,让上层决定降级策略)。
    pub async fn respond_approval(
        &self,
        request_id: proto::RequestId,
        action: approval::ApprovalAction,
    ) -> Result<(), SessionError> {
        let params = {
            let approvals = self.core.approvals.lock();
            approvals
                .get(&request_id)
                .map(|p| p.params.clone())
                .ok_or_else(|| {
                    SessionError::Protocol("approval request not found/expired".to_string())
                })?
        };
        if !approval::is_action_available(&params, action) {
            return Err(SessionError::Protocol(format!(
                "decision {action:?} not in availableDecisions"
            )));
        }
        let result = approval::encode_decision_result(action)
            .map_err(|e| SessionError::Protocol(format!("encode decision: {e}")))?;
        let line = rpc::encode_response(&request_id, &result);
        self.write_line(&line)
            .await
            .map_err(|e| SessionError::Protocol(format!("write approval response: {e}")))?;
        // 审批应答后回到 turn 运行态;后续通知会继续修正
        let mut status = self.core.status.lock();
        if status.phase == SessionPhase::AwaitingApproval {
            status.phase = SessionPhase::TurnRunning;
        }
        Ok(())
    }

    /// 订阅事件流(delta / turn 生命周期 / 审批请求都从这里出)。
    pub fn subscribe(&self) -> broadcast::Receiver<CodexEvent> {
        self.core.events_tx.subscribe()
    }

    pub fn subscribe_errors(&self) -> broadcast::Receiver<SessionError> {
        self.core.errors_tx.subscribe()
    }

    /// 当前状态快照。
    pub fn status(&self) -> SessionStatus {
        let internal = self.core.status.lock().clone();
        SessionStatus {
            phase: internal.phase,
            thread: internal.thread,
            current_turn_id: internal.current_turn_id,
        }
    }

    /// 优雅关闭：关 stdin → 等 2s → 杀 → 再等 1s(kill_on_drop 最终兜底)。
    pub async fn shutdown(self) {
        Self::shutdown_shared(Arc::new(self)).await;
    }

    /// `Arc` 持有者专用的关闭入口：会话表里的句柄是 `Arc`，取消/完成路径
    /// 取走后直接调用，不必拆 Arc。
    pub async fn shutdown_shared(self: Arc<Self>) {
        // 关 stdin 触发对端 EOF;锁内只做 shutdown 调用,不持锁做别的 I/O
        {
            let mut stdin = self.core.stdin.lock().await;
            let _ = stdin.shutdown().await;
        }
        let mut child = self.core.child.lock().await;
        match timeout(SHUTDOWN_GRACE, child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                let _ = child.start_kill();
                let _ = timeout(SHUTDOWN_FORCE, child.wait()).await;
            }
        }
    }

    // ---- 内部 ----

    /// 带 id 的请求:登记 pending 表 → 写帧 → 等应答(带超时)。
    async fn request(
        &self,
        method: &'static str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, RpcError> {
        let id = self.core.ids.allocate();
        let (tx, rx) = oneshot::channel();
        assert!(
            self.core.pending.insert(id.clone(), method, tx),
            "duplicate request id {id}"
        );
        let line = rpc::encode_request(&id, method, &params);
        self.write_line(&line).await.map_err(|e| RpcError {
            code: -1,
            message: format!("write failed: {e}"),
            data: None,
        })?;
        match timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_recv)) => Err(RpcError {
                code: -1,
                message: format!("{method}: reader dropped (process exited?)"),
                data: None,
            }),
            Err(_) => {
                self.core.pending.remove(&id);
                Err(RpcError { code: -2, message: format!("{method}: timed out"), data: None })
            }
        }
    }

    async fn send_notification(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), String> {
        let frame = serde_json::json!({ "method": method, "params": params });
        let mut out = frame.to_string();
        out.push('\n');
        self.write_line(&out).await
    }

    async fn write_line(&self, line: &str) -> Result<(), String> {
        let mut stdin = self.core.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }
}

impl Drop for CodexAppServerSession {
    fn drop(&mut self) {
        // 进程回收不能指望 kill_on_drop：child 句柄在 SessionCore 里，reader
        // task 持有 Arc<SessionCore> 直到进程退出，本 drop 时引用计数通常未
        // 归零，Child 不会随之 drop。上层收尾路径必须显式 shutdown_shared()。
        // 这里只广播失败态给还挂着的订阅者。
        let _ = self.core.errors_tx.send(SessionError::ProcessExited { code: None });
    }
}

/// 读循环:stdout 逐行 → 帧 → pending 表 / 事件流 / 审批表。
fn spawn_reader(core: Arc<SessionCore>, stdout: tokio::process::ChildStdout) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) if line.trim().is_empty() => continue,
                Ok(Some(line)) => handle_wire_line(&core, &line).await,
                Ok(None) | Err(_) => {
                    // EOF 或读错误:进程退出,等退出码后广播(SessionError)。
                    // stdout EOF 时进程可能尚在收尾,try_wait 会竞态返回 None,
                    // 必须用 wait() 等真正退出。
                    core.status.lock().phase = SessionPhase::Failed;
                    let code = {
                        let mut child = core.child.lock().await;
                        child.wait().await.ok().and_then(|s| s.code())
                    };
                    let _ = core
                        .errors_tx
                        .send(SessionError::ProcessExited { code });
                    break;
                }
            }
        }
    });
}

/// 处理一行 wire 输出。解析失败只记 dev log,绝不让读循环崩溃。
async fn handle_wire_line(core: &SessionCore, line: &str) {
    let Some(frame) = rpc::parse_frame(line) else {
        eprintln!("[codex_appserver] unparsable line: {line:.200}");
        return;
    };
    match frame {
        IncomingFrame::Response { id, result, error } => {
            let outcome = match (result, error) {
                (Some(result), _) => Ok(result),
                (None, Some(err)) => Err(err),
                (None, None) => Err(RpcError {
                    code: -1,
                    message: "empty response".to_string(),
                    data: None,
                }),
            };
            if core.pending.resolve(&id, outcome).is_none() {
                eprintln!("[codex_appserver] response for unknown id {id}");
            }
        }
        IncomingFrame::ServerRequest { id, method, params } => {
            match events::parse_event(IncomingFrame::ServerRequest { id, method, params }) {
                Ok(CodexEvent::ApprovalRequested { request_id, params }) => {
                    // 置状态 + 入审批表 + 广播,三步都不做 I/O
                    {
                        let mut status = core.status.lock();
                        if status.phase == SessionPhase::TurnRunning {
                            status.phase = SessionPhase::AwaitingApproval;
                        }
                    }
                    core.approvals
                        .lock()
                        .insert(request_id.clone(), PendingApproval { params: params.clone() });
                    let _ = core.events_tx.send(CodexEvent::ApprovalRequested {
                        request_id,
                        params,
                    });
                }
                Ok(CodexEvent::UnsupportedServerRequest { request_id, method }) => {
                    eprintln!("[codex_appserver] unsupported server request {method}; auto-declining");
                    // 自动拒绝防 turn 卡死:reader 持有 stdin,直接写回应答
                    let line = rpc::encode_response(
                        &request_id,
                        &serde_json::json!({ "decision": "decline" }),
                    );
                    let mut stdin = core.stdin.lock().await;
                    let _ = stdin.write_all(line.as_bytes()).await;
                    let _ = stdin.flush().await;
                    drop(stdin);
                    let _ = core
                        .events_tx
                        .send(CodexEvent::UnsupportedServerRequest { request_id, method });
                }
                Ok(other) => {
                    let _ = core.events_tx.send(other);
                }
                Err(reason) => {
                    eprintln!("[codex_appserver] server request parse failed: {reason:.200}");
                }
            }
        }
        IncomingFrame::Notification { method, params } => {
            match events::parse_event(IncomingFrame::Notification { method, params }) {
                Ok(event) => {
                    // 状态机随通知修正(通知是唯一事实源,API 调用只是发起方)
                    match &event {
                        CodexEvent::TurnStarted { turn_id, .. } => {
                            let mut status = core.status.lock();
                            status.phase = SessionPhase::TurnRunning;
                            status.current_turn_id = Some(turn_id.clone());
                        }
                        CodexEvent::TurnCompleted { .. } => {
                            let mut status = core.status.lock();
                            status.phase = SessionPhase::Idle;
                            status.current_turn_id = None;
                        }
                        _ => {}
                    }
                    let _ = core.events_tx.send(event);
                }
                Err(reason) => {
                    eprintln!("[codex_appserver] notification parse failed: {reason:.200}");
                }
            }
        }
    }
}

/// turn/start 参数构造（含会话级模型 override）。override 字段只在非 None 时
/// 下发：上游 `TurnStartParams.model/effort` 是「override 本 turn 及后续 turn」，
/// 缺省沿用 thread 已记住的设置，不带空键。
fn build_turn_start_params(
    thread_id: String,
    wire_input: Vec<serde_json::Value>,
    model_override: &ModelOverride,
) -> serde_json::Value {
    let mut params = json!({
        "threadId": thread_id,
        "input": wire_input,
    });
    let obj = params.as_object_mut().expect("params is object");
    if let Some(model) = model_override.model.as_deref() {
        obj.insert("model".to_string(), json!(model));
    }
    if let Some(effort) = model_override.effort.as_deref() {
        obj.insert("effort".to_string(), json!(effort));
    }
    params
}

/// 从 `codex_cli_rs/0.163.0 ...` 提取 (major, minor)。
pub fn parse_codex_version(user_agent: &str) -> Option<(u32, u32)> {
    let rest = user_agent.strip_prefix("codex_cli_rs/")?;
    let mut parts = rest.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// 去掉 Windows extended-length 前缀 `\\?\`(findings §5:thread/resume 的
/// path 带此前缀,不 strip 会被 `validate_session_path` 拒读)。
pub fn strip_verbatim_prefix(path: &str) -> String {
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

#[cfg(test)]
impl SessionCore {
    /// 测试用内核:child 是立即退出的占位子进程(仅满足类型,断言不触碰它)。
    fn test_core() -> Arc<Self> {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/c", "exit"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = tokio::process::Command::new("true");
            c
        };
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn dummy child");
        let stdin = child.stdin.take().expect("dummy stdin");
        Arc::new(Self {
            pending: PendingTable::new(),
            ids: RequestIdAllocator::new(),
            events_tx: broadcast::channel(16).0,
            errors_tx: broadcast::channel(16).0,
            status: parking_lot::Mutex::new(SessionStatusInternal::default()),
            approvals: parking_lot::Mutex::new(HashMap::new()),
            cwd: ".".to_string(),
            approval_policy: "untrusted".to_string(),
            sandbox: "read-only".to_string(),
            child: AsyncMutex::new(child),
            stdin: AsyncMutex::new(stdin),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing() {
        let ua = "codex_cli_rs/0.163.0 (Windows 10.0.26200; x86_64) xterm-256color";
        assert_eq!(parse_codex_version(ua), Some((0, 163)));
        assert_eq!(parse_codex_version("unknown"), None);
        assert_eq!(parse_codex_version("codex_cli_rs/x.y"), None);
    }

    #[test]
    fn turn_start_params_carry_model_override_only_when_set() {
        let input = vec![TurnInputItem::Text("hi".to_string())];
        let wire: Vec<serde_json::Value> = input.iter().map(|i| i.to_wire()).collect();

        // 无 override：不出现 model/effort 键（缺省沿用 thread 设置）
        let params = build_turn_start_params("t1".into(), wire.clone(), &ModelOverride::default());
        assert_eq!(params["threadId"], "t1");
        assert!(params.get("model").is_none());
        assert!(params.get("effort").is_none());

        // 双 override：camelCase 键原样下发
        let params = build_turn_start_params(
            "t1".into(),
            wire,
            &ModelOverride {
                model: Some("gpt-5.2".into()),
                effort: Some("high".into()),
            },
        );
        assert_eq!(params["model"], "gpt-5.2");
        assert_eq!(params["effort"], "high");
    }

    #[test]
    fn model_override_set_and_clear() {
        let core = SessionCore::test_core();
        let session = CodexAppServerSession { core };
        assert_eq!(session.model_override(), ModelOverride::default());

        session.set_model_override(Some(Some("gpt-5.2")), Some(Some("low")));
        assert_eq!(
            session.model_override(),
            ModelOverride {
                model: Some("gpt-5.2".into()),
                effort: Some("low".into()),
            }
        );

        // None 字段保持不变；Some(None) 显式清空
        session.set_model_override(Some(None), None);
        assert_eq!(
            session.model_override(),
            ModelOverride {
                model: None,
                effort: Some("low".into()),
            }
        );
    }

    #[test]
    fn verbatim_prefix_stripped() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\SuYi\.codex\sessions\a.jsonl"),
            r"C:\Users\SuYi\.codex\sessions\a.jsonl"
        );
        assert_eq!(
            strip_verbatim_prefix(r"C:\Users\SuYi\.codex\sessions\a.jsonl"),
            r"C:\Users\SuYi\.codex\sessions\a.jsonl"
        );
        assert_eq!(strip_verbatim_prefix("/home/u/.codex/x.jsonl"), "/home/u/.codex/x.jsonl");
    }

    #[tokio::test]
    async fn status_machine_transitions_on_turn_lifecycle() {
        let core = SessionCore::test_core();
        assert_eq!(core.status.lock().phase, SessionPhase::Starting);

        // 模拟 turn/started → TurnRunning(status 是裸字符串枚举,实测样本形状)
        handle_wire_line(
            &core,
            r#"{"method":"turn/started","params":{"threadId":"t1","turn":{"id":"turn1","status":"inProgress","items":[]}}}"#,
        )
        .await;
        assert_eq!(core.status.lock().phase, SessionPhase::TurnRunning);

        // 审批请求 → AwaitingApproval
        handle_wire_line(
            &core,
            r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"t1","turnId":"turn1","itemId":"i1","startedAtMs":1,"availableDecisions":["accept","decline","cancel"]}}"#,
        )
        .await;
        assert_eq!(core.status.lock().phase, SessionPhase::AwaitingApproval);
        assert_eq!(core.approvals.lock().len(), 1);

        // turn/completed → Idle
        handle_wire_line(
            &core,
            r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"completed","items":[]}}}"#,
        )
        .await;
        let status = core.status.lock().clone();
        assert_eq!(status.phase, SessionPhase::Idle);
        assert_eq!(status.current_turn_id, None);
    }

    #[tokio::test]
    async fn unknown_notification_is_tolerated_not_fatal() {
        let core = SessionCore::test_core();
        handle_wire_line(&core, r#"{"method":"brand/new/method","params":{}}"#).await;
        assert_eq!(core.status.lock().phase, SessionPhase::Starting);
        handle_wire_line(&core, "totally not json").await;
        assert_eq!(core.status.lock().phase, SessionPhase::Starting);
    }
}
