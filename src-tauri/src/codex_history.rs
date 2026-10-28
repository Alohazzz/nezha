//! Codex rollout 会话文件 → 结构化流回放帧（历史任务重开后恢复会话视图）。
//!
//! structured 任务的流式条目此前只活在 `useCodexStream` 的内存模型里：应用重启 /
//! 从任务列表打开一个已完成的历史任务时模型是空的，`CodexStreamView` 只能显示
//! 「没有智能体活动记录」。而 rollout jsonl 已经把每个条目（用户消息 / 思考 /
//! 命令 / 文件变更 / 子智能体活动…）逐条落盘；本模块把文件还原成与实时 Channel
//! **同构**的帧（`task_bridge::emit_stream_event` 的 `{type,phase,payload}` 形状），
//! 前端直接复用 `codexStreamMerge` 归并，渲染链路零分叉。
//!
//! 兼容两种落盘形态（按 codex 版本分叉，同一文件只会命中一种）：
//! - 新版（0.153+）：`event_msg.item_completed`，item 是 PascalCase + snake_case
//!   的上游条目；本模块转成 v2 wire 的 camelCase 形状。
//! - 旧版（≤0.146）：`event_msg.user_message` / `agent_message` + `response_item.
//!   reasoning` / `function_call` / `function_call_output`（按 `call_id` 配对）。
//!
//! 时间戳：每行 rollout 自带 ISO 时间。rollout 只落「完成」时刻，没有 started
//! 事件，因此起点用「该 turn 的 `task_started` / 上一条目的完成时刻」估算，经
//! `startedTsMs` 字段下发——前端归并层优先用它做折叠时长，缺失时才回落本地时钟。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::session::validate_session_path;

/// 回放条目上限（与前端 `MAX_ENTRIES` 一致）：超出后丢最老的，避免超长会话
/// 把 IPC 载荷和内存撑爆。
const MAX_HISTORY_ITEMS: usize = 5000;

/// 会话文件大小上限（与导出同量级）。rollout 是逐行增量写的，正常任务远低于此。
const MAX_HISTORY_BYTES: u64 = 200 * 1024 * 1024;

/// 回放结果：`frames` 与实时 Channel 的帧 JSON 完全同构，前端按条喂
/// `ingestFrameLine` 即可（这里直接返回解析后的对象，省一次 stringify/parse）。
#[derive(serde::Serialize)]
pub(crate) struct CodexStreamHistory {
    frames: Vec<Value>,
}

/// 读取历史会话并转换为流式帧。
///
/// `session_path` 走与 `read_session_messages` 相同的根目录校验（Codex 允许根：
/// 项目内 `.codex/sessions` / `~/.codex/sessions` / orca runtime home），
/// 任意 `*.jsonl` 不能被读取。文件读取在 `spawn_blocking` 中逐行进行。
#[tauri::command]
pub async fn read_codex_stream_history(
    session_path: String,
    project_path: String,
    task_id: Option<String>,
) -> Result<CodexStreamHistory, String> {
    tokio::task::spawn_blocking(move || {
        let canonical = validate_session_path(&session_path, &project_path, true)?;
        read_history(&canonical, task_id.as_deref().unwrap_or(""))
    })
    .await
    .map_err(|e| format!("read_codex_stream_history join error: {}", e))?
}

fn read_history(path: &Path, task_id: &str) -> Result<CodexStreamHistory, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_HISTORY_BYTES {
        return Err(format!(
            "Session file is too large to replay ({} MB > {} MB limit)",
            meta.len() / 1024 / 1024,
            MAX_HISTORY_BYTES / 1024 / 1024
        ));
    }

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut scan = RolloutScan::default();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("Cannot read session file: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            // 增量写入的尾巴可能是不完整 JSON：跳过，不要整份失败。
            continue;
        };
        scan.observe(&value);
    }
    Ok(scan.finish(task_id))
}

/// 扫描出的一条待回放条目（v2 形状 + 起止时刻 + 所属 turn）。
struct HistItem {
    item: Value,
    started_ts_ms: i64,
    end_ts_ms: i64,
    turn_id: String,
}

#[derive(Default)]
struct RolloutScan {
    items: Vec<HistItem>,
    /// turn id → 该 turn 的 `task_started` 毫秒时刻（估算首条目的起点）。
    turn_starts: HashMap<String, i64>,
    /// 最近一次 `token_count` 的用量快照（回放末尾作为 usage 条下发）。
    usage: Option<Value>,
    thread_id: String,
    /// 是否见过新版 `item_completed`；见到后旧版事件一律忽略（新版文件里
    /// `response_item` 仍有原始 function_call 记录，混用会重复）。
    saw_item_completed: bool,
    /// 旧版记录（仅在新版事件不存在时才有内容）。
    legacy: Vec<LegacyRecord>,
    legacy_last_ts: Option<i64>,
}

/// 旧版（≤0.146）事件。function_call 与 output 分离落盘，按 call_id 配对。
enum LegacyRecord {
    User { item: Value, ts_ms: i64 },
    Assistant { item: Value, ts_ms: i64 },
    Reasoning { item: Value, ts_ms: i64 },
    Call {
        call_id: String,
        item: Value,
        ts_ms: i64,
    },
    Output {
        call_id: String,
        output: String,
        ts_ms: i64,
    },
}

impl RolloutScan {
    fn observe(&mut self, value: &Value) {
        let line_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = value.get("payload").unwrap_or(&Value::Null);
        let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let ts_ms = value.get("timestamp").and_then(parse_iso_ms);

        match line_type {
            "session_meta" => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    self.thread_id = id.to_string();
                }
            }
            "event_msg" => match payload_type {
                "item_completed" => {
                    let Some(raw) = payload.get("item") else {
                        return;
                    };
                    let Some(item) = modern_item(raw) else {
                        return;
                    };
                    self.saw_item_completed = true;
                    self.items.push(HistItem {
                        item,
                        started_ts_ms: 0,
                        end_ts_ms: ts_ms.unwrap_or(0),
                        turn_id: payload
                            .get("turn_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    });
                    self.legacy_last_ts = ts_ms.or(self.legacy_last_ts);
                }
                "task_started" => {
                    if let (Some(turn), Some(ts)) = (
                        payload.get("turn_id").and_then(Value::as_str),
                        ts_ms,
                    ) {
                        self.turn_starts.insert(turn.to_string(), ts);
                    }
                }
                "token_count" => {
                    if let Some(info) = payload.get("info") {
                        if let Some(usage) = token_usage_from_info(info) {
                            self.usage = Some(usage);
                        }
                    }
                }
                // ── 旧版事件（新版文件里不会出现；出现也只在新版缺失时使用）──
                "user_message" => {
                    if self.saw_item_completed {
                        return;
                    }
                    let text = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let ts = ts_ms.or(self.legacy_last_ts).unwrap_or(0);
                    if let Some(item) = legacy_user_item(payload, text) {
                        self.legacy.push(LegacyRecord::User { item, ts_ms: ts });
                    }
                    self.legacy_last_ts = Some(ts);
                }
                "agent_message" => {
                    if self.saw_item_completed {
                        return;
                    }
                    let text = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let ts = ts_ms.or(self.legacy_last_ts).unwrap_or(0);
                    if !text.trim().is_empty() {
                        self.legacy.push(LegacyRecord::Assistant {
                            item: json!({
                                "type": "agentMessage",
                                "id": format!("legacy-agent-{ts}"),
                                "text": text,
                                "phase": payload.get("phase").cloned().unwrap_or(Value::Null),
                            }),
                            ts_ms: ts,
                        });
                    }
                    self.legacy_last_ts = Some(ts);
                }
                _ => {}
            },
            "response_item" => {
                if self.saw_item_completed {
                    return;
                }
                let ts = ts_ms.or(self.legacy_last_ts).unwrap_or(0);
                match payload_type {
                    "reasoning" => {
                        if let Some(summary) = reasoning_summary(payload) {
                            self.legacy.push(LegacyRecord::Reasoning {
                                item: json!({
                                    "type": "reasoning",
                                    "id": payload
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .unwrap_or(""),
                                    "summary": summary,
                                    "content": [],
                                }),
                                ts_ms: ts,
                            });
                        }
                    }
                    // 旧版助手正文由 `event_msg.agent_message` 承载；response_item
                    // 里的 message 是原始上下文（含 developer 注入），不能直接渲染。
                    "function_call" => {
                        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
                        let args = payload.get("arguments").and_then(Value::as_str);
                        let call_id = payload
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if let Some(item) = legacy_call_item(name, args, &call_id) {
                            self.legacy
                                .push(LegacyRecord::Call { call_id, item, ts_ms: ts });
                        }
                    }
                    "function_call_output" => {
                        let call_id = payload
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let output = payload
                            .get("output")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if !call_id.is_empty() && !output.is_empty() {
                            self.legacy.push(LegacyRecord::Output {
                                call_id,
                                output,
                                ts_ms: ts,
                            });
                        }
                    }
                    _ => {}
                }
                self.legacy_last_ts = Some(ts);
            }
            _ => {}
        }
    }

    fn finish(mut self, task_id: &str) -> CodexStreamHistory {
        let mut items = if self.saw_item_completed {
            fill_modern_starts(&mut self.items, &self.turn_starts);
            self.items
        } else {
            convert_legacy(std::mem::take(&mut self.legacy))
        };

        // 超长会话：只保留最近的条目（与前端内存护栏同语义）。
        if items.len() > MAX_HISTORY_ITEMS {
            items.drain(0..items.len() - MAX_HISTORY_ITEMS);
        }

        let mut frames: Vec<Value> = Vec::with_capacity(items.len() + 1);
        for item in &items {
            frames.push(item_frame(
                task_id,
                &self.thread_id,
                &item.turn_id,
                item.end_ts_ms,
                item.started_ts_ms,
                item.item.clone(),
            ));
        }

        if let Some(usage) = self.usage.take() {
            frames.push(usage_frame(task_id, &self.thread_id, usage));
        }

        CodexStreamHistory { frames }
    }
}

/// 新版条目只落完成时刻：起点按「turn 起始 / 上一条目完成」推算，且不得晚于终点。
fn fill_modern_starts(items: &mut [HistItem], turn_starts: &HashMap<String, i64>) {
    let mut turn_cursor: HashMap<String, i64> = HashMap::new();
    for item in items.iter_mut() {
        let cursor = turn_cursor
            .get(&item.turn_id)
            .copied()
            .or_else(|| turn_starts.get(&item.turn_id).copied());
        let start = cursor.map(|ts| ts.min(item.end_ts_ms)).unwrap_or(item.end_ts_ms);
        item.started_ts_ms = start;
        turn_cursor.insert(item.turn_id.clone(), item.end_ts_ms);
    }
}

fn item_frame(
    task_id: &str,
    thread_id: &str,
    turn_id: &str,
    end_ts_ms: i64,
    started_ts_ms: i64,
    payload: Value,
) -> Value {
    let mut frame = Map::new();
    frame.insert("taskId".into(), json!(task_id));
    frame.insert("type".into(), json!("item"));
    frame.insert("phase".into(), json!("completed"));
    frame.insert("threadId".into(), json!(thread_id));
    frame.insert("turnId".into(), json!(turn_id));
    frame.insert("tsMs".into(), json!(end_ts_ms));
    // 起点缺失（时间戳全 0 的畸形文件）时不下发，前端回落本地时钟语义。
    if started_ts_ms > 0 && started_ts_ms <= end_ts_ms {
        frame.insert("startedTsMs".into(), json!(started_ts_ms));
    }
    frame.insert("payload".into(), payload);
    Value::Object(frame)
}

fn usage_frame(task_id: &str, thread_id: &str, usage: Value) -> Value {
    let mut frame = Map::new();
    frame.insert("taskId".into(), json!(task_id));
    frame.insert("type".into(), json!("tokenUsage"));
    frame.insert("phase".into(), json!("updated"));
    frame.insert("threadId".into(), json!(thread_id));
    frame.insert("turnId".into(), json!(""));
    frame.insert("payload".into(), usage);
    Value::Object(frame)
}

// ── 新版 item_completed → v2 ThreadItem ──────────────────────────────────────

/// PascalCase + snake_case 的上游条目 → v2 wire 形状（camelCase）。
/// 未知条目类型返回 None（历史回放不把原始 JSON 摊到用户面前）。
fn modern_item(raw: &Value) -> Option<Value> {
    let item_type = raw.get("type").and_then(Value::as_str)?;
    let id = raw.get("id").and_then(Value::as_str).unwrap_or("");

    match item_type {
        "UserMessage" => {
            let mut content = Vec::new();
            for block in raw
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.trim().is_empty() {
                            content.push(json!({ "type": "text", "text": text }));
                        }
                    }
                    "local_image" | "image" => {
                        if let Some(path) = block.get("path").and_then(Value::as_str) {
                            content
                                .push(json!({ "type": "localImage", "path": file_url_to_path(path) }));
                        }
                    }
                    // `skill` 等元数据块不渲染：文本里已有 `$name` 占位。
                    _ => {}
                }
            }
            if content.is_empty() {
                return None;
            }
            Some(json!({ "type": "userMessage", "id": id, "content": content }))
        }
        "AgentMessage" => {
            let text = agent_message_text(raw);
            if text.trim().is_empty() {
                return None;
            }
            Some(json!({
                "type": "agentMessage",
                "id": id,
                "text": text,
                "phase": raw.get("phase").cloned().unwrap_or(Value::Null),
            }))
        }
        "Reasoning" => {
            let summary = reasoning_summary(raw)?;
            Some(json!({
                "type": "reasoning",
                "id": id,
                "summary": summary,
                "content": [],
            }))
        }
        "CommandExecution" => Some(json!({
            "type": "commandExecution",
            "id": id,
            "command": command_text(raw.get("command")),
            "cwd": raw
                .get("cwd")
                .and_then(Value::as_str)
                .map(file_url_to_path)
                .unwrap_or_default(),
            "status": command_status(raw.get("status").and_then(Value::as_str)),
            "aggregatedOutput": command_output(raw),
            "exitCode": raw.get("exit_code").and_then(Value::as_i64),
            "durationMs": duration_ms(raw.get("duration")),
        })),
        "FileChange" => {
            let changes = file_changes(raw.get("changes"));
            if changes.is_empty() {
                return None;
            }
            Some(json!({
                "type": "fileChange",
                "id": id,
                "changes": changes,
                "status": command_status(raw.get("status").and_then(Value::as_str)),
            }))
        }
        "McpToolCall" => Some(json!({
            "type": "mcpToolCall",
            "id": id,
            "server": raw.get("server").and_then(Value::as_str).unwrap_or(""),
            "tool": raw.get("tool").and_then(Value::as_str).unwrap_or(""),
            "status": command_status(raw.get("status").and_then(Value::as_str)),
            "durationMs": duration_ms(raw.get("duration")),
            "arguments": raw.get("arguments").cloned().unwrap_or(Value::Null),
            "result": raw.get("result").cloned().unwrap_or(Value::Null),
            "error": raw.get("error").cloned().unwrap_or(Value::Null),
        })),
        "Plan" => {
            let text = raw.get("text").and_then(Value::as_str).unwrap_or("");
            if text.trim().is_empty() {
                return None;
            }
            Some(json!({ "type": "plan", "id": id, "text": text }))
        }
        "ImageView" => {
            let path = raw.get("path").and_then(Value::as_str).unwrap_or("");
            if path.trim().is_empty() {
                return None;
            }
            Some(json!({ "type": "imageView", "id": id, "path": file_url_to_path(path) }))
        }
        "SubAgentActivity" => Some(json!({
            "type": "subAgentActivity",
            "id": id,
            "kind": raw.get("kind").and_then(Value::as_str).unwrap_or(""),
            "agentThreadId": raw
                .get("agent_thread_id")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "agentPath": raw.get("agent_path").and_then(Value::as_str).unwrap_or(""),
            "model": raw.get("model").cloned().unwrap_or(Value::Null),
            "reasoningEffort": raw.get("reasoning_effort").cloned().unwrap_or(Value::Null),
        })),
        "CollabAgentToolCall" => Some(json!({
            "type": "collabAgentToolCall",
            "id": id,
            "tool": raw.get("tool").and_then(Value::as_str).unwrap_or(""),
            "status": command_status(raw.get("status").and_then(Value::as_str)),
            "senderThreadId": raw
                .get("sender_thread_id")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "receiverThreadIds": raw.get("receiver_thread_ids").cloned().unwrap_or(json!([])),
            "prompt": raw.get("prompt").cloned().unwrap_or(Value::Null),
            "agentsStates": raw.get("agents_states").cloned().unwrap_or(json!({})),
        })),
        _ => None,
    }
}

/// 上游 AgentMessage 正文：旧形态在 `content[].text`，新形态可能直接给 `text`。
fn agent_message_text(raw: &Value) -> String {
    if let Some(text) = raw.get("text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    let mut out = String::new();
    for block in raw
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
        if !block_type.eq_ignore_ascii_case("text") && !block_type.eq_ignore_ascii_case("output_text")
        {
            continue;
        }
        let Some(text) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(text);
    }
    out
}

/// 思考摘要：新版 `summary_text: [..]`；v2 wire `summary: [{type:"summary_text",text}]`。
/// 摘要为空时退回 `raw_content` / `content` 的 reasoning_text（旧会话常见），
/// 否则历史任务里的思考卡会全部消失。
fn reasoning_summary(raw: &Value) -> Option<Vec<String>> {
    for key in ["summary_text", "summary", "raw_content", "content"] {
        let Some(values) = raw.get(key).and_then(Value::as_array) else {
            continue;
        };
        let mut parts: Vec<String> = Vec::new();
        for entry in values {
            let text = entry
                .as_str()
                .or_else(|| entry.get("text").and_then(Value::as_str));
            if let Some(text) = text {
                if !text.trim().is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
        if !parts.is_empty() {
            return Some(parts);
        }
    }
    None
}

/// 命令文本：新版落盘是 argv 数组（首元素是 shell 可执行文件），拼成一行后
/// 前端 `summarizeCommand` 仍能剥离 `pwsh.exe -Command '...'` 外壳。
fn command_text(command: Option<&Value>) -> String {
    match command {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .map(|part| {
                if part.contains(' ') && !part.starts_with('"') {
                    format!("\"{}\"", part)
                } else {
                    part.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// 单条目正文上限（命令输出）。历史回放是整份 IPC 一次性返回，不设上限时
/// 一条 `npm install` 输出就能把载荷推到几十 MB；渲染层本来就只展示尾部
/// 64KB，这里保留 256KB 足以覆盖「复制全文」的常见用途。
const MAX_ITEM_TEXT_BYTES: usize = 256 * 1024;

fn cap_text(text: String) -> String {
    if text.len() <= MAX_ITEM_TEXT_BYTES {
        return text;
    }
    // 按字符边界回退，避免从 UTF-8 多字节序列中间切开。
    let mut cut = text.len() - MAX_ITEM_TEXT_BYTES;
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    let mut out = String::with_capacity(MAX_ITEM_TEXT_BYTES + 64);
    out.push_str("[... output truncated for history replay ...]\n");
    out.push_str(&text[cut..]);
    out
}

fn command_output(raw: &Value) -> Value {
    if let Some(output) = raw.get("aggregated_output").and_then(Value::as_str) {
        return json!(cap_text(output.to_string()));
    }
    let mut parts: Vec<String> = Vec::new();
    for key in ["stdout", "stderr"] {
        if let Some(text) = raw.get(key).and_then(Value::as_str) {
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    if parts.is_empty() {
        Value::Null
    } else {
        json!(cap_text(parts.join("\n")))
    }
}

/// 上游状态词 → 前端条目状态。历史条目一律已结束：未知值按 completed。
fn command_status(status: Option<&str>) -> &'static str {
    match status {
        Some("failed") => "failed",
        Some("declined") => "declined",
        Some("inProgress") | Some("in_progress") => "inProgress",
        _ => "completed",
    }
}

/// `{secs,nanos}` 时长 → 毫秒（回放条目的时长来源）。
fn duration_ms(duration: Option<&Value>) -> Value {
    let Some(duration) = duration else {
        return Value::Null;
    };
    if let Some(ms) = duration.get("durationMs").and_then(Value::as_f64) {
        return json!(ms.round() as i64);
    }
    let secs = duration.get("secs").and_then(Value::as_i64).unwrap_or(0);
    let nanos = duration.get("nanos").and_then(Value::as_i64).unwrap_or(0);
    if secs == 0 && nanos == 0 {
        return Value::Null;
    }
    json!(secs * 1000 + nanos / 1_000_000)
}

/// rollout 的 changes 是 `{path: {type, ...}}` 映射；v2 wire 是数组。
/// add / delete 只落完整内容没有 diff，这里合成标准 unified diff 供渲染层解析。
fn file_changes(changes: Option<&Value>) -> Vec<Value> {
    let Some(changes) = changes.and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (path, change) in changes {
        let change_type = change.get("type").and_then(Value::as_str).unwrap_or("");
        let (kind, diff) = match change_type {
            "add" => (
                json!({ "type": "add" }),
                json!(synth_add_diff(
                    path,
                    change.get("content").and_then(Value::as_str).unwrap_or("")
                )),
            ),
            "delete" => (
                json!({ "type": "delete" }),
                json!(synth_delete_diff(
                    path,
                    change.get("content").and_then(Value::as_str).unwrap_or("")
                )),
            ),
            "update" => (
                json!({
                    "type": "update",
                    "movePath": change.get("move_path").cloned().unwrap_or(Value::Null),
                }),
                json!(cap_text(
                    change
                        .get("unified_diff")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                )),
            ),
            _ => continue,
        };
        out.push(json!({ "path": path, "kind": kind, "diff": diff }));
    }
    out
}

fn synth_add_diff(path: &str, content: &str) -> String {
    let lines = content_lines(content);
    let mut out = format!(
        "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n",
        path,
        lines.len()
    );
    for line in &lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn synth_delete_diff(path: &str, content: &str) -> String {
    let lines = content_lines(content);
    let mut out = format!(
        "--- a/{}\n+++ /dev/null\n@@ -1,{} +0,0 @@\n",
        path,
        lines.len()
    );
    for line in &lines {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// 按行切分并丢掉末尾换行产生的空元素（与 diff 行语义一致）。
fn content_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

// ── token usage ──────────────────────────────────────────────────────────────

fn token_usage_from_info(info: &Value) -> Option<Value> {
    let total = info.get("total_token_usage")?;
    let last = info.get("last_token_usage")?;
    Some(json!({
        "total": token_breakdown(total),
        "last": token_breakdown(last),
        "modelContextWindow": info.get("model_context_window").and_then(Value::as_i64),
    }))
}

fn token_breakdown(value: &Value) -> Value {
    let pick = |key: &str| value.get(key).and_then(Value::as_i64).unwrap_or(0);
    json!({
        "totalTokens": pick("total_tokens"),
        "inputTokens": pick("input_tokens"),
        "cachedInputTokens": pick("cached_input_tokens"),
        "cacheWriteInputTokens": pick("cache_write_input_tokens"),
        "outputTokens": pick("output_tokens"),
        "reasoningOutputTokens": pick("reasoning_output_tokens"),
    })
}

// ── 旧版（≤0.146）事件转换 ────────────────────────────────────────────────────

fn legacy_user_item(payload: &Value, text: &str) -> Option<Value> {
    let mut content = Vec::new();
    if !text.trim().is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    // `images` 是远程 URL、`local_images` 是本地路径；只有后者能直接预览。
    for key in ["local_images", "images"] {
        for path in payload
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !path.trim().is_empty() {
                content.push(json!({ "type": "localImage", "path": file_url_to_path(path) }));
            }
        }
    }
    if content.is_empty() {
        return None;
    }
    Some(json!({
        "type": "userMessage",
        "id": payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("legacy-user-{}", text.len())),
        "content": content,
    }))
}

/// 旧版 function_call → 可渲染条目。只保留命令 / 看图 / 计划三类；
/// 其余旧版工具缺少可靠的结果语义，不硬猜。
fn legacy_call_item(name: &str, arguments: Option<&str>, call_id: &str) -> Option<Value> {
    let args: Value = arguments
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null);
    match name {
        "shell_command" | "exec_command" => {
            let command = args
                .get("command")
                .or_else(|| args.get("cmd"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if command.trim().is_empty() {
                return None;
            }
            Some(json!({
                "type": "commandExecution",
                "id": call_id,
                "command": command,
                "cwd": args.get("workdir").and_then(Value::as_str).unwrap_or(""),
                "status": "completed",
                "aggregatedOutput": Value::Null,
                "exitCode": Value::Null,
                "durationMs": Value::Null,
            }))
        }
        "view_image" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            if path.trim().is_empty() {
                return None;
            }
            Some(json!({ "type": "imageView", "id": call_id, "path": file_url_to_path(path) }))
        }
        "update_plan" => {
            let steps: Vec<String> = args
                .get("plan")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|step| step.get("step").and_then(Value::as_str).map(str::to_string))
                .collect();
            if steps.is_empty() {
                return None;
            }
            let text = steps
                .iter()
                .enumerate()
                .map(|(i, step)| format!("{}. {}", i + 1, step))
                .collect::<Vec<_>>()
                .join("\n");
            Some(json!({ "type": "plan", "id": call_id, "text": text }))
        }
        _ => None,
    }
}

/// 旧版记录 → 条目序列。function_call 先暂存，等 `function_call_output` 按
/// call_id 补上输出与退出码后再落条目。
fn convert_legacy(records: Vec<LegacyRecord>) -> Vec<HistItem> {
    let mut outputs: HashMap<String, (String, i64)> = HashMap::new();
    for record in &records {
        if let LegacyRecord::Output {
            call_id,
            output,
            ts_ms,
        } = record
        {
            outputs.insert(call_id.clone(), (output.clone(), *ts_ms));
        }
    }

    let mut out = Vec::new();
    for record in records {
        match record {
            LegacyRecord::Output { .. } => {}
            LegacyRecord::User { item, ts_ms } => out.push(HistItem {
                item,
                started_ts_ms: ts_ms,
                end_ts_ms: ts_ms,
                turn_id: String::new(),
            }),
            LegacyRecord::Assistant { item, ts_ms } | LegacyRecord::Reasoning { item, ts_ms } => {
                out.push(HistItem {
                    item,
                    started_ts_ms: ts_ms,
                    end_ts_ms: ts_ms,
                    turn_id: String::new(),
                })
            }
            LegacyRecord::Call {
                call_id,
                mut item,
                ts_ms,
            } => {
                let mut end_ts = ts_ms;
                if let Some((text, output_ts)) = outputs.get(&call_id) {
                    end_ts = *output_ts;
                    if item.get("type").and_then(Value::as_str) == Some("commandExecution") {
                        let (exit_code, body) = split_legacy_command_output(text);
                        item["aggregatedOutput"] = json!(body);
                        item["exitCode"] = match exit_code {
                            Some(code) => json!(code),
                            None => Value::Null,
                        };
                        if let Some(wall_ms) = parse_legacy_wall_time(text) {
                            item["durationMs"] = json!(wall_ms);
                        }
                        if exit_code.map(|code| code != 0).unwrap_or(false) {
                            item["status"] = json!("failed");
                        }
                    }
                }
                out.push(HistItem {
                    item,
                    started_ts_ms: ts_ms,
                    end_ts_ms: end_ts.max(ts_ms),
                    turn_id: String::new(),
                });
            }
        }
    }
    out
}

/// 旧版命令输出信封 → (exit code, 正文)。信封缺失时整段都算正文。
fn split_legacy_command_output(raw: &str) -> (Option<i64>, String) {
    let Some(rest) = raw.strip_prefix("Exit code: ") else {
        return (None, raw.to_string());
    };
    let mut parts = rest.splitn(2, '\n');
    let exit_code = parts.next().and_then(|line| line.trim().parse::<i64>().ok());
    let after_first = parts.next().unwrap_or("");
    let body = match after_first.find("Output:\n") {
        Some(idx) => after_first[idx + "Output:\n".len()..].to_string(),
        None => after_first.to_string(),
    };
    (exit_code, body)
}

/// 旧版信封里的 `Wall time: N seconds` → 毫秒。
fn parse_legacy_wall_time(raw: &str) -> Option<i64> {
    let line = raw.lines().find(|line| line.starts_with("Wall time:"))?;
    let seconds: f64 = line
        .trim_start_matches("Wall time:")
        .trim()
        .trim_end_matches("seconds")
        .trim()
        .parse()
        .ok()?;
    Some((seconds * 1000.0).round() as i64)
}

// ── 通用 ─────────────────────────────────────────────────────────────────────

fn parse_iso_ms(value: &Value) -> Option<i64> {
    let raw = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// `file:///H:/x` → `H:/x`。`read_image_preview` 只接受原生路径（Windows 盘符），
/// 且 `file://` URL 里的百分号转义也要还原。
fn file_url_to_path(raw: &str) -> String {
    let stripped = raw.strip_prefix("file://").unwrap_or(raw);
    let without_leading =
        if stripped.starts_with('/') && stripped.as_bytes().get(2) == Some(&b':') {
            &stripped[1..]
        } else {
            stripped
        };
    percent_decode(without_leading)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    out.push(value);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(lines: &[&str]) -> Vec<Value> {
        let mut scan = RolloutScan::default();
        for line in lines {
            let value: Value = serde_json::from_str(line).expect("valid jsonl line");
            scan.observe(&value);
        }
        scan.finish("task-1").frames
    }

    fn payload(frame: &Value) -> &Value {
        frame.get("payload").expect("payload")
    }

    #[test]
    fn modern_items_are_converted_to_v2_wire_shape() {
        let frames = collect(&[
            r#"{"timestamp":"2026-10-28T04:18:39.211Z","type":"session_meta","payload":{"id":"thread-1"}}"#,
            r#"{"timestamp":"2026-10-28T04:18:39.500Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}"#,
            r#"{"timestamp":"2026-10-28T04:18:40.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-1","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"hi"},{"type":"local_image","path":"file:///H:/p/a.png"}]}}}"#,
            r#"{"timestamp":"2026-10-28T04:18:42.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-1","item":{"type":"Reasoning","id":"r1","summary_text":["thinking"],"raw_content":[]}}}"#,
            r#"{"timestamp":"2026-10-28T04:18:46.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-1","item":{"type":"CommandExecution","id":"c1","command":["pwsh.exe","-Command","echo hi"],"cwd":"file:///H:/p","status":"completed","aggregated_output":"hi\n","exit_code":0,"duration":{"secs":1,"nanos":500000000}}}}"#,
            r#"{"timestamp":"2026-10-28T04:18:48.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-1","item":{"type":"AgentMessage","id":"a1","content":[{"type":"Text","text":"done"}]}}}"#,
        ]);

        assert_eq!(frames.len(), 4);
        assert_eq!(frames[0]["threadId"], "thread-1");

        let user = payload(&frames[0]);
        assert_eq!(user["type"], "userMessage");
        assert_eq!(user["content"][1]["type"], "localImage");
        assert_eq!(user["content"][1]["path"], "H:/p/a.png");

        let reasoning = payload(&frames[1]);
        assert_eq!(reasoning["type"], "reasoning");
        assert_eq!(reasoning["summary"][0], "thinking");
        // 起点取上一条目的完成时刻（首条取 turn 的 task_started），终点是事件
        // 时刻 → 折叠头能算出真实时长，而不是全 0。
        assert_eq!(frames[1]["startedTsMs"], 1_793_161_120_000_i64);
        assert_eq!(frames[1]["tsMs"], 1_793_161_122_000_i64);

        let command = payload(&frames[2]);
        assert_eq!(command["type"], "commandExecution");
        assert_eq!(command["command"], "pwsh.exe -Command \"echo hi\"");
        assert_eq!(command["aggregatedOutput"], "hi\n");
        assert_eq!(command["exitCode"], 0);
        assert_eq!(command["durationMs"], 1500);
        assert_eq!(command["cwd"], "H:/p");

        let answer = payload(&frames[3]);
        assert_eq!(answer["type"], "agentMessage");
        assert_eq!(answer["text"], "done");
    }

    #[test]
    fn file_change_changes_map_becomes_array_with_synth_diff() {
        let frames = collect(&[r#"{"timestamp":"2026-10-28T04:18:46.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t","item":{"type":"FileChange","id":"f1","status":"completed","changes":{"H:\\\\p\\\\new.txt":{"type":"add","content":"a\nb\n"},"H:\\\\p\\\\old.txt":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b\n","move_path":null}}}}}"#]);
        let changes = payload(&frames[0])["changes"]
            .as_array()
            .expect("changes array");
        assert_eq!(changes.len(), 2);

        let added = changes
            .iter()
            .find(|c| c["path"].as_str().unwrap().ends_with("new.txt"))
            .expect("added change");
        assert_eq!(added["kind"]["type"], "add");
        let diff = added["diff"].as_str().unwrap();
        assert!(diff.starts_with("--- /dev/null\n+++ b/"));
        assert!(diff.contains("@@ -0,0 +1,2 @@\n+a\n+b\n"));

        let updated = changes
            .iter()
            .find(|c| c["path"].as_str().unwrap().ends_with("old.txt"))
            .expect("updated change");
        assert_eq!(updated["kind"]["type"], "update");
        assert_eq!(updated["diff"], "@@ -1 +1 @@\n-a\n+b\n");
    }

    #[test]
    fn token_usage_is_emitted_as_trailing_frame() {
        let frames = collect(&[
            r#"{"timestamp":"2026-10-28T04:18:40.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t","item":{"type":"AgentMessage","id":"a1","content":[{"type":"Text","text":"done"}]}}}"#,
            r#"{"timestamp":"2026-10-28T04:18:41.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":2,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":1,"total_tokens":13},"last_token_usage":{"input_tokens":5,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0,"total_tokens":7},"model_context_window":1000}}}"#,
        ]);
        let usage = frames.last().expect("usage frame");
        assert_eq!(usage["type"], "tokenUsage");
        assert_eq!(usage["payload"]["total"]["totalTokens"], 13);
        assert_eq!(usage["payload"]["last"]["totalTokens"], 7);
        assert_eq!(usage["payload"]["modelContextWindow"], 1000);
    }

    #[test]
    fn legacy_events_are_converted_when_no_item_completed_exists() {
        let frames = collect(&[
            r#"{"timestamp":"2026-07-31T08:39:06.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[]}}"#,
            r#"{"timestamp":"2026-07-31T08:39:08.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"Get-ChildItem\"}","call_id":"call_1"}}"#,
            r#"{"timestamp":"2026-07-31T08:39:09.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"Exit code: 0\nWall time: 1 seconds\nOutput:\nfile.txt\n"}}"#,
            r#"{"timestamp":"2026-07-31T08:39:10.000Z","type":"event_msg","payload":{"type":"agent_message","message":"done","phase":"final_answer"}}"#,
        ]);
        // function_call 与 output 合成一条命令条目，不单独出帧。
        assert_eq!(frames.len(), 3);
        assert_eq!(payload(&frames[0])["type"], "userMessage");
        let command = payload(&frames[1]);
        assert_eq!(command["type"], "commandExecution");
        assert_eq!(command["command"], "Get-ChildItem");
        assert_eq!(command["aggregatedOutput"], "file.txt\n");
        assert_eq!(command["exitCode"], 0);
        assert_eq!(command["durationMs"], 1000);
        assert_eq!(payload(&frames[2])["type"], "agentMessage");
    }

    #[test]
    fn file_url_and_percent_escapes_are_decoded() {
        assert_eq!(file_url_to_path("file:///H:/p/a%20b.png"), "H:/p/a b.png");
        assert_eq!(file_url_to_path("C:\\p\\a.png"), "C:\\p\\a.png");
    }
}
