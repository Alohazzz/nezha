//! Ownership of one business turn, independent of the app-server process lifetime.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub const RETENTION_LIMIT: Duration = Duration::from_secs(60);
pub const RETAINED_SESSION_LIMIT: usize = 2;
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    Running,
    IdlePredicting,
    IdleWarm,
    Resuming,
    Closing,
    Closed,
}

#[derive(Debug)]
pub struct Lifecycle {
    generation: u64,
    pub phase: LifecyclePhase,
    completed_turn: Option<String>,
    deadline: Option<Instant>,
}

impl Lifecycle {
    pub fn running() -> Self {
        Self::running_for(NEXT_GENERATION.fetch_add(1, Ordering::Relaxed))
    }
    pub(crate) fn running_for(generation: u64) -> Self {
        Self {
            generation,
            phase: LifecyclePhase::Running,
            completed_turn: None,
            deadline: None,
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn is_owner(&self, generation: u64) -> bool {
        self.generation == generation
    }
    pub fn is_active(&self) -> bool {
        matches!(
            self.phase,
            LifecyclePhase::Running | LifecyclePhase::Resuming
        )
    }
    pub fn is_retained(&self) -> bool {
        matches!(
            self.phase,
            LifecyclePhase::IdlePredicting | LifecyclePhase::IdleWarm
        )
    }
    pub fn last_completed_turn(&self) -> Option<&str> {
        self.completed_turn.as_deref()
    }
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// Called once, under the owner-table lock. Slot count includes all projects.
    pub fn complete(
        &mut self,
        turn: &str,
        retain: bool,
        retained: usize,
        completed_at: Instant,
    ) -> bool {
        if self.phase != LifecyclePhase::Running {
            return false;
        }
        self.completed_turn = Some(turn.to_owned());
        self.deadline = Some(completed_at + RETENTION_LIMIT);
        self.phase = if retain && retained < RETAINED_SESSION_LIMIT {
            LifecyclePhase::IdleWarm
        } else {
            LifecyclePhase::Closing
        };
        true
    }
    pub fn claim_resume(&mut self, now: Instant) -> bool {
        if !self.is_retained() || self.deadline.is_some_and(|deadline| now >= deadline) {
            return false;
        }
        self.generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        self.phase = LifecyclePhase::Resuming;
        self.deadline = None;
        true
    }
    pub fn activate(&mut self) -> bool {
        if self.phase != LifecyclePhase::Resuming {
            return false;
        }
        self.phase = LifecyclePhase::Running;
        true
    }
    pub fn begin_close(&mut self) {
        self.phase = LifecyclePhase::Closing;
    }
    pub fn closed(&mut self) {
        self.phase = LifecyclePhase::Closed;
    }
    pub fn expire(&mut self, generation: u64, now: Instant) -> bool {
        if self.is_owner(generation)
            && self.is_retained()
            && self.deadline.is_some_and(|deadline| now >= deadline)
        {
            self.begin_close();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warm_session_is_not_running_and_old_owner_cannot_close_resumed_turn() {
        let now = std::time::Instant::now();
        let mut life = Lifecycle::running();
        let old = life.generation();
        assert!(life.complete("turn-1", true, 0, now));
        assert!(!life.is_active());
        assert_eq!(life.last_completed_turn(), Some("turn-1"));
        assert!(life.claim_resume(now));
        assert!(life.is_active());
        assert!(!life.is_owner(old));
        assert!(!life.expire(old, now + RETENTION_LIMIT));
    }

    #[test]
    fn completed_generation_cannot_be_reactivated_without_claiming_resume() {
        let mut life = Lifecycle::running();
        life.complete("turn", true, 0, Instant::now());
        assert!(!life.activate());
        assert!(!life.is_active());
    }

    #[test]
    fn completion_is_once_and_retention_deadline_is_from_business_completion() {
        let now = Instant::now();
        let mut life = Lifecycle::running();
        assert!(life.complete("turn", true, 0, now));
        assert!(!life.complete("duplicate", true, 0, now + Duration::from_secs(30)));
        assert_eq!(life.last_completed_turn(), Some("turn"));
        assert_eq!(life.deadline(), Some(now + Duration::from_secs(60)));
        assert!(!life.claim_resume(now + Duration::from_secs(60)));
        assert!(life.expire(life.generation(), now + Duration::from_secs(60)));
        assert_eq!(life.phase, LifecyclePhase::Closing);
        assert!(!life.expire(life.generation(), now + Duration::from_secs(61)));
    }
}
