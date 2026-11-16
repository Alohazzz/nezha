//! Structured turns use unique attachment directories; cleanup never names the task's shared directory.
use std::path::PathBuf;
use std::sync::Arc;

pub struct TurnAttachments {
    id: String,
    directory: PathBuf,
}

impl TurnAttachments {
    pub fn new(project: &str, task: &str) -> Result<Arc<Self>, String> {
        if task.is_empty() || task.contains(['/', '\\', ':']) || task.contains("..") {
            return Err("Invalid task id".into());
        }
        let id = format!("{task}/{}", uuid::Uuid::new_v4());
        Ok(Arc::new(Self { directory: crate::attachments::task_attachments_dir(project, &id), id }))
    }
    pub fn id(&self) -> &str { &self.id }
    pub async fn save_images(&self, project: &str, images: Vec<String>) -> Result<Vec<String>, String> {
        let project = project.to_owned();
        let id = self.id.clone();
        tokio::task::spawn_blocking(move || {
            crate::pty::validate_task_project_path(&project)?;
            crate::attachments::save_task_images(&project, &id, &images)
        }).await.map_err(|error| error.to_string())?
    }
}

impl Drop for TurnAttachments {
    fn drop(&mut self) {
        let directory = self.directory.clone();
        // Completion publishes done before dropping its resource snapshot. Slow
        // filesystem deletion cannot delay done or touch a subsequent turn.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || { let _ = std::fs::remove_dir_all(directory); });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn delayed_old_turn_cleanup_cannot_delete_immediately_resumed_attachments() {
        let project = std::env::temp_dir().join(format!("nezha-artifacts-{}", uuid::Uuid::new_v4()));
        let old = TurnAttachments::new(project.to_str().unwrap(), "task").unwrap();
        let resumed = TurnAttachments::new(project.to_str().unwrap(), "task").unwrap();
        assert_eq!(old.directory.parent().unwrap().file_name().unwrap(), "task");
        assert!(TurnAttachments::new(project.to_str().unwrap(), "../escape").is_err());
        std::fs::create_dir_all(&old.directory).unwrap();
        std::fs::create_dir_all(&resumed.directory).unwrap();
        std::fs::write(old.directory.join("0.png"), b"old").unwrap();
        std::fs::write(resumed.directory.join("0.png"), b"new").unwrap();
        // Hold the old generation's cleanup resource while the resumed turn writes.
        let delayed_cleanup = old.clone();
        drop(old);
        assert_eq!(std::fs::read(resumed.directory.join("0.png")).unwrap(), b"new");
        let old_directory = delayed_cleanup.directory.clone();
        drop(delayed_cleanup);
        for _ in 0..100 {
            if !old_directory.exists() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(!old_directory.exists());
        assert_eq!(std::fs::read(resumed.directory.join("0.png")).unwrap(), b"new");
        drop(resumed);
    }
}

