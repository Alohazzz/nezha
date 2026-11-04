use super::*;

pub(super) fn serve(
    id: Option<serde_json::Value>,
    params: serde_json::Value,
    out: &mut BufWriter<std::io::StdoutLock<'static>>,
) {
    let expected_cwd = std::env::temp_dir().to_string_lossy().to_string();
    if params["cwd"] != expected_cwd
        || params["approvalPolicy"] != "untrusted"
        || params["sandbox"] != "read-only"
    {
        emit(out, &serde_json::json!({
            "id": id,
            "error": { "code": -32602, "message": "resume must override saved full-access settings" },
        }).to_string());
        return;
    }
    respond(
        out,
        id,
        &serde_json::json!({ "thread": thread_obj("thread-resumed") }),
    );
}

pub(super) fn run() -> bool {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let session = spawn_mock("resume_policy").await;
            let result = session.resume_thread("saved-full-access-thread").await;
            session.shutdown().await;
            assert!(
                result.is_ok(),
                "current permission settings were not applied: {result:?}"
            );
            true
        })
}
