//! Last observed application snapshots, independent of selected task or current view.
use crate::storage::{Project, Task};
use std::collections::HashMap;

#[derive(Clone, PartialEq, Eq)]
struct Configuration {
    agent: String,
    mode: Option<String>,
    permission: String,
    model: Option<String>,
    effort: Option<String>,
    thread: Option<String>,
}
impl From<&Task> for Configuration {
    fn from(task: &Task) -> Self {
        Self {
            agent: task.agent.clone(),
            mode: task.run_mode.clone(),
            permission: task.permission_mode.clone(),
            model: task.model.clone(),
            effort: task.reasoning_effort.clone(),
            thread: task.codex_session_id.clone(),
        }
    }
}
#[derive(Clone, Default)]
pub struct Registry {
    tasks: HashMap<String, HashMap<String, Configuration>>,
    projects: Option<HashMap<String, bool>>,
}
impl Registry {
    pub fn has_tasks(&self, project: &str) -> bool {
        self.tasks.contains_key(project)
    }
    pub fn has_projects(&self) -> bool {
        self.projects.is_some()
    }
    pub fn remember_tasks(&mut self, project: &str, tasks: &[Task]) {
        self.tasks.entry(project.to_owned()).or_insert_with(|| {
            tasks
                .iter()
                .map(|task| (task.id.clone(), task.into()))
                .collect()
        });
    }
    pub fn remember_projects(&mut self, projects: &[Project]) {
        self.projects.get_or_insert_with(|| {
            projects
                .iter()
                .map(|p| (p.id.clone(), p.hidden_from_rail))
                .collect()
        });
    }
    /// Returned bool distinguishes task deletion from auxiliary configuration invalidation.
    pub fn update_tasks(&mut self, project: &str, tasks: &[Task]) -> Vec<(String, bool)> {
        let next: HashMap<String, Configuration> = tasks
            .iter()
            .map(|task| (task.id.clone(), task.into()))
            .collect();
        let previous = self
            .tasks
            .insert(project.to_owned(), next.clone())
            .unwrap_or_default();
        previous
            .into_iter()
            .filter_map(|(task, config)| match next.get(&task) {
                None => Some((task, true)),
                Some(current) if current != &config => Some((task, false)),
                _ => None,
            })
            .collect()
    }
    pub fn update_projects(&mut self, projects: &[Project]) -> Vec<(String, bool)> {
        let next: HashMap<_, _> = projects
            .iter()
            .map(|p| (p.id.clone(), p.hidden_from_rail))
            .collect();
        let previous = self.projects.replace(next.clone()).unwrap_or_default();
        previous
            .into_iter()
            .filter_map(|(project, hidden)| match next.get(&project) {
                None => Some((project, true)),
                Some(true) if !hidden => Some((project, false)),
                _ => None,
            })
            .collect()
    }
    pub fn task_ids(&self, project: &str) -> Vec<String> {
        self.tasks
            .get(project)
            .map(|tasks| tasks.keys().cloned().collect())
            .unwrap_or_default()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> Task {
        serde_json::from_value(serde_json::json!({
        "id":"task", "projectId":"project", "prompt":"do work", "agent":"codex", "permissionMode":"ask",
        "status":"done", "createdAt":1, "runMode":"structured", "codexSessionId":"thread"
    })).unwrap()
    }
    #[test]
    fn persistence_boundary_retires_changed_config_or_removed_task_but_not_read_receipts() {
        let mut registry = Registry::default();
        let original = task();
        registry.remember_tasks("project", &[original.clone()]);
        let mut changed = original;
        changed.unread_at = Some(10);
        changed.updated_at = Some(20);
        assert!(registry
            .update_tasks("project", &[changed.clone()])
            .is_empty());
        changed.permission_mode = "full_access".into();
        assert_eq!(
            registry.update_tasks("project", &[changed.clone()]),
            vec![("task".into(), false)]
        );
        changed.codex_session_id = Some("replacement-thread".into());
        assert_eq!(
            registry.update_tasks("project", &[changed]),
            vec![("task".into(), false)]
        );
        assert_eq!(
            registry.update_tasks("project", &[]),
            vec![("task".into(), true)]
        );
        assert!(registry.update_tasks("project", &[]).is_empty());
    }
    #[test]
    fn closing_or_removing_project_retires_its_tasks_but_rail_reorder_does_not() {
        let mut registry = Registry::default();
        let project = Project {
            id: "project".into(),
            name: "Synthetic".into(),
            path: "C:/synthetic".into(),
            branch: None,
            last_opened_at: 1,
            hidden_from_rail: false,
        };
        registry.remember_projects(&[project.clone()]);
        registry.remember_tasks("project", &[task()]);
        let mut next = project;
        next.last_opened_at = 2;
        next.name = "Renamed".into();
        assert!(registry.update_projects(&[next.clone()]).is_empty());
        next.hidden_from_rail = true;
        assert_eq!(
            registry.update_projects(&[next.clone()]),
            vec![("project".into(), false)]
        );
        assert_eq!(registry.task_ids("project"), vec!["task"]);
        next.hidden_from_rail = false;
        assert!(registry.update_projects(&[next]).is_empty());
        assert_eq!(
            registry.update_projects(&[]),
            vec![("project".into(), true)]
        );
        assert!(registry.update_projects(&[]).is_empty());
    }
}
