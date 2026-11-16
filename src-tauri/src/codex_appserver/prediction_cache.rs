use serde::Serialize;
use std::collections::VecDeque;

pub const PROMPT_VERSION: &str = "nezha-next-message-v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionKey {
    pub task_id: String,
    pub thread_id: String,
    pub source_turn_id: String,
    pub session_generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionState {
    #[serde(flatten)]
    pub key: PredictionKey,
    pub revision: u64,
    pub status: String,
    pub suggestion: Option<String>,
    pub prompt_version: String,
    pub model: String,
    pub effort: String,
    pub parent_effort: Option<String>,
    pub created_at: u64,
}

#[derive(Default)]
pub struct PredictionCache {
    entries: VecDeque<PredictionState>,
    revision: u64,
}

impl PredictionCache {
    pub fn begin(
        &mut self,
        key: PredictionKey,
        model: String,
        parent_effort: Option<String>,
    ) -> Option<PredictionState> {
        if self.entries.iter().any(|state| state.key == key) {
            return None;
        }
        self.entries
            .retain(|state| state.key.task_id != key.task_id);
        self.revision += 1;
        let state = PredictionState {
            key,
            revision: self.revision,
            status: "pending".into(),
            suggestion: None,
            prompt_version: PROMPT_VERSION.into(),
            model,
            effort: "high".into(),
            parent_effort,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        self.entries.push_back(state.clone());
        while self.entries.len() > 100 {
            self.entries.pop_front();
        }
        Some(state)
    }

    pub fn finish(
        &mut self,
        key: &PredictionKey,
        suggestion: Option<String>,
    ) -> Option<PredictionState> {
        let state = self
            .entries
            .iter_mut()
            .find(|state| &state.key == key && state.status == "pending")?;
        self.revision += 1;
        state.revision = self.revision;
        state.status = "complete".into();
        state.suggestion = suggestion;
        Some(state.clone())
    }

    pub fn invalidate(&mut self, task: &str) -> Option<PredictionState> {
        let state = self
            .entries
            .iter_mut()
            .find(|state| state.key.task_id == task)?;
        self.revision += 1;
        state.revision = self.revision;
        state.status = "invalidated".into();
        state.suggestion = None;
        Some(state.clone())
    }

    pub fn invalidate_key(&mut self, key: &PredictionKey) -> Option<PredictionState> {
        if !self.entries.iter().any(|state| &state.key == key) {
            return None;
        }
        self.invalidate(&key.task_id)
    }

    pub fn invalidate_all(&mut self) -> Vec<PredictionState> {
        let tasks: Vec<_> = self
            .entries
            .iter()
            .map(|state| state.key.task_id.clone())
            .collect();
        tasks
            .iter()
            .filter_map(|task| self.invalidate(task))
            .collect()
    }

    pub fn get(&mut self, task: &str, thread: &str) -> Option<PredictionState> {
        let index = self
            .entries
            .iter()
            .position(|state| state.key.task_id == task && state.key.thread_id == thread)?;
        let state = self.entries.remove(index)?;
        self.entries.push_back(state.clone());
        Some(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalidated_round_cannot_be_restored_by_late_prediction() {
        let mut cache = PredictionCache::default();
        let key = PredictionKey {
            task_id: "task".into(),
            thread_id: "thread".into(),
            source_turn_id: "turn".into(),
            session_generation: 1,
        };
        let pending = cache.begin(key.clone(), "model".into(), None).unwrap();
        assert!(cache.begin(key.clone(), "model".into(), None).is_none());
        let invalidated = cache.invalidate("task").unwrap();
        assert!(invalidated.revision > pending.revision);
        assert!(cache.finish(&key, Some("Run the checks.".into())).is_none());
        assert_eq!(cache.get("task", "thread").unwrap().status, "invalidated");
    }
    #[test]
    fn old_generation_cannot_invalidate_new_round_and_cache_is_lru_bounded() {
        let mut cache = PredictionCache::default();
        let key = |id: usize, generation| PredictionKey {
            task_id: id.to_string(),
            thread_id: "thread".into(),
            source_turn_id: "turn".into(),
            session_generation: generation,
        };
        for id in 0..100 {
            cache.begin(key(id, 1), "model".into(), None);
        }
        assert!(cache.get("0", "thread").is_some());
        cache.begin(key(100, 1), "model".into(), None);
        assert!(cache.get("1", "thread").is_none());
        assert!(cache.get("0", "thread").is_some());
        cache.begin(key(0, 2), "model".into(), None);
        assert!(cache.invalidate_key(&key(0, 1)).is_none());
        assert!(cache.finish(&key(0, 1), Some("stale".into())).is_none());
        assert_eq!(cache.get("0", "thread").unwrap().status, "pending");
    }
}
