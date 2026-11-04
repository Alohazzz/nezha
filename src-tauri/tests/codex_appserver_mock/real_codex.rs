use super::*;

async fn finish_turn(
    session: &CodexAppServerSession,
    events: &mut tokio::sync::broadcast::Receiver<CodexEvent>,
) -> usize {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(150);
    let mut file_approvals = 0;
    loop {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .expect("real turn timed out")
            .expect("real event stream");
        match event {
            CodexEvent::FileChangeApprovalRequested { request_id, .. } => {
                file_approvals += 1;
                session
                    .respond_approval(request_id, ApprovalAction::Approve)
                    .await
                    .expect("approve real patch");
            }
            CodexEvent::ApprovalRequested { request_id, .. } => {
                session
                    .respond_approval(request_id, ApprovalAction::Decline)
                    .await
                    .expect("decline unexpected shell command");
            }
            CodexEvent::UnsupportedServerRequest { method, .. } => {
                panic!("unexpected real request: {method}")
            }
            CodexEvent::TurnCompleted { turn, .. } => {
                assert_eq!(
                    turn.status,
                    proto::TurnStatus::Completed,
                    "real turn failed: {:?}",
                    turn.error_message()
                );
                return file_approvals;
            }
            _ => {}
        }
    }
}

pub(super) fn run(program: &str) -> bool {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let directory = std::env::temp_dir().join(format!("nezha-real-codex-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).expect("isolated fixture directory");
        let cwd = directory.to_str().expect("fixture path");
        let session = CodexAppServerSession::spawn(SpawnRequest::codex_app_server(
            program, cwd, "never", "danger-full-access",
        )).await.expect("real app-server");
        let mut events = session.subscribe();
        let thread = session.start_thread().await.expect("real thread/start");
        session.start_turn("Reply exactly READY. Do not use any tools.").await.expect("persist real thread");
        finish_turn(&session, &mut events).await;
        session.shutdown().await;

        let session = CodexAppServerSession::spawn(SpawnRequest::codex_app_server(
            program, cwd, "on-request", "read-only",
        )).await.expect("real app-server restart");
        let mut events = session.subscribe();
        session.resume_thread(&thread.id).await.expect("real thread/resume");
        session.start_turn(
            "Verification task: use apply_patch to create approval-probe.txt in the current working directory, containing exactly NEZHA_APPROVAL_OK. Do not touch other directories, run commands, or use other tools. Finish after the file is created.",
        ).await.expect("real restricted write");
        let approvals = finish_turn(&session, &mut events).await;
        session.shutdown().await;
        assert!(approvals > 0, "resuming full-access history in read-only mode must request file approval");
        let content = std::fs::read_to_string(directory.join("approval-probe.txt")).expect("approved file exists");
        assert_eq!(content.trim(), "NEZHA_APPROVAL_OK");
        println!("real_codex: resumed with restricted permissions; approved {approvals} patch request(s); fixture={cwd}");
        true
    })
}
