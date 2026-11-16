//! Synchronous retirement decisions; process shutdown happens outside the session table lock.
use super::retained_session;

pub fn prepare(manager: &crate::TaskManager, task: &str, removed: bool) -> Option<u64> {
    if removed {
        retained_session::cancel_start(task);
    }
    let mut sessions = manager.codex_appserver_sessions.lock();
    let entry = sessions.get_mut(task)?;
    entry.session.invalidate_prediction_context();
    entry.retain_on_success = false;
    if removed || entry.lifecycle.is_retained() {
        entry.lifecycle.begin_close();
        entry.guard.cancel();
        Some(entry.lifecycle.generation())
    } else {
        None
    }
}

pub async fn finish(
    manager: &crate::TaskManager,
    task: &str,
    generation: Option<u64>,
) -> Result<(), String> {
    if let Some(generation) = generation {
        retained_session::close_owned(manager, task, generation).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_appserver::{
        session_lifecycle::Lifecycle, task_bridge::ForwarderGuard, CodexAppServerSession,
        SessionCore,
    };
    use std::{sync::Arc, time::Instant};

    #[tokio::test]
    async fn config_change_closes_auxiliary_session_but_preserves_running_user_turn() {
        let manager = crate::TaskManager::empty_for_test();
        let running = ForwarderGuard::new(Lifecycle::running().generation());
        let retained = ForwarderGuard::new(Lifecycle::running().generation());
        for (task, guard) in [("running", &running), ("warm", &retained)] {
            retained_session::activate(
                &manager,
                task,
                guard,
                Arc::new(CodexAppServerSession {
                    core: SessionCore::test_core(),
                }),
            )
            .unwrap();
        }
        retained_session::set_retention(&manager, "warm", retained.generation(), true);
        assert!(retained_session::completed(
            &manager,
            "warm",
            retained.generation(),
            "turn",
            Instant::now()
        )
        .is_some());
        assert_eq!(prepare(&manager, "running", false), None);
        assert!(!running.is_cancelled());
        let closing = prepare(&manager, "warm", false);
        assert_eq!(closing, Some(retained.generation()));
        assert!(retained.is_cancelled());
        finish(&manager, "warm", closing).await.unwrap();
        assert!(retained_session::owns(
            &manager,
            "running",
            running.generation()
        ));
        assert!(!retained_session::owns(
            &manager,
            "warm",
            retained.generation()
        ));
        assert_eq!(
            prepare(&manager, "running", true),
            Some(running.generation())
        );
        assert!(running.is_cancelled());
        finish(&manager, "running", Some(running.generation()))
            .await
            .unwrap();
    }
}
