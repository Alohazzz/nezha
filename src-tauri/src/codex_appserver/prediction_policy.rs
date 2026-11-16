//! Compatibility is pinned to tested builds and provider/model combinations, not a version floor.
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const STABLE_BUILD: &str = "d4b2e6a054ea1dfe53217f9d8942c5f8a9f4b76171a1e0bb76ced5759915300a";
pub const ALPHA_BUILD: &str = "83f5c2dd2ac2902e0d96ba5d8ccdd27d513f57df4a9ab73e06a5a518028e9a2f";
static ENABLED: AtomicBool = AtomicBool::new(false);
static INITIALIZED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
static HASHES: Lazy<
    Mutex<HashMap<(std::path::PathBuf, u64, std::time::SystemTime), Option<String>>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Acquire)
}
pub fn initialize_enabled(enabled: bool) {
    INITIALIZED.get_or_init(|| {
        ENABLED.store(enabled, Ordering::Release);
    });
}
pub fn set_enabled(enabled: bool) {
    INITIALIZED.get_or_init(|| {});
    ENABLED.store(enabled, Ordering::Release);
}

/// Called on the blocking pool. No credential/config content is inspected here.
pub fn verified_build(program: &str) -> Option<String> {
    let path = std::fs::canonicalize(program).ok()?;
    let metadata = std::fs::metadata(&path).ok()?;
    let key = (path.clone(), metadata.len(), metadata.modified().ok()?);
    if let Some(hash) = HASHES.lock().get(&key).cloned() {
        return hash;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let hash = hex::encode(digest.finalize());
    let hash = (hash == STABLE_BUILD || hash == ALPHA_BUILD).then_some(hash);
    let mut hashes = HASHES.lock();
    if hashes.len() >= 8 {
        hashes.clear();
    }
    hashes.insert(key, hash.clone());
    hash
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PredictionContext {
    pub build: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub effort: Option<String>,
    pub mode: Option<String>,
    pub pending_input_ids: std::collections::HashSet<String>,
    pub unsupported: bool,
    pub supported: bool,
    pub revision: u64,
}

impl PredictionContext {
    pub fn apply_thread_response(&mut self, value: &Value, fresh: bool) {
        self.model = value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.provider = value
            .get("modelProvider")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.effort = value
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.mode = value
            .pointer("/collaborationMode/mode")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| (fresh && self.build.is_some()).then(|| "default".to_string()));
        self.revision += 1;
    }

    pub fn apply_settings(&mut self, value: &Value) {
        if let Some(model) = value.get("model").and_then(Value::as_str) {
            self.model = Some(model.to_owned());
        }
        if let Some(provider) = value.get("modelProvider").and_then(Value::as_str) {
            self.provider = Some(provider.to_owned());
        }
        if let Some(effort) = value.get("effort").and_then(Value::as_str) {
            self.effort = Some(effort.to_owned());
        }
        if let Some(mode) = value
            .pointer("/collaborationMode/mode")
            .and_then(Value::as_str)
        {
            self.mode = Some(mode.to_owned());
        }
        self.revision += 1;
    }

    pub fn eligible(&self) -> bool {
        !self.unsupported
            && self.provider.as_deref() == Some("openai")
            && self.mode.as_deref() == Some("default")
            && self.pending_input_ids.is_empty()
            && matches!(
                (self.build.as_deref(), self.model.as_deref()),
                (Some(STABLE_BUILD), Some("gpt-6-astra"))
                    | (Some(ALPHA_BUILD), Some("gpt-6.1-sol"))
            )
    }
}

pub fn incompatible(error: &super::rpc::RpcError) -> bool {
    let message = error.message.to_ascii_lowercase();
    error.code == -32601
        || (matches!(error.code, -32600 | -32602)
            && (message.contains("unknown field")
                || message.contains("unknown variant")
                || message.contains("unsupported field")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_verified_build_model_and_runtime_mode_are_eligible() {
        let mut context = PredictionContext {
            build: Some(STABLE_BUILD.into()),
            ..Default::default()
        };
        context.apply_thread_response(&serde_json::json!({"model":"gpt-6-astra", "modelProvider":"openai", "reasoningEffort":"medium"}), true);
        assert!(
            context.eligible(),
            "fresh verified threads use the real default collaboration mode"
        );
        context.apply_settings(&serde_json::json!({"collaborationMode":{"mode":"plan"}}));
        assert!(!context.eligible());
        context.apply_settings(&serde_json::json!({"collaborationMode":{"mode":"default"}}));
        context.pending_input_ids.insert("pending".into());
        assert!(!context.eligible());
        context.pending_input_ids.clear();
        context.model = Some("unverified-model".into());
        assert!(!context.eligible());
        context.model = Some("gpt-6-astra".into());
        context.apply_thread_response(
            &serde_json::json!({"model":"gpt-6-astra", "modelProvider":"openai"}),
            false,
        );
        assert!(
            !context.eligible(),
            "unknown restored mode must remain conservative"
        );
    }
}
