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

/// Global settings affect every cached/warm task, including hidden projects.
/// Capture all generations before the first await; Running turns are never cancelled.
pub fn prepare_all(manager: &crate::TaskManager) -> Vec<(String, Option<u64>)> {
    let tasks: Vec<_> = manager.codex_appserver_sessions.lock().keys().cloned().collect();
    tasks.into_iter().map(|task| {
        let generation = prepare(manager, &task, false);
        (task, generation)
    }).collect()
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
    async fn global_configuration_change_retires_unselected_tasks_without_cancelling_running() {
        let manager = crate::TaskManager::empty_for_test();
        let mut guards = Vec::new();
        for task in ["selected", "unselected", "running"] {
            let guard = ForwarderGuard::new(Lifecycle::running().generation());
            retained_session::activate(&manager, task, &guard, Arc::new(CodexAppServerSession { core: SessionCore::test_core() })).unwrap();
            if task != "running" {
                retained_session::set_retention(&manager, task, guard.generation(), true);
                assert!(retained_session::completed(&manager, task, guard.generation(), "turn", Instant::now()).is_some());
            }
            guards.push((task, guard));
        }
        let closing = prepare_all(&manager);
        for (task, guard) in &guards {
            assert_eq!(guard.is_cancelled(), *task != "running");
        }
        for (task, generation) in closing { finish(&manager, &task, generation).await.unwrap(); }
        assert_eq!(retained_session::active_ids(&manager), vec!["running"]);
        assert_eq!(manager.codex_appserver_sessions.lock().len(), 1);
        retained_session::close_task(&manager, "running").await.unwrap();
    }

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
