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
            true
        })
}
