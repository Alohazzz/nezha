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

pub(super) fn serve_fork(
    id: Option<serde_json::Value>,
    params: serde_json::Value,
    out: &mut BufWriter<std::io::StdoutLock<'static>>,
) {
    assert_eq!(params["threadId"], "saved-parent-thread");
    assert_eq!(params["approvalPolicy"], "untrusted");
    assert_eq!(params["sandbox"], "read-only");
    respond(out, id, &serde_json::json!({ "thread": thread_obj("thread-forked") }));
}

pub(super) fn run_fork() -> bool {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let session = spawn_mock("fork_policy").await;
        let thread = session.fork_thread("saved-parent-thread").await.expect("thread/fork");
        assert_eq!(thread.id, "thread-forked");
        assert_eq!(session.status().thread.expect("forked thread").id, thread.id);
        assert_eq!(session.status().phase, SessionPhase::Idle);
        session.shutdown().await;
        true
    })
}
