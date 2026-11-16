//! Application persistence commands retire optional prediction resources at ownership boundaries.
//! Storage cores remain usable by migrations; these commands never attach cleanup to raw disk I/O.
use crate::codex_appserver::{prediction, prediction_registry::Registry, prediction_retirement};
use crate::{
    storage::{self, Project, Task},
    TaskManager,
};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::{collections::HashMap, sync::Arc};
use tauri::{AppHandle, State};

static REGISTRY: Lazy<Mutex<Registry>> = Lazy::new(|| Mutex::new(Registry::default()));
static WRITES: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
fn writer(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    WRITES.lock().entry(key.to_owned()).or_default().clone()
}
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid project identifier".into());
    }
    Ok(())
}
fn prepare(
    app: &AppHandle,
    manager: &TaskManager,
    changes: Vec<(String, bool)>,
) -> Vec<(String, Option<u64>)> {
    changes
        .into_iter()
        .map(|(task, removed)| {
            prediction::invalidate(app, &task);
            let generation = prediction_retirement::prepare(manager, &task, removed);
            (task, generation)
        })
        .collect()
}
async fn finish(manager: &TaskManager, closing: Vec<(String, Option<u64>)>) {
    futures_util::future::join_all(closing.into_iter().map(|(task, generation)| async move {
        if let Err(error) = prediction_retirement::finish(manager, &task, generation).await {
            eprintln!("[codex prediction] persistence cleanup failed: {error}");
        }
    }))
    .await;
}

#[tauri::command]
pub async fn load_projects() -> Result<Vec<Project>, String> {
    let projects = tokio::task::spawn_blocking(storage::load_projects)
        .await
        .map_err(|e| e.to_string())??;
    REGISTRY.lock().remember_projects(&projects);
    Ok(projects)
}
#[tauri::command]
pub async fn load_project_tasks(project_id: String) -> Result<Vec<Task>, String> {
    validate_id(&project_id)?;
    let id = project_id.clone();
    let tasks = tokio::task::spawn_blocking(move || storage::load_project_tasks(id))
        .await
        .map_err(|e| e.to_string())??;
    REGISTRY.lock().remember_tasks(&project_id, &tasks);
    Ok(tasks)
}
#[tauri::command]
pub async fn save_project_tasks(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    project_id: String,
    tasks: Vec<Task>,
) -> Result<(), String> {
    validate_id(&project_id)?;
    if tasks.iter().any(|task| task.project_id != project_id) {
        return Err("task project does not match target".into());
    }
    let known = REGISTRY.lock().has_tasks(&project_id);
    if !known {
        load_project_tasks(project_id.clone()).await?;
    }
    // In the normal loaded-project path this precedes the first await: no stale cache read
    // can slip through while the disk write is queued behind another save.
    let changes = REGISTRY.lock().update_tasks(&project_id, &tasks);
    let closing = prepare(&app, &manager, changes);
    let lock = writer(&format!("tasks:{project_id}"));
    let permit = lock.lock().await;
    let result =
        tokio::task::spawn_blocking(move || storage::save_project_tasks(project_id, tasks))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
    drop(permit);
    finish(&manager, closing).await;
    result
}
#[tauri::command]
pub async fn save_projects(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    projects: Vec<Project>,
) -> Result<(), String> {
    for project in &projects {
        validate_id(&project.id)?;
    }
    let known = REGISTRY.lock().has_projects();
    if !known {
        load_projects().await?;
    }
    let changed_projects = REGISTRY.lock().clone().update_projects(&projects);
    let mut changes = Vec::new();
    for (project, removed) in changed_projects {
        let known = REGISTRY.lock().has_tasks(&project);
        if !known {
            load_project_tasks(project.clone()).await?;
        }
        let tasks = REGISTRY.lock().task_ids(&project);
        changes.extend(tasks.into_iter().map(|task| (task, removed)));
    }
    REGISTRY.lock().update_projects(&projects);
    let closing = prepare(&app, &manager, changes);
    let lock = writer("projects");
    let permit = lock.lock().await;
    let result = tokio::task::spawn_blocking(move || storage::save_projects(projects))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    drop(permit);
    finish(&manager, closing).await;
    result
}
