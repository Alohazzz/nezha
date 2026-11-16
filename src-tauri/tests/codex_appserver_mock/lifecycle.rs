use super::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(super) fn run() -> bool {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let session = Arc::new(spawn_mock("lifecycle").await);
            session.start_thread().await.unwrap();
            let mut events = session.subscribe();
            let cwd = std::env::temp_dir().to_string_lossy().to_string();
            assert!(
                session
                    .ready_to_resume("thread-happy", &cwd, "untrusted", "read-only")
                    .await
            );
            assert!(
                events.try_recv().is_err(),
                "sample child events leaked into parent subscription"
            );
            assert_eq!(session.status().thread.unwrap().id, "thread-happy");
            session.start_turn("first").await.unwrap();
            assert_eq!(
                session.status().phase,
                SessionPhase::Idle,
                "late turn/start response reopened a completed turn"
            );
            assert_eq!(
                session.status().last_completed_turn_id.as_deref(),
                Some("fast-turn")
            );
            assert!(
                !session
                    .ready_to_resume("thread-happy", &cwd, "never", "danger-full-access")
                    .await
            );
            let mut rebound = session.subscribe();
            assert!(rebound.try_recv().is_err(), "new channel replayed old turn");
            session.start_turn("second").await.unwrap();
            assert!(rebound.recv().await.is_ok());
            let (first, second) =
                tokio::join!(session.shutdown_confirmed(), session.shutdown_confirmed());
            assert!(
                first.is_ok() && second.is_ok(),
                "idempotent close must confirm child exit"
            );
            assert!(
                !session
                    .ready_to_resume("thread-happy", &cwd, "untrusted", "read-only")
                    .await
            );

            let stalled = spawn_mock("lifecycle_timeout").await;
            stalled.start_thread().await.unwrap();
            let start = Instant::now();
            assert!(
                !stalled
                    .ready_to_resume("thread-happy", &cwd, "untrusted", "read-only")
                    .await
            );
            assert!(
                start.elapsed() < Duration::from_millis(500),
                "readiness waited for normal 30s RPC timeout"
            );
            assert!(stalled.shutdown_confirmed().await.is_ok());

            // The real transport is waiting for turn/start; cancellation must not
            // queue behind the normal 30 second RPC deadline.
            use nezha_lib::codex_appserver::retained_session::{begin_start, cancel_start};
            let session = Arc::new(spawn_mock("lifecycle_start_stall").await);
            session.start_thread().await.unwrap();
            let mut events = session.subscribe();
            let reservation = begin_start("mock-stalled-start").unwrap();
            let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
            let worker = tokio::spawn(async move {
                let cancelled = tokio::select! {
                    _ = reservation.cancelled() => true,
                    _ = session.start_turn("stalled") => false,
                };
                let _ = cancelled_tx.send(cancelled);
                session.shutdown_confirmed().await.unwrap();
                cancelled
            });
            tokio::time::timeout(Duration::from_secs(1), events.recv()).await.unwrap().unwrap();
            let started = Instant::now();
            cancel_start("mock-stalled-start");
            assert!(tokio::time::timeout(Duration::from_millis(250), cancelled_rx).await.unwrap().unwrap());
            assert!(started.elapsed() < Duration::from_millis(250));
            assert!(tokio::time::timeout(Duration::from_secs(5), worker).await.unwrap().unwrap());

            let reservation = begin_start("mock-stalled-initialize").unwrap();
            let mut request = SpawnRequest::codex_app_server(std::env::current_exe().unwrap().to_str().unwrap(), &cwd, "never", "read-only");
            request.extra_envs.push((MOCK_ENV.into(), "lifecycle_initialize_stall".into()));
            let worker = tokio::spawn(async move {
                CodexAppServerSession::spawn_cancellable(request, reservation.token()).await.is_err()
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel_start("mock-stalled-initialize");
            assert!(tokio::time::timeout(Duration::from_secs(5), worker).await.unwrap().unwrap());
            true
        })
}
