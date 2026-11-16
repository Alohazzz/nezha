//! Optional next-message predictions; never part of the user's business turn.

use super::prediction_cache::{PredictionCache, PredictionKey, PredictionState};
use super::prediction_policy;
use super::retained_session;
use super::task_bridge::ForwarderGuard;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::{watch, Semaphore};

const EVENT: &str = "codex-prompt-prediction";
pub const PROMPT: &str = include_str!("prediction_prompt.txt");
static CACHE: Lazy<Mutex<PredictionCache>> = Lazy::new(|| Mutex::new(PredictionCache::default()));
static SLOTS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(2)));
static POLICY: Lazy<watch::Sender<u64>> = Lazy::new(|| watch::channel(0).0);

pub fn policy_changes() -> watch::Receiver<u64> {
    POLICY.subscribe()
}
fn emit(app: &tauri::AppHandle, state: Option<PredictionState>) {
    if let Some(state) = state {
        let _ = app.emit(EVENT, state);
    }
}
pub fn invalidate(app: &tauri::AppHandle, task: &str) {
    let state = CACHE.lock().invalidate(task);
    emit(app, state);
}

/// Called before publishing done. It never reads files or sends RPC.
pub fn allow_retention(manager: &crate::TaskManager, task: &str, generation: u64) {
    let session = manager
        .codex_appserver_sessions
        .lock()
        .get(task)
        .map(|entry| entry.session.clone());
    let enabled =
        prediction_policy::enabled() && session.is_some_and(|session| session.can_predict());
    retained_session::set_retention(manager, task, generation, enabled);
}

pub fn schedule(app: tauri::AppHandle, task: String, guard: ForwarderGuard, completed_at: Instant) {
    let Some(manager) = app.try_state::<crate::TaskManager>() else {
        return;
    };
    let session = manager
        .codex_appserver_sessions
        .lock()
        .get(&task)
        .filter(|entry| {
            entry.lifecycle.is_owner(guard.generation()) && entry.lifecycle.is_retained()
        })
        .map(|entry| entry.session.clone());
    let Some(session) = session else {
        return;
    };
    let context = session.prediction_context();
    let revision = context.revision;
    let status = session.status();
    let (Some(thread), Some(turn), Some(model)) =
        (status.thread, status.last_completed_turn_id, context.model)
    else {
        return;
    };
    let key = PredictionKey {
        task_id: task.clone(),
        thread_id: thread.id,
        source_turn_id: turn,
        session_generation: guard.generation(),
    };
    let pending = CACHE.lock().begin(key.clone(), model, context.effort);
    if pending.is_none() {
        return;
    }
    emit(&app, pending);
    let slot = SLOTS.clone().try_acquire_owned();
    tokio::spawn(async move {
        let Ok(_slot) = slot else {
            let state = CACHE.lock().finish(&key, None);
            emit(&app, state);

            if let Some(manager) = app.try_state::<crate::TaskManager>() {
                let _ = retained_session::close_owned(&manager, &task, guard.generation()).await;
            }
            return;
        };
        let deadline = tokio::time::Instant::from_std(completed_at + Duration::from_secs(30));
        let mut policy = policy_changes();
        let eligible = tokio::select! {
            biased;
            _ = guard.cancelled() => false,
            _ = policy.changed() => false,
            result = tokio::time::timeout_at(deadline, session.prediction_queue_is_clear(&key.thread_id)) => {
                match result {
                    Ok(Ok(clear)) => clear,
                    Ok(Err(error)) => { session.record_prediction_protocol_result(&Err(error)); false },
                    Err(_) => false,
                }
            }
        };
        let current = app
            .try_state::<crate::TaskManager>()
            .is_some_and(|manager| retained_session::owns(&manager, &task, key.session_generation));
        if !eligible
            || !current
            || !prediction_policy::enabled()
            || !session.can_predict()
            || session.prediction_context().revision != revision
        {
            let state = CACHE.lock().finish(&key, None);
            emit(&app, state);
            if let Some(manager) = app.try_state::<crate::TaskManager>() {
                let _ =
                    retained_session::close_owned(&manager, &task, key.session_generation).await;
            }
            return;
        }
        set_predicting(&app, &task, key.session_generation, true);
        let result = session
            .sample_next_message(
                &key.thread_id,
                &key.source_turn_id,
                PROMPT,
                deadline,
                &guard,
                revision,
            )
            .await;
        set_predicting(&app, &task, key.session_generation, false);
        let current = app
            .try_state::<crate::TaskManager>()
            .is_some_and(|manager| retained_session::owns(&manager, &task, key.session_generation));
        if !current
            || !prediction_policy::enabled()
            || session.prediction_context().revision != revision
        {
            let state = CACHE.lock().invalidate_key(&key);
            emit(&app, state);
            return;
        }
        let failed = result.is_err();
        let suggestion = result
            .ok()
            .filter(|result| {
                result
                    .get("sourceTurnId")
                    .and_then(serde_json::Value::as_str)
                    == Some(key.source_turn_id.as_str())
            })
            .and_then(|result| {
                result
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_suggestion)
            });
        let state = CACHE.lock().finish(&key, suggestion);
        emit(&app, state);
        if failed {
            if let Some(manager) = app.try_state::<crate::TaskManager>() {
                let _ =
                    retained_session::close_owned(&manager, &task, key.session_generation).await;
            }
        }
    });
}

fn set_predicting(app: &tauri::AppHandle, task: &str, generation: u64, predicting: bool) {
    if let Some(manager) = app.try_state::<crate::TaskManager>() {
        if let Some(entry) = manager
            .codex_appserver_sessions
            .lock()
            .get_mut(task)
            .filter(|entry| entry.lifecycle.is_owner(generation) && entry.lifecycle.is_retained())
        {
            entry.lifecycle.phase = if predicting {
                super::session_lifecycle::LifecyclePhase::IdlePredicting
            } else {
                super::session_lifecycle::LifecyclePhase::IdleWarm
            };
        }
    }
}

#[tauri::command]
pub fn get_codex_prompt_prediction(task_id: String, thread_id: String) -> Option<PredictionState> {
    if !prediction_policy::enabled() {
        return None;
    }
    // The cache is populated only from registered TaskManager sessions; no paths or history are accepted.
    CACHE.lock().get(&task_id, &thread_id)
}

pub async fn change_enabled(app: &tauri::AppHandle, manager: &crate::TaskManager, enabled: bool) {
    prediction_policy::set_enabled(enabled);
    POLICY.send_modify(|revision| *revision += 1);
    if enabled {
        return;
    }
    let states = CACHE.lock().invalidate_all();
    for state in states {
        emit(app, Some(state));
    }
    let tasks: Vec<_> = manager
        .codex_appserver_sessions
        .lock()
        .iter()
        .filter(|(_, entry)| entry.lifecycle.is_retained())
        .map(|(id, _)| id.clone())
        .collect();
    for task in tasks {
        let generation = manager
            .codex_appserver_sessions
            .lock()
            .get(&task)
            .filter(|entry| entry.lifecycle.is_retained())
            .map(|entry| entry.lifecycle.generation());
        if let Some(generation) = generation {
            let _ = retained_session::close_owned(manager, &task, generation).await;
        }
    }
}

pub fn parse_suggestion(text: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Response {
        suggestion: Option<String>,
    }
    let parsed: Response = serde_json::from_str(text).ok()?;
    let suggestion = parsed.suggestion?;
    if suggestion
        .chars()
        .any(|c| matches!(c, '\n' | '\r' | '\u{0085}' | '\u{2028}' | '\u{2029}'))
    {
        return None;
    }
    let suggestion = suggestion.trim();
    (!suggestion.is_empty() && suggestion.chars().count() <= 240).then(|| suggestion.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_one_short_message_and_rejects_non_message_responses() {
        assert_eq!(
            parse_suggestion(r#"{"suggestion":"  实施这个方案。  "}"#).as_deref(),
            Some("实施这个方案。")
        );
        for invalid in [
            r#"{"suggestion":null}"#,
            r#"{"suggestion":" "}"#,
            r#"{"suggestion":"a\nb"}"#,
            r#"{"suggestion":"ok","explanation":"x"}"#,
            "```json\n{}\n```",
            "[\"a\",\"b\"]",
        ] {
            assert_eq!(parse_suggestion(invalid), None, "{invalid}");
        }
        assert!(
            parse_suggestion(&serde_json::json!({"suggestion": "😀".repeat(240)}).to_string())
                .is_some()
        );
        assert!(
            parse_suggestion(&serde_json::json!({"suggestion": "😀".repeat(241)}).to_string())
                .is_none()
        );
    }
}
