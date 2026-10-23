//! codex app-server JSON-RPC 传输层:帧解析、请求 id 分配、pending 应答表。
//!
//! app-server 不是严格的 JSON-RPC 2.0——没有 `"jsonrpc": "2.0"` 字段(上游
//! `codex_app_server_protocol::rpc` 同样如此),请求 id 用 `RequestId`(整数或字符串)。
//! 客户端请求 id 从 100 起计:服务端反向请求(审批)的 id 从 0 起计,两个
//! id 空间独立但为免混淆仍错开(阶段 0 实测 D2)。

use std::collections::HashMap;

use codex_app_server_protocol::RequestId;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;

/// 客户端请求 id 起始值,错开服务端反向请求 id 空间(从 0 递增)。
const CLIENT_REQUEST_ID_BASE: i64 = 100;

/// 从 wire 读到的一帧:按有无 `id` 粗分类后交给上层细解析。
#[derive(Debug, Clone, PartialEq)]
pub enum IncomingFrame {
    /// 有 `id` 且带 `error` 键——对端对我们请求的错误应答。
    Response { id: RequestId, result: Option<Value>, error: Option<RpcError> },
    /// 有 `id` 但 method 也存在——服务端发起的反向请求(审批等)。
    ServerRequest { id: RequestId, method: String, params: Option<Value> },
    /// 无 `id`——通知。
    Notification { method: String, params: Option<Value> },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "rpc error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// 宽松解析一行 wire JSON。字段缺失/形状不对返回 None(调用方记 dev log 跳过)。
pub fn parse_frame(line: &str) -> Option<IncomingFrame> {
    let v: Value = serde_json::from_str(line).ok()?;
    let obj = v.as_object()?;
    let id = match obj.get("id") {
        Some(raw) => deserialize_request_id(raw)?,
        None => {
            let method = obj.get("method")?.as_str()?.to_string();
            let params = obj.get("params").cloned().filter(|p| !p.is_null());
            return Some(IncomingFrame::Notification { method, params });
        }
    };
    let method = obj.get("method").and_then(Value::as_str).map(str::to_string);
    match (method, obj.get("result"), obj.get("error")) {
        // 服务端反向请求:有 method、无 result/error
        (Some(method), None, None) => {
            let params = obj.get("params").cloned().filter(|p| !p.is_null());
            Some(IncomingFrame::ServerRequest { id, method, params })
        }
        // 对我们请求的应答
        (None, result, error) => {
            let error = match error {
                Some(raw) => Some(serde_json::from_value::<RpcError>(raw.clone()).ok()?),
                None => None,
            };
            let result = result.cloned().filter(|r| !r.is_null());
            Some(IncomingFrame::Response { id, result, error })
        }
        // method 与 result/error 并存等畸形帧,不支持
        _ => None,
    }
}

/// 上游 RequestId 是 untagged 枚举(String | i64),手工匹配避免整帧反序列化失败。
fn deserialize_request_id(raw: &Value) -> Option<RequestId> {
    match raw {
        Value::Number(n) => n.as_i64().map(RequestId::Integer),
        Value::String(s) => Some(RequestId::String(s.clone())),
        _ => None,
    }
}

/// JSON-RPC 请求帧构造(通知/请求共用 method+params 形状)。
pub fn encode_request(id: &RequestId, method: &str, params: &Value) -> String {
    let frame = serde_json::json!({
        "id": id,
        "method": method,
        "params": params,
    });
    let mut line = frame.to_string();
    line.push('\n');
    line
}

/// 对反向请求的应答帧(result 侧放决策对象)。
pub fn encode_response(id: &RequestId, result: &Value) -> String {
    let frame = serde_json::json!({
        "id": id,
        "result": result,
    });
    let mut line = frame.to_string();
    line.push('\n');
    line
}

/// 客户端请求 id 分配器:线程安全,从 100 递增。
#[derive(Default)]
pub struct RequestIdAllocator {
    next: Mutex<i64>,
}

impl RequestIdAllocator {
    pub fn new() -> Self {
        Self { next: Mutex::new(CLIENT_REQUEST_ID_BASE) }
    }

    pub fn allocate(&self) -> RequestId {
        let mut next = self.next.lock();
        let id = *next;
        *next += 1;
        RequestId::Integer(id)
    }
}

/// pending 应答表:发送请求前登记 oneshot 发送端,读循环收到应答后取出投递。
///
/// 用 `parking_lot::Mutex` + 短临界区(只做 insert/remove,无 I/O),符合 AGENTS.md 锁规范。
/// 发送端是 `oneshot::Sender`,读循环侧 `send` 失败(请求方已超时放弃)是良性的。
struct PendingEntry {
    tx: oneshot::Sender<Result<Value, RpcError>>,
    method: &'static str,
}

#[derive(Default)]
pub struct PendingTable {
    entries: Mutex<HashMap<RequestId, PendingEntry>>,
}

impl PendingTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一个在途请求。返回false 表示同 id 已存在(不应发生)。
    pub fn insert(
        &self,
        id: RequestId,
        method: &'static str,
        tx: oneshot::Sender<Result<Value, RpcError>>,
    ) -> bool {
        self.entries
            .lock()
            .insert(id, PendingEntry { tx, method })
            .is_none()
    }

    /// 读循环侧:应答到达时取出并投递。返回 method 名便于错误日志定位。
    pub fn resolve(
        &self,
        id: &RequestId,
        result: Result<Value, RpcError>,
    ) -> Option<&'static str> {
        let entry = self.entries.lock().remove(id)?;
        let _ = entry.tx.send(result);
        Some(entry.method)
    }

    /// 请求方超时/会话关闭时清理,返回是否还挂着。
    pub fn remove(&self, id: &RequestId) -> bool {
        self.entries.lock().remove(id).is_some()
    }

    pub fn len(&self) -> usize {
        self.entries.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_response_frame_with_result() {
        let frame = parse_frame(r#"{"id":100,"result":{"userAgent":"codex"}}"#).unwrap();
        match frame {
            IncomingFrame::Response { id, result, error } => {
                assert_eq!(id, RequestId::Integer(100));
                assert_eq!(result.unwrap()["userAgent"], "codex");
                assert!(error.is_none());
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn parse_response_frame_with_error() {
        let frame = parse_frame(
            r#"{"id":101,"error":{"code":-32601,"message":"method not found"}}"#,
        )
        .unwrap();
        match frame {
            IncomingFrame::Response { id, result, error } => {
                assert_eq!(id, RequestId::Integer(101));
                assert!(result.is_none());
                assert_eq!(error.unwrap().code, -32601);
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn parse_notification_frame() {
        let frame = parse_frame(
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"t","delta":"hi"}}"#,
        )
        .unwrap();
        match frame {
            IncomingFrame::Notification { method, params } => {
                assert_eq!(method, "item/agentMessage/delta");
                assert_eq!(params.unwrap()["delta"], "hi");
            }
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn parse_server_request_frame() {
        // 阶段 0 实测审批反向请求:id 从 0 起,带 method 无 result
        let frame = parse_frame(
            r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"t"}}"#,
        )
        .unwrap();
        match frame {
            IncomingFrame::ServerRequest { id, method, params } => {
                assert_eq!(id, RequestId::Integer(0));
                assert_eq!(method, "item/commandExecution/requestApproval");
                assert_eq!(params.unwrap()["kind"], "command");
            }
            other => panic!("expected server request, got {other:?}"),
        }
    }

    #[test]
    fn parse_string_request_id() {
        let frame = parse_frame(r#"{"id":"abc","result":{}}"#).unwrap();
        match frame {
            IncomingFrame::Response { id, .. } => {
                assert_eq!(id, RequestId::String("abc".into()));
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn malformed_frames_return_none() {
        assert!(parse_frame("not json").is_none());
        assert!(parse_frame(r#"{"id":1.5,"result":{}}"#).is_none());
        // id 与 method+error 并存的畸形帧
        assert!(parse_frame(r#"{"id":1,"method":"x","error":{"code":1,"message":"m"}}"#).is_none());
    }

    #[test]
    fn encode_request_produces_newline_terminated_camel_frame() {
        let id = RequestId::Integer(100);
        let line = encode_request(&id, "thread/start", &serde_json::json!({"cwd":"."}));
        assert!(line.ends_with('\n'));
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["id"], 100);
        assert_eq!(v["method"], "thread/start");
        assert_eq!(v["params"]["cwd"], ".");
    }

    #[test]
    fn pending_table_roundtrip() {
        let table = PendingTable::new();
        let (tx, mut rx) = oneshot::channel();
        assert!(table.insert(RequestId::Integer(100), "thread/start", tx));
        assert_eq!(table.len(), 1);
        let method = table
            .resolve(&RequestId::Integer(100), Ok(serde_json::json!({"ok": true})))
            .unwrap();
        assert_eq!(method, "thread/start");
        assert!(table.is_empty());
        let answer = rx.try_recv().unwrap().unwrap();
        assert_eq!(answer["ok"], true);
    }

    #[test]
    fn allocator_starts_at_100() {
        let alloc = RequestIdAllocator::new();
        assert_eq!(alloc.allocate(), RequestId::Integer(100));
        assert_eq!(alloc.allocate(), RequestId::Integer(101));
    }
}
