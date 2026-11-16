//! Session ownership operations. Map locks never cover RPC or filesystem work.
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Instant;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use super::session_lifecycle::LifecyclePhase;
use super::task_bridge::{ForwarderGuard, StructuredTaskEntry};
use super::CodexAppServerSession;

// Start reservations contain only cancellation tokens, never an async mutex.
// They prevent duplicate launches while allowing cancel/reset to preempt any await.
static STARTS: Lazy<Mutex<HashMap<String, Weak<ForwarderGuard>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub struct StartReservation {
    task: String,
    token: Arc<ForwarderGuard>,
}

pub fn begin_start(task: &str) -> Result<StartReservation, String> {
    let mut starts = STARTS.lock();
    starts.retain(|_, token| token.strong_count() > 0);
    if starts.get(task).and_then(Weak::upgrade).is_some() {
        return Err("structured task is already starting or stopping".into());
    }
    let token = Arc::new(ForwarderGuard::new(super::session_lifecycle::Lifecycle::running().generation()));
    starts.insert(task.to_owned(), Arc::downgrade(&token));
    Ok(StartReservation { task: task.to_owned(), token })
}

impl StartReservation {
    pub fn token(&self) -> &ForwarderGuard { &self.token }
    pub fn check(&self) -> Result<(), String> {
        if self.token.is_cancelled() { Err("structured start was cancelled".into()) } else { Ok(()) }
    }
    pub async fn cancelled(&self) { self.token.cancelled().await }
    pub fn activate(&self, manager: &crate::TaskManager, guard: &ForwarderGuard, session: Arc<CodexAppServerSession>) -> Result<(), String> {
        let _starts = STARTS.lock();
        self.check()?;
        activate(manager, &self.task, guard, session)
    }
}

pub fn cancel_start(task: &str) {
    if let Some(token) = STARTS.lock().get(task).and_then(Weak::upgrade) { token.cancel(); }
}

pub fn owns(manager: &crate::TaskManager, task: &str, generation: u64) -> bool {
    manager
        .codex_appserver_sessions
        .lock()
        .get(task)
        .is_some_and(|entry| entry.lifecycle.is_owner(generation))
}

pub fn active_ids(manager: &crate::TaskManager) -> Vec<String> {
    manager
        .codex_appserver_sessions
        .lock()
        .iter()
        .filter(|(_, entry)| entry.lifecycle.is_active())
        .map(|(id, _)| id.clone())
        .collect()
}

/// Capability policy opts in only after checking the actual thread/model/CLI.
/// False by default: merely installing the lifecycle does not retain processes.
pub fn set_retention(manager: &crate::TaskManager, task: &str, generation: u64, enabled: bool) {
    if let Some(entry) = manager
        .codex_appserver_sessions
        .lock()
        .get_mut(task)
        .filter(|e| e.lifecycle.is_owner(generation))
    {
        entry.retain_on_success = enabled;
    }
}

pub fn completed(
    manager: &crate::TaskManager,
    task: &str,
    generation: u64,
    turn: &str,
    now: Instant,
) -> Option<Instant> {
    let mut sessions = manager.codex_appserver_sessions.lock();
    let retained = sessions
        .values()
        .filter(|e| e.lifecycle.is_retained())
        .count();
    let entry = sessions
        .get_mut(task)
        .filter(|e| e.lifecycle.is_owner(generation))?;
    if !entry
        .lifecycle
        .complete(turn, entry.retain_on_success, retained, now)
    {
        return None;
    }
    entry
        .lifecycle
        .is_retained()
        .then(|| entry.lifecycle.deadline())
        .flatten()
}

/// Keep Closing entry registered until reap is confirmed; never hold a table lock while waiting.
pub async fn close_owned(
    manager: &crate::TaskManager,
    task: &str,
    generation: u64,
) -> Result<(), String> {
    let session = {
        let mut sessions = manager.codex_appserver_sessions.lock();
        let Some(entry) = sessions
            .get_mut(task)
            .filter(|e| e.lifecycle.is_owner(generation))
        else {
            return Ok(());
        };
        entry.lifecycle.begin_close();
        entry.guard.cancel();
        entry.session.clone()
    };
    session.shutdown_confirmed().await?;
    let mut sessions = manager.codex_appserver_sessions.lock();
    if let Some(entry) = sessions
        .get_mut(task)
        .filter(|e| e.lifecycle.is_owner(generation))
    {
        entry.lifecycle.closed();
        sessions.remove(task);
    }
    Ok(())
}

pub async fn close_task(manager: &crate::TaskManager, task: &str) -> Result<(), String> {
    cancel_start(task);
    let generation = manager
        .codex_appserver_sessions
        .lock()
        .get(task)
        .map(|e| e.lifecycle.generation());
    if let Some(generation) = generation {
        close_owned(manager, task, generation).await?;
    }
    Ok(())
}

/// A short reservation prevents duplicate submissions; cancellation can preempt readiness.
pub async fn claim_resume(
    manager: &crate::TaskManager,
    task: &str,
    thread: &str,
    cwd: &str,
    approval: &str,
    sandbox: &str,
    reservation: &StartReservation,
) -> Result<Option<(Arc<CodexAppServerSession>, ForwarderGuard)>, String> {
    reservation.check()?;
    let candidate = {
        let mut sessions = manager.codex_appserver_sessions.lock();
        if let Some(entry) = sessions.get_mut(task) {
            if entry.lifecycle.is_active() {
                return Err("structured task is already running or resuming".into());
            }
            if entry.lifecycle.claim_resume(Instant::now()) {
                entry.guard.cancel();
                entry.guard = ForwarderGuard::new(entry.lifecycle.generation());
                entry.retain_on_success = false;
                Some((entry.session.clone(), entry.guard.clone()))
            } else {
                None
            }
        } else {
            None
        }
    };
    if let Some((session, guard)) = candidate {
        let ready = tokio::select! {
            _ = reservation.cancelled() => false,
            ready = session.ready_to_resume(thread, cwd, approval, sandbox) => ready,
        };
        if ready && reservation.check().is_ok() { return Ok(Some((session, guard))); }
        close_owned(manager, task, guard.generation()).await?;
        reservation.check()?;
        return Ok(None);
    }
    let generation = manager
        .codex_appserver_sessions
        .lock()
        .get(task)
        .map(|e| e.lifecycle.generation());
    if let Some(generation) = generation {
        close_owned(manager, task, generation).await?;
    }
    Ok(None)
}

pub fn activate(
    manager: &crate::TaskManager,
    task: &str,
    guard: &ForwarderGuard,
    session: Arc<CodexAppServerSession>,
) -> Result<(), String> {
    let mut sessions = manager.codex_appserver_sessions.lock();
    match sessions.get_mut(task) {
        Some(entry) if entry.lifecycle.is_owner(guard.generation()) => {
            if !entry.lifecycle.activate() {
                return Err("structured session is not awaiting activation".into());
            }
        }
        None => {
            sessions.insert(
                task.to_owned(),
                StructuredTaskEntry::new(session, guard.clone()),
            );
        }
        Some(_) => return Err("structured session owner changed before activation".into()),
    }
    Ok(())
}

pub fn spawn_expiry(app: tauri::AppHandle, task: String, guard: ForwarderGuard, deadline: Instant) {
    use tauri::Manager;
    let errors = app.try_state::<crate::TaskManager>().and_then(|manager| {
        manager
            .codex_appserver_sessions
            .lock()
            .get(&task)
            .map(|entry| entry.session.subscribe_errors())
    });
    tokio::spawn(async move {
        let generation = guard.generation();
        let Some(mut errors) = errors else {
            return;
        };
        let transport_failed;
        tokio::select! {
            _ = tokio::time::sleep_until(deadline.into()) => { transport_failed = false; },
            _ = errors.recv() => { transport_failed = true; },
            _ = guard.cancelled() => return,
        }
        let Some(manager) = app.try_state::<crate::TaskManager>() else {
            return;
        };
        let expire = manager
            .codex_appserver_sessions
            .lock()
            .get_mut(&task)
            .is_some_and(|entry| {
                if transport_failed
                    && entry.lifecycle.is_owner(generation)
                    && entry.lifecycle.is_retained()
                {
                    entry.lifecycle.begin_close();
                    true
                } else {
                    entry.lifecycle.expire(generation, Instant::now())
                }
            });
        if expire {
            if let Err(error) = close_owned(&manager, &task, generation).await {
                eprintln!("[codex_appserver] retained session close failed: {error}");
            }
        }
    });
}

pub fn generation(manager: &crate::TaskManager, task: &str) -> Option<u64> {
    manager
        .codex_appserver_sessions
        .lock()
        .get(task)
        .map(|e| e.lifecycle.generation())
}

pub fn is_running(entry: &StructuredTaskEntry) -> bool {
    entry.lifecycle.phase == LifecyclePhase::Running
}

#[cfg(test)]
mod tests {
    use super::super::{session_lifecycle::Lifecycle, SessionCore};
    use super::*;

    #[tokio::test]
    async fn global_warm_budget_excludes_retained_sessions_from_running_tasks() {
        let manager = crate::TaskManager::empty_for_test();
        let mut guards = Vec::new();
        for task in ["project-a-task", "project-b-task", "project-c-task"] {
            let guard = ForwarderGuard::new(Lifecycle::running().generation());
            let session = Arc::new(CodexAppServerSession {
                core: SessionCore::test_core(),
            });
            activate(&manager, task, &guard, session).unwrap();
            set_retention(&manager, task, guard.generation(), true);
            guards.push(guard);
        }
        assert_eq!(active_ids(&manager).len(), 3);
        for (index, task) in ["project-a-task", "project-b-task", "project-c-task"]
            .into_iter()
            .enumerate()
        {
            assert_eq!(
                completed(
                    &manager,
                    task,
                    guards[index].generation(),
                    "turn",
                    Instant::now()
                )
                .is_some(),
                index < 2
            );
        }
        assert!(active_ids(&manager).is_empty());
        for task in ["project-a-task", "project-b-task", "project-c-task"] {
            close_task(&manager, task).await.unwrap();
        }
    }

    #[tokio::test]
    async fn old_generation_close_cannot_remove_replacement_and_disabled_retention_closes() {
        let manager = crate::TaskManager::empty_for_test();
        let first = ForwarderGuard::new(Lifecycle::running().generation());
        activate(
            &manager,
            "task",
            &first,
            Arc::new(CodexAppServerSession {
                core: SessionCore::test_core(),
            }),
        )
        .unwrap();
        assert!(completed(&manager, "task", first.generation(), "turn", Instant::now()).is_none());
        close_task(&manager, "task").await.unwrap();
        let second = ForwarderGuard::new(Lifecycle::running().generation());
        activate(
            &manager,
            "task",
            &second,
            Arc::new(CodexAppServerSession {
                core: SessionCore::test_core(),
            }),
        )
        .unwrap();
        close_owned(&manager, "task", first.generation())
            .await
            .unwrap();
        assert!(owns(&manager, "task", second.generation()));
        assert_eq!(active_ids(&manager), vec!["task"]);
        close_task(&manager, "task").await.unwrap();
    }

    #[tokio::test]
    async fn cancel_preempts_a_stalled_start_without_waiting_for_rpc() {
        let reservation = begin_start("stalled-start-test").unwrap();
        assert!(begin_start("stalled-start-test").is_err());
        let (started, received) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let _ = started.send(());
            tokio::select! {
                _ = std::future::pending::<()>() => panic!("stalled RPC unexpectedly completed"),
                _ = reservation.cancelled() => reservation.check(),
            }
        });
        received.await.unwrap();
        cancel_start("stalled-start-test");
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100), worker).await.unwrap().unwrap().is_err());
        assert!(begin_start("stalled-start-test").is_ok());
    }
}
