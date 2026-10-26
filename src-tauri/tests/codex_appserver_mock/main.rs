//! codex app-server mock 集成测试(阶段 1.5,计划表 1.5;findings §8.7)。
//!
//! `harness = false`:本文件自带 main。同一二进制两种角色:
//! - 子进程:环境变量 `NEZHA_MOCK_APPSERVER_SCRIPT` 存在时,进入 mock
//!   app-server 模式,按场景回放阶段 0 实测的 wire 形状(stdout 只含 wire 帧);
//! - 父进程:无该环境变量时,依次 re-exec 自身 spawn mock、驱动
//!   `CodexAppServerSession` 断言。不依赖真实 Codex 二进制,CI 可跑。
//!
//! 覆盖:initialize 握手、thread/start、turn/start + 通知流、审批反向请求
//! 应答(0.163 新决策枚举)、turn/interrupt、进程意外退出(退出码透传)。

use std::io::{BufRead, BufWriter, Write};
use std::process::ExitCode;

use codex_app_server_protocol as proto;
use nezha_lib::codex_appserver::{
    approval::ApprovalAction, CodexAppServerSession, CodexEvent, SessionError, SessionPhase,
    SpawnRequest,
};

/// mock 模式环境变量:值是场景名(happy / approval / crash)。
const MOCK_ENV: &str = "NEZHA_MOCK_APPSERVER_SCRIPT";

fn main() -> ExitCode {
    if let Ok(script) = std::env::var(MOCK_ENV) {
        mock_server_main(&script);
        return ExitCode::SUCCESS;
    }
    let results: Vec<(&str, bool)> = vec![
        ("happy_path", run_happy_path()),
        ("approval_flow", run_approval_flow()),
        ("interrupt_flow", run_interrupt_flow()),
        ("crash_exit_code", run_crash()),
    ];
    println!();
    let mut all_ok = true;
    for (name, ok) in &results {
        println!("test {name} ... {}", if *ok { "ok" } else { "FAILED" });
        all_ok &= *ok;
    }
    if all_ok {
        println!("test result: ok. {} passed", results.len());
        ExitCode::SUCCESS
    } else {
        println!("test result: FAILED");
        ExitCode::FAILURE
    }
}

// ================================================================ mock 实现

fn mock_server_main(script: &str) {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut out = BufWriter::new(stdout.lock());
    let mut line = String::new();

    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break; // EOF:父进程关闭管道
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let id = v.get("id").cloned();
        handle_mock_request(script, &method, id, &mut reader, &mut out);
    }
}

fn handle_mock_request(
    script: &str,
    method: &str,
    id: Option<serde_json::Value>,
    reader: &mut std::io::StdinLock<'static>,
    out: &mut BufWriter<std::io::StdoutLock<'static>>,
) {
    match (script, method) {
        // initialize / initialized 三个场景一致(实测应答形状)
        (_, "initialize") => respond(
            out,
            id,
            &serde_json::json!({
                "userAgent": "codex_cli_rs/0.163.0 (Windows 10.0.26200; x86_64) xterm-256color",
                "codexHome": "C:\\Users\\u\\.codex",
                "platformFamily": "windows",
                "platformOs": "windows",
            }),
        ),
        (_, "initialized") => {}
        // crash 场景:握手完成后的第一个请求触发 exit(101)
        ("crash", "thread/start") => {
            // 先把应答写出去再退,模拟"处理中崩溃"
            respond(out, id, &serde_json::json!({}));
            std::process::exit(101);
        }
        (scene, "thread/start") => {
            let thread_id = if scene == "approval" { "thread-approval" } else { "thread-happy" };
            emit_thread_started(out, thread_id);
            respond(
                out,
                id,
                &serde_json::json!({
                    "thread": thread_obj(thread_id),
                    "model": "glm",
                    "modelProvider": "openai_compat",
                    "cwd": "C:\\work",
                    // 实测形状:internally tagged
                    "approvalPolicy": "never",
                    "sandbox": { "type": "dangerFullAccess" },
                }),
            );
        }
        ("happy", "turn/start") => {
            // 异步语义(D3):立即应答,再推通知流
            respond(
                out,
                id,
                &serde_json::json!({
                    "turn": { "id": "turn-1", "status": "inProgress", "items": [], "itemsView": "notLoaded" },
                }),
            );
            let tid = "thread-happy";
            emit(
                out,
                &serde_json::json!({
                    "method": "turn/started",
                    "params": { "threadId": tid, "turn": { "id": "turn-1", "status": "inProgress", "items": [] } },
                })
                .to_string(),
            );
            emit(
                out,
                &serde_json::json!({
                    "method": "thread/status/changed",
                    "params": { "threadId": tid, "status": { "type": "active", "activeFlags": [] } },
                })
                .to_string(),
            );
            emit(
                out,
                &serde_json::json!({
                    "method": "item/started",
                    "params": { "threadId": tid, "turnId": "turn-1", "item": { "type": "agentMessage", "id": "m1", "text": "" } },
                })
                .to_string(),
            );
            // delta 连发(实测 ~100 条/短回复,3 条足以验证全量到达)
            for delta in ["你好", "，", "世界"] {
                emit(
                    out,
                    &serde_json::json!({
                        "method": "item/agentMessage/delta",
                        "params": { "threadId": tid, "turnId": "turn-1", "itemId": "m1", "delta": delta },
                    })
                    .to_string(),
                );
            }
            // 流到这里停:turn 仍 inProgress。item/completed + tokenUsage +
            // turn/completed 由后续请求推进(真实服务端也是流式推送,完成
            // 事件何时到取决于任务本身)。turn/steer 触发正常完成,turn/interrupt
            // 触发 interrupted 完成——两条路径都走真实协议方法。
        }
        ("happy", "turn/steer") => {
            respond(out, id, &serde_json::json!({}));
            let tid = "thread-happy";
            emit(
                out,
                &serde_json::json!({
                    "method": "item/completed",
                    "params": { "threadId": tid, "turnId": "turn-1", "item": { "type": "agentMessage", "id": "m1", "text": "你好，世界" } },
                })
                .to_string(),
            );
            emit(
                out,
                &serde_json::json!({
                    "method": "thread/tokenUsage/updated",
                    "params": { "threadId": tid, "turnId": "turn-1", "tokenUsage": {
                        "total": usage_breakdown(), "last": usage_breakdown(), "modelContextWindow": null,
                    } },
                })
                .to_string(),
            );
            emit(
                out,
                &serde_json::json!({
                    "method": "turn/completed",
                    "params": { "threadId": tid, "turn": { "id": "turn-1", "status": "completed", "items": [], "itemsView": "summary", "durationMs": 42.0 } },
                })
                .to_string(),
            );
        }
        ("approval", "turn/start") => {
            respond(
                out,
                id,
                &serde_json::json!({
                    "turn": { "id": "turn-a", "status": "inProgress", "items": [], "itemsView": "notLoaded" },
                }),
            );
            let tid = "thread-approval";
            emit(
                out,
                &serde_json::json!({
                    "method": "turn/started",
                    "params": { "threadId": tid, "turn": { "id": "turn-a", "status": "inProgress", "items": [] } },
                })
                .to_string(),
            );
            // 反向审批请求:id 从 0 起(独立 id 空间,D2);availableDecisions
            // 是实测 untrusted 子集的形状(findings §4)
            emit(
                out,
                &serde_json::json!({
                    "method": "item/commandExecution/requestApproval",
                    "id": 0,
                    "params": {
                        "kind": "command",
                        "threadId": tid,
                        "turnId": "turn-a",
                        "itemId": "cmd1",
                        "startedAtMs": 1792725262664_i64,
                        "command": "echo hi",
                        "cwd": "C:\\work",
                        "commandActions": [{ "type": "unknown", "command": "echo hi" }],
                        "availableDecisions": ["accept", "decline", "cancel"],
                    },
                })
                .to_string(),
            );
            // 等客户端应答,然后回执 + turn 完成(实测顺序,findings §4)
            let mut answer = String::new();
            if reader.read_line(&mut answer).unwrap_or(0) > 0 {
                emit(
                    out,
                    &serde_json::json!({
                        "method": "serverRequest/resolved",
                        "params": { "threadId": tid, "requestId": 0 },
                    })
                    .to_string(),
                );
                emit(
                    out,
                    &serde_json::json!({
                        "method": "turn/completed",
                        "params": { "threadId": tid, "turn": { "id": "turn-a", "status": "completed", "items": [] } },
                    })
                    .to_string(),
                );
            }
        }
        ("happy", "turn/interrupt") => {
            respond(out, id, &serde_json::json!({}));
            // 实测:interrupt 干净返回后推 interrupted 完成(findings §7)
            emit(
                out,
                &serde_json::json!({
                    "method": "turn/completed",
                    "params": { "threadId": "thread-happy", "turn": { "id": "turn-1", "status": "interrupted", "items": [] } },
                })
                .to_string(),
            );
        }
        _ => {
            // 未知脚本/方法:静默忽略
        }
    }
}

fn thread_obj(thread_id: &str) -> serde_json::Value {
    serde_json::json!({
        "id": thread_id,
        "sessionId": thread_id,
        "path": format!("C:\\Users\\u\\.codex\\sessions\\rollout-{thread_id}.jsonl"),
        "model": "glm",
        "modelProvider": "openai_compat",
        "cwd": "C:\\work",
        // 实测形状:tagged 对象(与 turn.status 的裸字符串不同)
        "status": { "type": "idle" },
        "turns": [],
    })
}

fn emit_thread_started(out: &mut BufWriter<std::io::StdoutLock<'static>>, thread_id: &str) {
    emit(
        out,
        &serde_json::json!({
            "method": "thread/started",
            "params": { "thread": thread_obj(thread_id) },
        })
        .to_string(),
    );
}

fn usage_breakdown() -> serde_json::Value {
    serde_json::json!({
        "totalTokens": 100, "inputTokens": 80, "cachedInputTokens": 10,
        "outputTokens": 20, "reasoningOutputTokens": 0,
    })
}

fn respond(out: &mut BufWriter<std::io::StdoutLock<'static>>, id: Option<serde_json::Value>, result: &serde_json::Value) {
    let frame = serde_json::json!({ "id": id, "result": result });
    writeln!(out, "{frame}").unwrap();
    out.flush().unwrap();
}

fn emit(out: &mut BufWriter<std::io::StdoutLock<'static>>, raw_line: &str) {
    writeln!(out, "{raw_line}").unwrap();
    out.flush().unwrap();
}

// ================================================================ 测试驱动

async fn spawn_mock(script: &str) -> CodexAppServerSession {
    let exe = std::env::current_exe().expect("current_exe");
    let request = SpawnRequest {
        program: exe.to_string_lossy().to_string(),
        args: Vec::new(),
        cwd: std::env::temp_dir().to_string_lossy().to_string(),
        extra_envs: vec![(MOCK_ENV.to_string(), script.to_string())],
        approval_policy: "untrusted".to_string(),
        sandbox: "read-only".to_string(),
    };
    CodexAppServerSession::spawn(request)
        .await
        .expect("mock spawn + initialize")
}

fn run_happy_path() -> bool {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let session = spawn_mock("happy").await;
        let mut events = session.subscribe();

        let thread = session.start_thread().await.expect("thread/start");
        assert_eq!(thread.id, "thread-happy");
        assert_eq!(thread.session_id, "thread-happy");
        assert_eq!(thread.model.as_deref(), Some("glm"));
        // rollout 路径入 nervous check:不带 \\?\ 前缀(实测 thread/start 无前缀)
        assert!(thread.path.as_deref().unwrap_or("").starts_with("C:"), "path = {:?}", thread.path);

        let turn_id = session.start_turn("say hi").await.expect("turn/start");
        assert_eq!(turn_id, "turn-1");

        let mut deltas = Vec::new();
        let mut status_changed = false;
        let mut token_usage_seen = false;
        let mut completed = false;

        // 等流推进到 delta 全部到达(异步任务,block_on 里轮询)
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while deltas.len() < 3 && std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(500), events.recv()).await {
                Ok(Ok(CodexEvent::AgentMessageDelta { delta, .. })) => deltas.push(delta),
                Ok(Ok(CodexEvent::ThreadStatusChanged { status, .. })) => {
                    assert_eq!(status, proto::ThreadStatus::Active { active_flags: vec![] });
                    status_changed = true;
                }
                Ok(Ok(_)) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    panic!("event lagged by {n}");
                }
                Ok(Err(e)) => panic!("event recv: {e}"),
                Err(_) => {}
            }
        }
        assert_eq!(deltas.join(""), "你好，世界", "deltas = {deltas:?}");

        // turn/steer(真实协议方法)触发 mock 推送 item/completed + tokenUsage
        // + turn/completed
        session.steer("continue").await.expect("steer");
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await {
                Ok(Ok(CodexEvent::ThreadStatusChanged { status, .. })) => {
                    assert_eq!(status, proto::ThreadStatus::Active { active_flags: vec![] });
                    status_changed = true;
                }
                Ok(Ok(CodexEvent::TokenUsageUpdated { usage, .. })) => {
                    assert_eq!(usage.total.total_tokens, 100);
                    token_usage_seen = true;
                }
                Ok(Ok(CodexEvent::TurnCompleted { turn, .. })) => {
                    assert_eq!(turn.id, "turn-1");
                    assert_eq!(turn.status, proto::TurnStatus::Completed);
                    completed = true;
                    break;
                }
                Ok(Ok(_)) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    panic!("event lagged by {n}");
                }
                Ok(Err(e)) => panic!("event recv: {e}"),
                Err(_) => break,
            }
        }
        assert!(completed, "turn/completed not received");
        assert!(status_changed, "thread/status/changed not received");
        assert!(token_usage_seen, "thread/tokenUsage/updated not received");

        let status = session.status();
        assert_eq!(status.phase, SessionPhase::Idle);
        assert_eq!(status.current_turn_id, None);

        session.shutdown().await;
        true
    })
}

fn run_approval_flow() -> bool {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let session = spawn_mock("approval").await;
        let mut events = session.subscribe();

        session.start_thread().await.expect("thread/start");
        session.start_turn("run echo hi").await.expect("turn/start");

        let request_id = loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await {
                Ok(Ok(CodexEvent::ApprovalRequested { request_id, params })) => {
                    assert_eq!(params.thread_id, "thread-approval");
                    assert_eq!(params.item_id, "cmd1");
                    break request_id;
                }
                Ok(Ok(_)) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    panic!("event lagged by {n}");
                }
                Ok(Err(e)) => panic!("event recv: {e}"),
                Err(_) => panic!("approval request not received"),
            }
        };

        assert_eq!(session.status().phase, SessionPhase::AwaitingApproval);

        // 应答 accept(0.163 新枚举,wire 名 "accept";旧值 "approved" 实测无效)
        session
            .respond_approval(request_id, ApprovalAction::Approve)
            .await
            .expect("respond approval");

        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await {
                Ok(Ok(CodexEvent::TurnCompleted { turn, .. })) => {
                    assert_eq!(turn.id, "turn-a");
                    assert_eq!(turn.status, proto::TurnStatus::Completed);
                    break;
                }
                Ok(Ok(_)) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    panic!("event lagged by {n}");
                }
                Ok(Err(e)) => panic!("event recv: {e}"),
                Err(_) => panic!("timed out waiting turn completion after approval"),
            }
        }
        session.shutdown().await;
        true
    })
}

fn run_interrupt_flow() -> bool {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let session = spawn_mock("happy").await;
        let mut events = session.subscribe();

        session.start_thread().await.expect("thread/start");
        session.start_turn("long task").await.expect("turn/start");

        // 等流开始(delta 到达),turn 处于 inProgress(完成事件由 interrupt
        // 触发,findings §7:干净返回 + interrupted completed)
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(500), events.recv()).await {
                Ok(Ok(CodexEvent::AgentMessageDelta { .. })) => break,
                Ok(Ok(_)) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    panic!("event lagged by {n}");
                }
                Ok(Err(e)) => panic!("event recv: {e}"),
                Err(_) => {}
            }
        }

        // 状态机应在 TurnRunning
        assert_eq!(session.status().phase, SessionPhase::TurnRunning);

        session.interrupt().await.expect("interrupt");

        // 等 interrupted 完成
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await {
                Ok(Ok(CodexEvent::TurnCompleted { turn, .. })) => {
                    assert_eq!(turn.id, "turn-1");
                    assert_eq!(turn.status, proto::TurnStatus::Interrupted);
                    break;
                }
                Ok(Ok(_)) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    panic!("event lagged by {n}");
                }
                Ok(Err(e)) => panic!("event recv: {e}"),
                Err(_) => panic!("timed out waiting interrupted completion"),
            }
        }
        // 状态机回落 Idle,current_turn_id 清空
        let status = session.status();
        assert_eq!(status.phase, SessionPhase::Idle);
        assert_eq!(status.current_turn_id, None);

        session.shutdown().await;
        true
    })
}

fn run_crash() -> bool {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let session = spawn_mock("crash").await;
        let mut errors = session.subscribe_errors();

        // thread/start 触发 mock exit(101);请求可能成功也可能失败——
        // 关键断言:错误通道收到 ProcessExited{code: Some(101)}
        let _ = session.start_thread().await;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let remain = deadline.saturating_duration_since(std::time::Instant::now());
            if remain.is_zero() {
                panic!("timed out waiting crash error");
            }
            match tokio::time::timeout(remain, errors.recv()).await {
                Ok(Ok(SessionError::ProcessExited { code })) => {
                    assert_eq!(code, Some(101), "exit code should propagate");
                    break;
                }
                Ok(Ok(SessionError::Protocol(_))) => continue,
                Ok(Ok(other)) => panic!("unexpected error event: {other:?}"),
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    panic!("error channel lagged by {n}");
                }
                Ok(Err(e)) => panic!("error channel: {e}"),
                Err(_) => panic!("timed out waiting crash error"),
            }
        }
        session.shutdown().await;
        true
    })
}
