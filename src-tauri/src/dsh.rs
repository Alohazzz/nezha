//! DeepSeek Harness (DSH) 会话集成。
//!
//! 复刻 `@deepseek-ai/dsh-session-persistence-jsonl` 的磁盘布局约定：
//! - 会话根目录 `$DSH_HOME/sessions`（缺省 `~/.dsh/sessions`）
//! - 项目目录名 = `projectKey(cwd)`（分隔符折叠 + `~XXXX` 转义 + `--` 包裹）
//! - 会话目录 `<projectKey>/<encodeSegment(id)>/session.jsonl.zstd`
//! - 文件为**多帧拼接**的 zstd（每帧是一次 append），首帧首行是 `session` header，
//!   之后是 `SessionEvent` 事件流；token 级 `assistant/chunk` 被 pack 成
//!   `text-chunks` / `reasoning-chunks` 等 storage row。
//!
//! T2 最小回放：只消费 `user/message` / `assistant/message`（内含 text / reasoning /
//! tool-call 块），忽略 packed chunk row 与 compaction 的 surface replace 语义。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::analytics::SessionMetrics;
use crate::session::{SessionContent, SessionMessage};

/// 解压后的最大字节数，防止压缩炸弹 / 超长会话一次性撑爆内存。
const MAX_DECOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

/// 复刻 `projectKey(cwd)`：`/` `\` `:` → `-`（连续折叠）；`[A-Za-z0-9._-]` 原样
/// （`~` 除外）；其余 UTF-16 码元 → `~XXXX`（大写十六进制，补足 4 位）；
/// 去掉前导 `-`；空则 `root`；截断 251 码元；两头包 `--`。
pub(crate) fn project_key(cwd: &str) -> String {
    let mut readable = String::new();
    let mut separator_run = false;
    for code in cwd.encode_utf16() {
        if code == 0x2F || code == 0x5C || code == 0x3A {
            // '/' '\\' ':'
            if !separator_run {
                readable.push('-');
            }
            separator_run = true;
        } else if code != 0x7E && is_safe_ascii(code) {
            readable.push(code as u8 as char);
            separator_run = false;
        } else {
            readable.push_str(&format!("~{code:04X}"));
            separator_run = false;
        }
    }

    let stripped = readable.trim_start_matches('-');
    let bounded: String = if stripped.is_empty() {
        "root".to_string()
    } else {
        stripped.chars().take(251).collect()
    };
    format!("--{bounded}--")
}

fn is_safe_ascii(code: u16) -> bool {
    (code >= b'A' as u16 && code <= b'Z' as u16)
        || (code >= b'a' as u16 && code <= b'z' as u16)
        || (code >= b'0' as u16 && code <= b'9' as u16)
        || code == b'.' as u16
        || code == b'_' as u16
        || code == b'-' as u16
}

/// dsh 会话根目录：优先 `$DSH_HOME/sessions`，否则 `~/.dsh/sessions`。
pub(crate) fn sessions_root() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("DSH_HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home).join("sessions"));
        }
    }
    Some(crate::platform::home_dir()?.join(".dsh").join("sessions"))
}

/// 多帧 zstd 解压为 UTF-8 文本。
pub(crate) fn decompress(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    // zstd 0.13 的 Decoder 默认即多帧（multiple members）解码，
    // 旧版 0.12 的 `.multiple_members(true)` 调用已移除。
    let decoder = zstd::stream::read::Decoder::new(file).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    decoder
        .take(MAX_DECOMPRESSED_BYTES + 1)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    if out.len() as u64 > MAX_DECOMPRESSED_BYTES {
        return Err("dsh session decompressed beyond 256MB limit".to_string());
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

#[derive(Clone, Debug)]
pub(crate) struct DshSession {
    pub(crate) id: String,
    pub(crate) path: String,
}

/// 会话目录里的实际日志文件（优先 `.jsonl.zstd`，兼容明文 `.jsonl`）。
fn session_log_file(dir: &Path) -> Option<PathBuf> {
    let zstd = dir.join("session.jsonl.zstd");
    if zstd.is_file() {
        return Some(zstd);
    }
    let plain = dir.join("session.jsonl");
    if plain.is_file() {
        return Some(plain);
    }
    None
}

/// 读取 header 首行，返回 `(id, createdAt_ms)`。
fn read_header(log: &Path) -> Option<(String, i64)> {
    let text = if log.extension().and_then(|e| e.to_str()) == Some("zstd") {
        decompress(log).ok()?
    } else {
        fs::read_to_string(log).ok()?
    };
    let first = text.lines().next()?;
    let val: Value = serde_json::from_str(first).ok()?;
    if val.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let id = val.get("id").and_then(Value::as_str)?.to_string();
    let created = val.get("createdAt").and_then(Value::as_i64)?;
    Some((id, created))
}

/// 在 `projectKey(project_path)` 目录下找 `since_ms` 之后（含）最近更新的会话。
///
/// 匹配策略：优先 mtime >= since_ms 的最新会话（覆盖「恢复旧会话会追加写」的场景），
/// 退化为整体 mtime 最新的会话。
pub(crate) fn discover_session(project_path: &str, since_ms: i64) -> Option<DshSession> {
    let root = sessions_root()?;
    let project_dir = root.join(project_key(project_path));
    if !project_dir.is_dir() {
        return None;
    }

    let mut best: Option<(i64, DshSession)> = None;
    let mut fallback: Option<(i64, DshSession)> = None;

    let entries = fs::read_dir(&project_dir).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(log) = session_log_file(&dir) else {
            continue;
        };
        let Some((id, _created)) = read_header(&log) else {
            continue;
        };
        let Some(mtime) = fs::metadata(&log)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
        else {
            continue;
        };
        let candidate = DshSession {
            id,
            path: log.to_string_lossy().into_owned(),
        };

        if mtime >= since_ms {
            if best.as_ref().map(|(b, _)| mtime > *b).unwrap_or(true) {
                best = Some((mtime, candidate.clone()));
            }
        }
        if fallback.as_ref().map(|(b, _)| mtime > *b).unwrap_or(true) {
            fallback = Some((mtime, candidate));
        }
    }

    best.or(fallback).map(|(_, s)| s)
}

/// dsh 会话 → Nezha `SessionMessage` 序列（T2 最小映射）。
pub(crate) fn read_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let text = decompress(path)?;
    let mut messages = Vec::new();

    for line in text.lines() {
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(ty) = val.get("type").and_then(Value::as_str) else {
            continue;
        };
        match ty {
            "user/message" => {
                let content = user_content(val.get("data").and_then(|d| d.get("content")));
                if !content.is_empty() {
                    messages.push(SessionMessage {
                        role: "user".to_string(),
                        content,
                    });
                }
            }
            "assistant/message" => {
                let content =
                    assistant_content(val.get("data").and_then(|d| d.get("message")).and_then(|m| m.get("content")));
                if !content.is_empty() {
                    messages.push(SessionMessage {
                        role: "assistant".to_string(),
                        content,
                    });
                }
            }
            _ => {}
        }
    }

    Ok(messages)
}

fn user_content(content: Option<&Value>) -> Vec<SessionContent> {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter_map(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                if text.trim().is_empty() {
                    None
                } else {
                    Some(SessionContent::Text {
                        text: text.to_string(),
                    })
                }
            }
            Some("image") => Some(SessionContent::Text {
                text: "[image]".to_string(),
            }),
            _ => None,
        })
        .collect()
}

fn assistant_content(content: Option<&Value>) -> Vec<SessionContent> {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter_map(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                if text.trim().is_empty() {
                    None
                } else {
                    Some(SessionContent::Text {
                        text: text.to_string(),
                    })
                }
            }
            Some("reasoning") => {
                let thinking = b.get("text").and_then(Value::as_str).unwrap_or("");
                if thinking.trim().is_empty() {
                    None
                } else {
                    Some(SessionContent::Thinking {
                        thinking: thinking.to_string(),
                    })
                }
            }
            Some("tool-call") => Some(SessionContent::ToolUse {
                id: b.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                name: b.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                input: b
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            }),
            _ => None,
        })
        .collect()
}

/// dsh 会话 → 最小用量指标。
pub(crate) fn metrics(path: &Path) -> SessionMetrics {
    let file_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let Ok(text) = decompress(path) else {
        return SessionMetrics {
            session_file_bytes: file_bytes,
            ..SessionMetrics::default()
        };
    };

    let mut total_tokens: u64 = 0;
    let mut tool_calls: u64 = 0;
    let mut context_tokens: u64 = 0;
    let mut context_window: u64 = 0;
    let mut first_time: Option<f64> = None;
    let mut last_time: Option<f64> = None;

    for line in text.lines() {
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(t) = val.get("time").and_then(Value::as_f64) {
            if first_time.is_none() {
                first_time = Some(t);
            }
            last_time = Some(t);
        }

        match val.get("type").and_then(Value::as_str) {
            Some("assistant/message") => {
                if let Some(usage) = val.get("data").and_then(|d| d.get("usage")) {
                    let inp = usage.get("inputTokens").and_then(Value::as_u64).unwrap_or(0);
                    let out = usage.get("outputTokens").and_then(Value::as_u64).unwrap_or(0);
                    let cache_read = usage.get("cacheReadTokens").and_then(Value::as_u64).unwrap_or(0);
                    let cache_write = usage.get("cacheWriteTokens").and_then(Value::as_u64).unwrap_or(0);
                    let reasoning = usage.get("reasoningTokens").and_then(Value::as_u64).unwrap_or(0);
                    total_tokens += inp + out + cache_read + cache_write + reasoning;
                    context_tokens = inp + cache_read + cache_write;
                }
            }
            Some("tool/call") => {
                tool_calls += 1;
            }
            Some("request/context") => {
                if let Some(w) = val
                    .get("data")
                    .and_then(|d| d.get("contextWindow"))
                    .and_then(Value::as_u64)
                {
                    context_window = w;
                }
            }
            _ => {}
        }
    }

    let duration_secs = match (first_time, last_time) {
        (Some(a), Some(b)) => ((b - a) / 1000.0).max(0.0),
        _ => 0.0,
    };

    SessionMetrics {
        tool_calls,
        duration_secs,
        session_file_bytes: file_bytes,
        total_tokens,
        context_tokens,
        context_window,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_key_matches_dsh_encoding() {
        assert_eq!(
            project_key("H:\\Project\\DSH-tui\\dsh-tianshu-tui-main"),
            "--H-Project-DSH-tui-dsh-tianshu-tui-main--"
        );
        assert_eq!(
            project_key("H:\\Project\\nezha-main"),
            "--H-Project-nezha-main--"
        );
        assert_eq!(project_key("/Users/me/proj"), "--Users-me-proj--");
        assert_eq!(project_key("C:\\a b"), "--C-a~0020b--");
    }
}
