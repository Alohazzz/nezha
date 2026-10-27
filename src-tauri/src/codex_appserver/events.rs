//! codex app-server 通知面 → 内部事件枚举的 serde 适配层。
//!
//! 解析策略(阶段 0 实测结论,findings §3/§8):
//! - serde 基准 = 上游 `rust-v0.163.0` 类型,不做 Paseo schema 转译;
//! - 上游 `ServerNotification` 枚举是 closed set(未知方法整帧反序列化失败),
//!   所以先按 `rpc::parse_frame` 粗分类,再对已知方法细解析;未知方法
//!   warn 一次并跳过(0.163 新增了 9 个 Paseo 未覆盖方法,容错是硬要求);
//! - 上游 `Thread` 结构体是 Serialize-only(带大量 experimental 字段),
//!   不能从 wire 反序列化,这里自定义 `ThreadInfo` 只取任务系统需要的字段。

use codex_app_server_protocol as proto;
use serde::Deserialize;
use serde_json::Value;

use super::rpc::IncomingFrame;

/// 会话对象快照:只取 Nezha 关心的字段(D6:thread 对象 31 键,其余透传忽略)。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub id: String,
    /// 实测与 `id` 同值(UUIDv7),保持独立字段以兼容 `codexSessionId` 语义。
    #[serde(default)]
    pub session_id: String,
    /// rollout 文件绝对路径。thread/resume 返回值可能带 Windows extended-length
    /// 前缀 `\\?\`,入库前必须经 `strip_verbatim_prefix`(findings §5)。
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_provider: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// 其余字段静默忽略。
    #[serde(flatten)]
    pub _rest: Value,
}

/// 内部事件枚举:MVP 七项核心 + `thread/status/changed`(findings §8.5)。
/// 审批反向请求是独立分支 `ApprovalRequested`(payload 由 approval.rs 承载)。
#[derive(Debug, Clone, PartialEq)]
pub enum CodexEvent {
    /// initialize 应答(版本门控读 userAgent)。
    Initialized { user_agent: String, codex_home: Option<String> },
    ThreadStarted { thread: ThreadInfo },
    ThreadStatusChanged { thread_id: String, status: proto::ThreadStatus },
    TurnStarted { thread_id: String, turn_id: String },
    TurnCompleted { thread_id: String, turn: TurnSummary },
    ItemStarted { thread_id: String, turn_id: String, item: proto::ThreadItem, started_at_ms: Option<i64> },
    ItemCompleted { thread_id: String, turn_id: String, item: proto::ThreadItem, completed_at_ms: Option<i64> },
    AgentMessageDelta { thread_id: String, turn_id: String, item_id: String, delta: String },
    ReasoningSummaryDelta { thread_id: String, turn_id: String, item_id: String, delta: String },
    CommandExecutionOutputDelta { thread_id: String, turn_id: String, item_id: String, delta: String },
    /// 文件编辑 diff 增量(`item/fileChange/outputDelta`):编辑期间流式下发,
    /// 没有它编辑卡只能等 item/completed 一次性出内容(编辑中黑盒)。
    FileChangeOutputDelta { thread_id: String, turn_id: String, item_id: String, delta: String },
    TokenUsageUpdated { thread_id: String, usage: proto::ThreadTokenUsage },
    /// 命令执行审批反向请求(`item/commandExecution/requestApproval`)。
    /// `request_id` 必须原样带回 `respond_approval`;决策合法性校验在 approval.rs。
    ApprovalRequested {
        request_id: proto::RequestId,
        params: proto::CommandExecutionRequestApprovalParams,
    },
    /// 当前不支持的反向请求(MCP elicitation / fileChange / dynamic tool 等),
    /// 上层必须自动应答拒绝防 turn 卡死。
    UnsupportedServerRequest { request_id: proto::RequestId, method: String },
    /// 已知形状但当前不消费的通知(rate limits、MCP 启动状态等)——解析成功后丢弃。
    Ignored { method: &'static str },
    /// 完全未知的方法:保留原始 method 与 params,由上层记 dev log 后跳过。
    Unknown { method: String },
}

/// turn 完成时的摘要:上游 `Turn` 对象含完整 items 数组(itemsView:"summary"),
/// 这里只取状态与耗时;items 明细已由 item/* 事件流过。
///
/// `error` 保留原始 JSON 而非解析成 `proto::TurnError`:这是唯一可读的失败原因
/// (不带出来前端只能显示写死的 "turn failed"),但它必须**宽容解析**——TurnError
/// 内部字段随上游版本增删,严格反序列化失败会让整帧 `turn/completed` 被丢弃,
/// 任务就永远等不到终态(比没有原因严重得多)。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummary {
    pub id: String,
    pub status: proto::TurnStatus,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    #[serde(default)]
    pub error: Option<Value>,
    #[serde(flatten)]
    pub _rest: Value,
}

impl TurnSummary {
    /// 失败原因文本:取 `error.message`(上游 TurnError 的主字段),缺失或非字符串
    /// 时依次退回 `additionalDetails` / `codexErrorInfo` 的字符串化形态。
    /// 任何一步取不到都返回 None,由调用方决定兜底文案。
    pub fn error_message(&self) -> Option<String> {
        let error = self.error.as_ref()?.as_object()?;
        let pick = |key: &str| {
            error
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        pick("message")
            .or_else(|| pick("additionalDetails"))
            .or_else(|| {
                error
                    .get("codexErrorInfo")
                    .filter(|v| v.is_string())
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
    }
}

/// 从 wire 帧解析内部事件。返回 `Err(解析失败的方法名)` 供上层记 dev log。
pub fn parse_event(frame: IncomingFrame) -> Result<CodexEvent, String> {
    match frame {
        IncomingFrame::Response { .. } => {
            // 应答帧由 rpc 层 pending 表消费,不应进入事件流
            Err("response-frame".to_string())
        }
        IncomingFrame::ServerRequest { id, method, params } => {
            // 反向请求统一转成交给 approval.rs 的形式,这里透传原始形状
            parse_server_request(id, &method, params)
        }
        IncomingFrame::Notification { method, params } => parse_notification(&method, params),
    }
}

fn parse_server_request(
    request_id: proto::RequestId,
    method: &str,
    params: Option<Value>,
) -> Result<CodexEvent, String> {
    match method {
        "item/commandExecution/requestApproval" => {
            let params = params.unwrap_or(Value::Null);
            let approval: proto::CommandExecutionRequestApprovalParams =
                serde_json::from_value(params)
                    .map_err(|e| format!("item/commandExecution/requestApproval: {e}"))?;
            Ok(CodexEvent::ApprovalRequested { request_id, params: approval })
        }
        // 其余反向请求当前不支持:保留 id 供上层自动拒绝,防 turn 卡死
        other => Ok(CodexEvent::UnsupportedServerRequest {
            request_id,
            method: other.to_string(),
        }),
    }
}

fn parse_notification(method: &str, params: Option<Value>) -> Result<CodexEvent, String> {
    let params = params.unwrap_or(Value::Null);
    let event = match method {
        "thread/started" => {
            // 上游 ThreadStartedNotification 因 Thread Serialize-only 不可反序列化,
            // 用自定义 ThreadInfo。实测样本:{"thread":{...}}
            #[derive(Deserialize)]
            struct Wire {
                thread: ThreadInfo,
            }
            let wire: Wire = serde_json::from_value(params)
                .map_err(|e| format!("thread/started: {e}"))?;
            CodexEvent::ThreadStarted { thread: wire.thread }
        }
        "thread/status/changed" => {
            let wire: proto::ThreadStatusChangedNotification = serde_json::from_value(params)
                .map_err(|e| format!("thread/status/changed: {e}"))?;
            CodexEvent::ThreadStatusChanged { thread_id: wire.thread_id, status: wire.status }
        }
        "turn/started" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Wire {
                thread_id: String,
                turn: TurnSummary,
            }
            let wire: Wire =
                serde_json::from_value(params).map_err(|e| format!("turn/started: {e}"))?;
            CodexEvent::TurnStarted { thread_id: wire.thread_id, turn_id: wire.turn.id }
        }
        "turn/completed" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Wire {
                thread_id: String,
                turn: TurnSummary,
            }
            let wire: Wire =
                serde_json::from_value(params).map_err(|e| format!("turn/completed: {e}"))?;
            CodexEvent::TurnCompleted { thread_id: wire.thread_id, turn: wire.turn }
        }
        "item/started" => {
            // 信封时间戳（#119）：item/started 携带 startedAtMs，透传给前端做
            // 思考/命令动态计时；缺失（旧版本/回放）时为 None，前端本地兜底。
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Wire {
                thread_id: String,
                turn_id: String,
                item: proto::ThreadItem,
                #[serde(default)]
                started_at_ms: Option<i64>,
            }
            let wire: Wire =
                serde_json::from_value(params).map_err(|e| format!("item/started: {e}"))?;
            CodexEvent::ItemStarted {
                thread_id: wire.thread_id,
                turn_id: wire.turn_id,
                item: wire.item,
                started_at_ms: wire.started_at_ms,
            }
        }
        "item/completed" => {
            // 同上：item/completed 携带 completedAtMs（完成定格时长用）。
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Wire {
                thread_id: String,
                turn_id: String,
                item: proto::ThreadItem,
                #[serde(default)]
                completed_at_ms: Option<i64>,
            }
            let wire: Wire =
                serde_json::from_value(params).map_err(|e| format!("item/completed: {e}"))?;
            CodexEvent::ItemCompleted {
                thread_id: wire.thread_id,
                turn_id: wire.turn_id,
                item: wire.item,
                completed_at_ms: wire.completed_at_ms,
            }
        }
        "item/agentMessage/delta" => {
            let wire: proto::AgentMessageDeltaNotification = serde_json::from_value(params)
                .map_err(|e| format!("item/agentMessage/delta: {e}"))?;
            CodexEvent::AgentMessageDelta {
                thread_id: wire.thread_id,
                turn_id: wire.turn_id,
                item_id: wire.item_id,
                delta: wire.delta,
            }
        }
        "item/reasoning/summaryTextDelta" => {
            let wire: proto::ReasoningSummaryTextDeltaNotification =
                serde_json::from_value(params)
                    .map_err(|e| format!("item/reasoning/summaryTextDelta: {e}"))?;
            CodexEvent::ReasoningSummaryDelta {
                thread_id: wire.thread_id,
                turn_id: wire.turn_id,
                item_id: wire.item_id,
                delta: wire.delta,
            }
        }
        "item/commandExecution/outputDelta" => {
            let wire: proto::CommandExecutionOutputDeltaNotification =
                serde_json::from_value(params)
                    .map_err(|e| format!("item/commandExecution/outputDelta: {e}"))?;
            CodexEvent::CommandExecutionOutputDelta {
                thread_id: wire.thread_id,
                turn_id: wire.turn_id,
                item_id: wire.item_id,
                delta: wire.delta,
            }
        }
        "thread/tokenUsage/updated" => {
            let wire: proto::ThreadTokenUsageUpdatedNotification = serde_json::from_value(params)
                .map_err(|e| format!("thread/tokenUsage/updated: {e}"))?;
            CodexEvent::TokenUsageUpdated { thread_id: wire.thread_id, usage: wire.token_usage }
        }
        // 已知形状、当前不消费:显式列出便于审计,不要落到 Unknown
        "account/rateLimits/updated" => CodexEvent::Ignored { method: "account/rateLimits/updated" },
        "mcpServer/startupStatus/updated" => {
            CodexEvent::Ignored { method: "mcpServer/startupStatus/updated" }
        }
        "item/reasoning/summaryPartAdded" => {
            CodexEvent::Ignored { method: "item/reasoning/summaryPartAdded" }
        }
        "serverRequest/resolved" => CodexEvent::Ignored { method: "serverRequest/resolved" },
        "configWarning" | "warning" => CodexEvent::Ignored { method: "configWarning" },
        "remoteControl/status/changed" => {
            CodexEvent::Ignored { method: "remoteControl/status/changed" }
        }
        // Paseo 名单里有、0.163 实测未触发但阶段 2+ 可能出现:先容错,不炸解析
        "turn/diff/updated" => CodexEvent::Ignored { method: "turn/diff/updated" },
        "turn/plan/updated" => CodexEvent::Ignored { method: "turn/plan/updated" },
        "thread/compacted" => CodexEvent::Ignored { method: "thread/compacted" },
        "item/fileChange/outputDelta" => {
            // 编辑 diff 增量:形状与命令输出增量同构,流式透传给前端归并进
            // 对应 fileChange 条目(编辑中实时渲染 diff,不再黑盒等 completed)。
            let wire: proto::FileChangeOutputDeltaNotification = serde_json::from_value(params)
                .map_err(|e| format!("item/fileChange/outputDelta: {e}"))?;
            CodexEvent::FileChangeOutputDelta {
                thread_id: wire.thread_id,
                turn_id: wire.turn_id,
                item_id: wire.item_id,
                delta: wire.delta,
            }
        }
        "item/commandExecution/terminalInteraction" => {
            CodexEvent::Ignored { method: "item/commandExecution/terminalInteraction" }
        }
        other => CodexEvent::Unknown { method: other.to_string() },
    };
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_appserver::rpc::parse_frame;

    fn parse_from_line(line: &str) -> Result<CodexEvent, String> {
        parse_event(parse_frame(line).expect("frame should parse"))
    }

    #[test]
    fn thread_started_with_probe_sample_shape() {
        // 形状取自 .agents/probe/notification-samples.json(thread 对象 31 键,只留必要)
        let line = r#"{"method":"thread/started","params":{"thread":{"id":"01a166bf-7295","sessionId":"01a166bf-7295","path":"C:\\Users\\SuYi\\.codex\\sessions\\rollout-x.jsonl","model":"glm","modelProvider":"openai_compat","cwd":"H:\\proj","environments":[],"extra":null,"forkedFromId":null,"preview":"","ephemeral":false,"historyMode":"paginated","reasoningEffort":null,"createdAt":1,"updatedAt":2,"recencyAt":3,"status":{"type":"idle"},"cliVersion":"0.163.0","originator":null,"source":{"type":"cli"},"gitInfo":null,"name":null,"turns":[]}}}"#;
        let event = parse_from_line(line).unwrap();
        match event {
            CodexEvent::ThreadStarted { thread } => {
                assert_eq!(thread.id, "01a166bf-7295");
                assert_eq!(thread.session_id, "01a166bf-7295");
                assert_eq!(thread.model.as_deref(), Some("glm"));
            }
            other => panic!("expected ThreadStarted, got {other:?}"),
        }
    }

    #[test]
    fn thread_status_changed_active() {
        let line = r#"{"method":"thread/status/changed","params":{"threadId":"t1","status":{"type":"active","activeFlags":[]}},"emittedAtMs":1}"#;
        match parse_from_line(line).unwrap() {
            CodexEvent::ThreadStatusChanged { thread_id, status } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(status, proto::ThreadStatus::Active { active_flags: vec![] });
            }
            other => panic!("expected ThreadStatusChanged, got {other:?}"),
        }
    }

    #[test]
    fn turn_lifecycle_events() {
        // 实测样本(notification-samples.json):turn.status 是裸字符串枚举
        let started = parse_from_line(
            r#"{"method":"turn/started","params":{"threadId":"t1","turn":{"id":"turn1","status":"inProgress","items":[],"itemsView":"notLoaded"}}}"#,
        )
        .unwrap();
        assert_eq!(started, CodexEvent::TurnStarted { thread_id: "t1".into(), turn_id: "turn1".into() });

        let completed = parse_from_line(
            r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"completed","items":[],"itemsView":"summary","durationMs":1234.0,"usage":null}}}"#,
        )
        .unwrap();
        match completed {
            CodexEvent::TurnCompleted { thread_id, turn } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(turn.id, "turn1");
                assert_eq!(turn.status, proto::TurnStatus::Completed);
            }
            other => panic!("expected TurnCompleted, got {other:?}"),
        }
    }

    #[test]
    fn item_events_carry_envelope_timestamps() {
        // 形状取自 .agents/probe/probe_basic-wire.jsonl（#119）：信封带 startedAtMs
        let started = parse_from_line(
            r#"{"method":"item/started","params":{"threadId":"t1","turnId":"turn1","startedAtMs":1792725191199,"item":{"type":"reasoning","id":"rs_1","summary":[],"content":[]}}}"#,
        )
        .unwrap();
        match started {
            CodexEvent::ItemStarted { item, started_at_ms, .. } => {
                assert_eq!(started_at_ms, Some(1_792_725_191_199));
                let proto::ThreadItem::Reasoning { id, .. } = item else {
                    panic!("expected reasoning item, got {item:?}")
                };
                assert_eq!(id, "rs_1");
            }
            other => panic!("expected ItemStarted, got {other:?}"),
        }

        let completed = parse_from_line(
            r#"{"method":"item/completed","params":{"threadId":"t1","turnId":"turn1","completedAtMs":1792725193959,"item":{"type":"reasoning","id":"rs_1","summary":["done"],"content":[]}}}"#,
        )
        .unwrap();
        match completed {
            CodexEvent::ItemCompleted { completed_at_ms, .. } => {
                assert_eq!(completed_at_ms, Some(1_792_725_193_959));
            }
            other => panic!("expected ItemCompleted, got {other:?}"),
        }
    }

    #[test]
    fn item_events_tolerate_missing_timestamps() {
        // 旧版本 / 回放帧可能没有信封时间戳：解析不能失败，字段落 None
        let started = parse_from_line(
            r#"{"method":"item/started","params":{"threadId":"t1","turnId":"turn1","item":{"type":"reasoning","id":"rs_1","summary":[],"content":[]}}}"#,
        )
        .unwrap();
        match started {
            CodexEvent::ItemStarted { started_at_ms, .. } => assert_eq!(started_at_ms, None),
            other => panic!("expected ItemStarted, got {other:?}"),
        }

        let completed = parse_from_line(
            r#"{"method":"item/completed","params":{"threadId":"t1","turnId":"turn1","item":{"type":"reasoning","id":"rs_1","summary":[],"content":[]}}}"#,
        )
        .unwrap();
        match completed {
            CodexEvent::ItemCompleted { completed_at_ms, .. } => assert_eq!(completed_at_ms, None),
            other => panic!("expected ItemCompleted, got {other:?}"),
        }
    }

    #[test]
    fn unknown_method_is_tolerated() {
        let line = r#"{"method":"some/future/method","params":{}}"#;
        match parse_from_line(line).unwrap() {
            CodexEvent::Unknown { method } => assert_eq!(method, "some/future/method"),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn file_change_output_delta_parses_as_streaming_event() {
        // 编辑 diff 增量:不再 Ignored,流式透传给前端(编辑中实时渲染 diff)
        let line = r#"{"method":"item/fileChange/outputDelta","params":{"threadId":"t1","turnId":"turn1","itemId":"fc_1","delta":"--- a/src/a.ts\n+++ b/src/a.ts\n"}}"#;
        match parse_from_line(line).unwrap() {
            CodexEvent::FileChangeOutputDelta { thread_id, turn_id, item_id, delta } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(turn_id, "turn1");
                assert_eq!(item_id, "fc_1");
                assert_eq!(delta, "--- a/src/a.ts\n+++ b/src/a.ts\n");
            }
            other => panic!("expected FileChangeOutputDelta, got {other:?}"),
        }
    }

    #[test]
    fn ignored_methods_do_not_blow_up() {
        for line in [
            r#"{"method":"account/rateLimits/updated","params":{}}"#,
            r#"{"method":"serverRequest/resolved","params":{"threadId":"t","requestId":0}}"#,
            r#"{"method":"configWarning","params":{"message":"deprecated key"}}"#,
        ] {
            let event = parse_from_line(line).unwrap();
            assert!(matches!(event, CodexEvent::Ignored { .. }), "got {event:?}");
        }
    }

    #[test]
    fn approval_request_from_probe_sample_shape() {
        // 形状取自 .agents/probe/notification-samples.json 的实测审批反向请求:
        // id 从 0 起(与服务端 id 空间一致),availableDecisions 是服务端建议子集
        let line = concat!(
            r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"#,
            r#""kind":"command","threadId":"01a166c0-7938","turnId":"01a166c0-7add","itemId":"call_ac58","#,
            r#""startedAtMs":1792725262664,"environmentId":"local","#,
            r#""command":"\"pwsh.exe\" -NoProfile -Command 'echo probe-approval-test-12345'","#,
            r#""cwd":"H:\\proj","commandActions":[{"type":"unknown","command":"echo probe-approval-test-12345"}],"#,
            r#""availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[]}},"cancel"]}}"#
        );
        match parse_from_line(line).unwrap() {
            CodexEvent::ApprovalRequested { request_id, params } => {
                assert_eq!(request_id, proto::RequestId::Integer(0));
                assert_eq!(params.thread_id, "01a166c0-7938");
                assert_eq!(params.item_id, "call_ac58");
                let decisions = params.available_decisions.expect("decisions present");
                assert_eq!(decisions[0], proto::CommandExecutionApprovalDecision::Accept);
                assert_eq!(decisions[2], proto::CommandExecutionApprovalDecision::Cancel);
            }
            other => panic!("expected ApprovalRequested, got {other:?}"),
        }
    }

    #[test]
    fn unsupported_server_requests_are_preserved_with_id() {
        let line = r#"{"method":"mcpServer/elicitation/request","id":3,"params":{}}"#;
        match parse_from_line(line).unwrap() {
            CodexEvent::UnsupportedServerRequest { request_id, method } => {
                assert_eq!(request_id, proto::RequestId::Integer(3));
                assert_eq!(method, "mcpServer/elicitation/request");
            }
            other => panic!("expected UnsupportedServerRequest, got {other:?}"),
        }
    }

    #[test]
    fn failed_turn_carries_upstream_error_message() {
        // 失败 turn 的 error.message 是用户唯一能看到的失败原因——必须带出来,
        // 不能只剩写死的 "turn failed"(上游 TurnError 形状见 v2/thread_data.rs)
        let line = r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"failed","items":[],"itemsView":"summary","durationMs":42.0,"error":{"message":"quota exhausted","codexErrorInfo":"usageLimitExceeded"}}}}"#;
        match parse_from_line(line).unwrap() {
            CodexEvent::TurnCompleted { turn, .. } => {
                assert_eq!(turn.status, proto::TurnStatus::Failed);
                assert_eq!(turn.error_message().as_deref(), Some("quota exhausted"));
            }
            other => panic!("expected TurnCompleted, got {other:?}"),
        }
    }

    #[test]
    fn failed_turn_without_error_object_still_parses() {
        // 宽容红线:TurnError 字段随上游版本增删,error 必须按原始 JSON 收下——
        // 严格反序列化失败会让整帧 turn/completed 被丢弃,任务永远等不到终态。
        for line in [
            // 完全没有 error
            r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"failed","items":[],"itemsView":"summary"}}}"#,
            // error 是未知形状(字段类型全变)
            r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"failed","items":[],"itemsView":"summary","error":{"unknownFutureField":{"nested":1}}}}}"#,
            // error 甚至是 null
            r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"failed","items":[],"itemsView":"summary","error":null}}}"#,
        ] {
            match parse_from_line(line).unwrap() {
                CodexEvent::TurnCompleted { turn, .. } => {
                    assert_eq!(turn.status, proto::TurnStatus::Failed);
                    assert_eq!(turn.error_message(), None);
                }
                other => panic!("expected TurnCompleted, got {other:?}"),
            }
        }
    }

    #[test]
    fn failed_turn_falls_back_to_alternate_error_fields() {
        // message 缺失时退回 additionalDetails,再退回 codexErrorInfo 字符串
        let line = r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"failed","items":[],"itemsView":"summary","error":{"message":"   ","additionalDetails":"see provider log","codexErrorInfo":"badRequest"}}}}"#;
        match parse_from_line(line).unwrap() {
            CodexEvent::TurnCompleted { turn, .. } => {
                assert_eq!(turn.error_message().as_deref(), Some("see provider log"));
            }
            other => panic!("expected TurnCompleted, got {other:?}"),
        }

        let info_only = r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"failed","items":[],"itemsView":"summary","error":{"codexErrorInfo":"badRequest"}}}}"#;
        match parse_from_line(info_only).unwrap() {
            CodexEvent::TurnCompleted { turn, .. } => {
                assert_eq!(turn.error_message().as_deref(), Some("badRequest"));
            }
            other => panic!("expected TurnCompleted, got {other:?}"),
        }
    }
}
