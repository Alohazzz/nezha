//! Opt-in development acceptance timings. Never includes request/response contents.
#[cfg(debug_assertions)]
pub(super) fn rpc(method: &str, thread: Option<&str>, elapsed: std::time::Duration, ok: bool) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ENABLED.get_or_init(|| std::env::var("NEZHA_PREDICTION_DIAGNOSTICS").as_deref() == Ok("1")) {
        return;
    }
    if !matches!(method, "turn/start" | "thread/read" | "thread/sample/cancel" | "thread/sample") {
        return;
    }
    let unix_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_secs_f64() * 1000.0;
    eprintln!("[prediction-timing] {}", serde_json::json!({
        "method": method, "thread": thread, "elapsedMs": elapsed.as_secs_f64() * 1000.0,
        "completedUnixMs": unix_ms, "ok": ok,
    }));
}
