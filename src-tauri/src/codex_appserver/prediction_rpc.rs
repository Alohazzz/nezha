//! Local DTOs for the verified experimental API; does not upgrade the pinned protocol crate.
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::{timeout, timeout_at, Instant};

use super::prediction_policy::{incompatible, PredictionContext};
use super::rpc::{self, RpcError};
use super::task_bridge::ForwarderGuard;
use super::{CodexAppServerSession, SessionPhase};

impl CodexAppServerSession {
    /// Auxiliary work must stop before preparing any real input or configuration change.
    pub fn invalidate_prediction_context(&self) {
        self.core.prediction.lock().revision += 1;
        self.core.prediction_changed.notify_waiters();
    }

    pub async fn prediction_context_changed(&self, revision: u64) {
        let changed = self.core.prediction_changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if self.prediction_context().revision == revision {
            changed.await;
        }
    }

    pub fn prediction_context(&self) -> PredictionContext {
        self.core.prediction.lock().clone()
    }

    pub fn can_predict(&self) -> bool {
        self.prediction_context().eligible()
            && self.status().phase == SessionPhase::Idle
            && self.core.approvals.lock().is_empty()
            && self.core.user_inputs.lock().is_empty()
    }

    /// True runtime eligibility: a plan checklist is deliberately not used as Plan-mode evidence.
    pub async fn prediction_queue_is_clear(&self, thread: &str) -> Result<bool, RpcError> {
        let (queue, goal) = tokio::try_join!(
            self.request("thread/queue/list", json!({"threadId": thread, "limit": 1})),
            self.request("thread/goal/get", json!({"threadId": thread})),
        )?;
        let empty = queue
            .get("data")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
            && queue.get("nextCursor") == Some(&Value::Null);
        let stopped = goal.get("goal") == Some(&Value::Null)
            || goal.pointer("/goal/status").and_then(Value::as_str) == Some("complete");
        Ok(empty && stopped)
    }

    pub fn record_prediction_protocol_result(&self, result: &Result<Value, RpcError>) {
        let mut context = self.core.prediction.lock();
        match result {
            Err(error) if incompatible(error) => context.unsupported = true,
            Ok(_) => context.supported = true,
            _ => {}
        }
    }

    /// Every sample has a tracked ID. Dropping a normal request is not a sample cancellation.
    pub async fn sample_next_message(
        &self,
        thread: &str,
        turn: &str,
        prompt: &str,
        deadline: Instant,
        guard: &ForwarderGuard,
        revision: u64,
    ) -> Result<Value, RpcError> {
        #[cfg(debug_assertions)]
        let timing_started = std::time::Instant::now();
        let id = self.core.ids.allocate();
        let (tx, rx) = oneshot::channel();
        self.core.pending.insert(id.clone(), "thread/sample", tx);
        struct Remove<'a> {
            table: &'a rpc::PendingTable,
            id: codex_app_server_protocol::RequestId,
        }
        impl Drop for Remove<'_> {
            fn drop(&mut self) {
                self.table.remove(&self.id);
            }
        }
        let _remove = Remove {
            table: &self.core.pending,
            id: id.clone(),
        };
        let line = rpc::encode_request(
            &id,
            "thread/sample",
            &json!({
                "threadId": thread, "expectedTurnId": turn, "prompt": prompt, "effort": "high",
                "threadSource": "composer_predictions", "turnTrigger": "composer_predictions",
                "disableMcp": true, "interruptOnCancel": true,
            }),
        );
        let changed = self.core.prediction_changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let mut policy = super::prediction::policy_changes();
        let request = async {
            if !super::prediction_policy::enabled()
                || self.prediction_context().revision != revision
            {
                return Err(cancelled());
            }
            self.write_line(&line).await.map_err(|_| cancelled())?;
            rx.await.map_err(|_| cancelled())?
        };
        let result = tokio::select! {
            biased;
            _ = guard.cancelled() => Err(cancelled()),
            _ = policy.changed() => Err(cancelled()),
            _ = &mut changed => Err(cancelled()),
            result = timeout_at(deadline, request) => result.unwrap_or_else(|_| Err(cancelled())),
        };
        if result.is_err() {
            // Parent resume runs concurrently; it never waits for this auxiliary cleanup.
            let _ = timeout(
                Duration::from_millis(250),
                self.request("thread/sample/cancel", json!({"requestId": id})),
            )
            .await;
        }
        #[cfg(debug_assertions)]
        super::prediction_diagnostics::rpc("thread/sample", Some(thread), timing_started.elapsed(), result.is_ok());
        self.record_prediction_protocol_result(&result);
        result
    }
}

fn cancelled() -> RpcError {
    RpcError {
        code: -2,
        message: "prediction cancelled or expired".into(),
        data: None,
    }
}
