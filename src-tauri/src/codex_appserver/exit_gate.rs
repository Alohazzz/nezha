//! Exactly one cleanup attempt; its final exit event must be allowed through.
use std::sync::atomic::{AtomicU8, Ordering};
#[derive(Default)]
pub struct ExitGate(AtomicU8);
impl ExitGate {
    pub const fn new() -> Self {
        Self(AtomicU8::new(0))
    }
    pub fn begin(&self) -> bool {
        self.0
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
    pub fn ready(&self) -> bool {
        self.0.load(Ordering::Acquire) == 2
    }
    pub fn finish(&self) {
        self.0.store(2, Ordering::Release);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_exit_waits_for_cleanup_then_final_event_can_exit() {
        let gate = ExitGate::new();
        assert!(gate.begin());
        assert!(!gate.ready());
        assert!(!gate.begin(), "concurrent request started a second cleanup");
        gate.finish();
        assert!(
            gate.ready(),
            "final ExitRequested would loop instead of exiting"
        );
        assert!(!gate.begin());
    }
}
