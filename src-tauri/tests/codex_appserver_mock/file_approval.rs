use super::*;

pub(super) fn serve(
    script: &str,
    id: Option<serde_json::Value>,
    reader: &mut std::io::StdinLock<'static>,
    out: &mut BufWriter<std::io::StdoutLock<'static>>,
) {
    respond(
        out,
        id,
        &serde_json::json!({ "turn": { "id": "file-turn" } }),
    );
    emit(
        out,
        &serde_json::json!({ "method": "turn/started", "params": {
        "threadId": "thread-happy", "turn": { "id": "file-turn", "status": "inProgress" },
    } })
        .to_string(),
    );
    emit(
        out,
        &serde_json::json!({ "id": 9, "method": "item/fileChange/requestApproval",
            "params": { "threadId": "thread-happy", "turnId": "file-turn", "itemId": "patch-1",
                "startedAtMs": 1, "reason": "Create fixture.txt" },
        })
        .to_string(),
    );
    let mut reply = String::new();
    assert!(reader.read_line(&mut reply).unwrap_or(0) > 0);
    let reply: serde_json::Value = serde_json::from_str(&reply).expect("file approval response");
    assert_eq!(reply["id"], 9);
    assert_eq!(
        reply["result"]["decision"],
        script.strip_prefix("file_approval_").unwrap()
    );
    emit(
        out,
        &serde_json::json!({ "method": "turn/completed", "params": {
        "threadId": "thread-happy", "turn": { "id": "file-turn", "status": "completed" },
    } })
        .to_string(),
    );
}

pub(super) fn run() -> bool {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for (decision, action) in [
                ("accept", ApprovalAction::Approve),
                ("decline", ApprovalAction::Decline),
                ("cancel", ApprovalAction::Cancel),
            ] {
                let session = spawn_mock(&format!("file_approval_{decision}")).await;
                let mut events = session.subscribe();
                session.start_thread().await.expect("thread/start");
                session
                    .start_turn("create fixture.txt")
                    .await
                    .expect("turn/start");
                loop {
                    let event =
                        tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
                            .await
                            .expect("approval event")
                            .expect("event stream");
                    assert!(
                        !matches!(event, CodexEvent::UnsupportedServerRequest { .. }),
                        "file changes must be presented for approval, not auto-declined"
                    );
                    if session.status().phase == SessionPhase::AwaitingApproval {
                        break;
                    }
                }
                session
                    .respond_approval(proto::RequestId::Integer(9), action)
                    .await
                    .expect("file decision");
                loop {
                    if matches!(
                        tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
                            .await
                            .expect("completion")
                            .expect("event stream"),
                        CodexEvent::TurnCompleted { .. }
                    ) {
                        break;
                    }
                }
                session.shutdown().await;
            }
            true
        })
}
