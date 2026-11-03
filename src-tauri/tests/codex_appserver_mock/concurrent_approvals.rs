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
        &serde_json::json!({ "turn": { "id": "turn-batch" } }),
    );
    emit(
        out,
        &serde_json::json!({
            "method": "turn/started",
            "params": { "threadId": "thread-happy", "turn": {
                "id": "turn-batch", "status": "inProgress", "items": [],
            } },
        })
        .to_string(),
    );
    for id in 0..3 {
        emit(
            out,
            &serde_json::json!({
                "method": "item/commandExecution/requestApproval", "id": id,
                "params": { "kind": "command", "threadId": "thread-happy",
                    "turnId": "turn-batch", "itemId": format!("cmd-{id}"),
                    "startedAtMs": 1, "command": "echo ok", "cwd": "C:\\work",
                    "availableDecisions": ["accept", "decline", "cancel"],
                },
            })
            .to_string(),
        );
    }
    if script == "concurrent_question" {
        emit(
            out,
            &serde_json::json!({
            "method": "item/tool/requestUserInput", "id": 3,
            "params": { "threadId": "thread-happy", "turnId": "turn-batch",
                "itemId": "question-1", "isBlocking": true, "questions": [{
                    "id": "q", "header": "Scope", "question": "Continue?",
                    "options": [{ "label": "Yes", "description": "Continue" }],
                }],
            },
            })
            .to_string(),
        );
    }
    let response_count = if script == "concurrent_question" {
        4
    } else {
        3
    };
    for expected_id in 0..response_count {
        let mut answer = String::new();
        assert!(reader.read_line(&mut answer).unwrap_or(0) > 0);
        let answer: serde_json::Value = serde_json::from_str(&answer).expect("response JSON");
        assert_eq!(
            answer["id"], expected_id,
            "each request must be answered once"
        );
        if expected_id < 3 {
            assert_eq!(answer["result"]["decision"], "accept");
        } else {
            assert!(answer["result"]["answers"].is_object());
        }
    }
}

pub(super) fn run() -> bool {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        for script in ["concurrent", "concurrent_question"] {
            let session = spawn_mock(script).await;
            let mut events = session.subscribe();
            session.start_thread().await.expect("thread/start");
            session
                .start_turn("three parallel commands")
                .await
                .expect("turn/start");
            let mut approvals = 0;
            let mut questions = 0;
            let has_question = script == "concurrent_question";
            while approvals < 3 || (has_question && questions < 1) {
                match tokio::time::timeout(std::time::Duration::from_secs(2), events.recv()).await {
                    Ok(Ok(CodexEvent::ApprovalRequested { .. })) => approvals += 1,
                    Ok(Ok(CodexEvent::UserInputRequested { .. })) => questions += 1,
                    Ok(Ok(_)) => {}
                    other => panic!("missing concurrent request: {other:?}"),
                }
            }
            for id in 0..3 {
                session
                    .respond_approval(proto::RequestId::Integer(id), ApprovalAction::Approve)
                    .await
                    .expect("approve request");
                let expected = if id < 2 || has_question {
                    SessionPhase::AwaitingApproval
                } else {
                    SessionPhase::TurnRunning
                };
                assert_eq!(
                    session.status().phase,
                    expected,
                    "unanswered approvals or questions must keep the session waiting"
                );
                assert!(
                    session
                        .respond_approval(proto::RequestId::Integer(id), ApprovalAction::Approve)
                        .await
                        .is_err(),
                    "an answered request cannot be answered twice"
                );
            }
            if has_question {
                // Manual/automatic responders race for the same question; exactly one wins.
                let (manual, automatic) = tokio::join!(
                    session.respond_user_input(proto::RequestId::Integer(3), Default::default()),
                    session
                        .respond_user_input_once(proto::RequestId::Integer(3), Default::default()),
                );
                assert_eq!(
                    usize::from(manual.is_ok())
                        + usize::from(automatic.expect("automatic response")),
                    1
                );
            }
            assert_eq!(session.status().phase, SessionPhase::TurnRunning);
            session
                .steer("finish after replies")
                .await
                .expect("steer after all replies");
            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(2), events.recv()).await {
                    Ok(Ok(CodexEvent::TurnCompleted { .. })) => break,
                    Ok(Ok(_)) => {}
                    other => panic!("turn did not complete after all replies: {other:?}"),
                }
            }
            assert_eq!(session.status().phase, SessionPhase::Idle);
            session.shutdown().await;
        }
        true
    })
}
