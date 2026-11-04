use super::*;

pub(super) fn serve(
    method: &str,
    id: Option<serde_json::Value>,
    out: &mut BufWriter<std::io::StdoutLock<'static>>,
) {
    respond(
        out,
        id,
        &serde_json::json!({ "turn": { "id": "resolved-turn" } }),
    );
    if method == "turn/start" {
        emit(
            out,
            &serde_json::json!({ "method": "turn/started", "params": {
            "threadId": "thread-happy", "turn": { "id": "resolved-turn", "status": "inProgress" },
        } })
            .to_string(),
        );
        for (id, method, extra) in [
            (
                7,
                "item/commandExecution/requestApproval",
                serde_json::json!({ "kind": "command" }),
            ),
            (
                8,
                "item/tool/requestUserInput",
                serde_json::json!({ "questions": [], "isBlocking": true }),
            ),
            (9, "item/fileChange/requestApproval", serde_json::json!({})),
        ] {
            let mut params = serde_json::json!({ "threadId": "thread-happy", "turnId": "resolved-turn", "itemId": format!("item-{id}"), "startedAtMs": 1 });
            params
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            emit(
                out,
                &serde_json::json!({ "id": id, "method": method, "params": params }).to_string(),
            );
        }
        resolve(out, "old-thread", 7);
    } else {
        for id in [7, 8, 9] {
            resolve(out, "thread-happy", id);
        }
    }
    emit(
        out,
        &serde_json::json!({ "method": "thread/status/changed", "params": {
        "threadId": "thread-happy", "status": { "type": "active", "activeFlags": [] },
    } })
        .to_string(),
    );
}

fn resolve(out: &mut BufWriter<std::io::StdoutLock<'static>>, thread: &str, id: i64) {
    emit(out, &serde_json::json!({ "method": "serverRequest/resolved", "params": { "threadId": thread, "requestId": id } }).to_string());
}

async fn checkpoint(events: &mut tokio::sync::broadcast::Receiver<CodexEvent>) {
    loop {
        if matches!(
            tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
                .await
                .expect("checkpoint")
                .expect("event stream"),
            CodexEvent::ThreadStatusChanged { .. }
        ) {
            break;
        }
    }
}

pub(super) fn run() -> bool {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let session = spawn_mock("resolved_requests").await;
            let mut events = session.subscribe();
            session.start_thread().await.expect("thread/start");
            session
                .start_turn("wait for interaction")
                .await
                .expect("turn/start");
            checkpoint(&mut events).await;
            assert_eq!(
                session.status().phase,
                SessionPhase::AwaitingApproval,
                "wrong-thread resolutions must not consume active requests"
            );
            session
                .steer("server withdraws pending requests")
                .await
                .expect("steer");
            checkpoint(&mut events).await;
            let phase = session.status().phase;
            assert!(
                session
                    .respond_approval(proto::RequestId::Integer(7), ApprovalAction::Approve)
                    .await
                    .is_err(),
                "expired command must not be answered"
            );
            assert!(
                session
                    .respond_approval(proto::RequestId::Integer(9), ApprovalAction::Approve)
                    .await
                    .is_err(),
                "expired patch must not be answered"
            );
            assert!(
                !session
                    .respond_user_input_once(proto::RequestId::Integer(8), Default::default())
                    .await
                    .expect("auto-answer"),
                "expired question must not be auto-answered"
            );
            session.shutdown().await;
            assert_eq!(
                phase,
                SessionPhase::TurnRunning,
                "resolved requests must release waiting state"
            );
            true
        })
}
