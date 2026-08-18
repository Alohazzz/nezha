use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

#[cfg(windows)]
use std::path::Path;

use crate::storage::atomic_write;
use crate::TaskManager;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

fn default_send_shortcut() -> String {
    "mod_enter".to_string()
}

fn normalize_send_shortcut(value: String) -> String {
    match value.as_str() {
        "enter" | "mod_enter" => value,
        _ => default_send_shortcut(),
    }
}

fn default_shift_enter_newline() -> bool {
    true
}

fn default_claude_force_default_tui() -> bool {
    true
}

fn default_terminal_scrollback() -> u32 {
    1000
}

fn default_use_sideloaded_conpty() -> bool {
    true
}

/// scrollback 必须在 [500, 5000] 之间且为 500 的倍数；越界或非整步则就近 snap。
fn clamp_terminal_scrollback(value: u32) -> u32 {
    let clamped = value.clamp(500, 5000);
    ((clamped + 250) / 500) * 500
}

static CACHED_CLAUDE_VERSION: OnceLock<Mutex<Option<Option<String>>>> = OnceLock::new();
static CACHED_CODEX_VERSION: OnceLock<Mutex<Option<Option<String>>>> = OnceLock::new();
static SETTINGS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

const MAX_MODEL_OPTIONS: usize = 100;
const MAX_MODEL_ID_BYTES: usize = 1024;
const MAX_MODEL_LABEL_BYTES: usize = 256;
const MAX_REASONING_EFFORTS: usize = 32;
const MAX_REASONING_EFFORT_BYTES: usize = 128;

pub fn get_login_shell_env() -> &'static [(String, String)] {
    crate::platform::login_shell_env()
}

pub fn get_login_shell_path() -> &'static str {
    crate::platform::login_shell_path()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentModelOption {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "reasoningEfforts", default)]
    pub reasoning_efforts: Vec<String>,
    #[serde(
        rename = "defaultReasoningEffort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub default_reasoning_effort: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentModelCatalog {
    #[serde(default)]
    pub models: Vec<AgentModelOption>,
    #[serde(default)]
    pub initialized: bool,
    #[serde(
        rename = "initializedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub initialized_at: Option<i64>,
    #[serde(
        rename = "sourceVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub source_version: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AppSettings {
    #[serde(default)]
    pub claude_path: String,
    #[serde(default)]
    pub codex_path: String,
    #[serde(default = "default_send_shortcut")]
    pub send_shortcut: String,
    #[serde(default = "default_shift_enter_newline")]
    pub terminal_shift_enter_newline: bool,
    /// 强制 Claude TUI 走 default（classic 主屏渲染）模式：通过 `--settings` 注入
    /// `{"tui":"default"}` 覆盖用户 ~/.claude/settings.json 中的 tui 字段，
    /// 避免 fullscreen 渲染下的部分终端副作用（如 CJK 复制乱码、滚轮被劫持等）。
    #[serde(default = "default_claude_force_default_tui")]
    pub claude_force_default_tui: bool,
    #[serde(default = "default_terminal_scrollback")]
    pub terminal_scrollback: u32,
    /// 终端框选松手后自动把选区复制到剪贴板（copy-on-select）。默认关闭：
    /// 每次框选都会覆盖剪贴板，对部分用户是反直觉行为。
    #[serde(default)]
    pub terminal_copy_on_select: bool,
    /// Windows：优先使用随包侧载的新版 ConPTY（修复部分系统全屏 TUI 输出不进
    /// scrollback、滚轮无法回滚）。侧载版异常时的手动兜底：改为 false 并重启，
    /// 回到系统内置 ConPTY。详见 platform/windows.rs::preload_sideloaded_conpty。
    #[serde(default = "default_use_sideloaded_conpty")]
    pub use_sideloaded_conpty: bool,
    #[serde(default)]
    pub claude_model_catalog: AgentModelCatalog,
    #[serde(default)]
    pub codex_model_catalog: AgentModelCatalog,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            claude_path: String::new(),
            codex_path: String::new(),
            send_shortcut: default_send_shortcut(),
            terminal_shift_enter_newline: default_shift_enter_newline(),
            claude_force_default_tui: default_claude_force_default_tui(),
            terminal_scrollback: default_terminal_scrollback(),
            terminal_copy_on_select: false,
            use_sideloaded_conpty: default_use_sideloaded_conpty(),
            claude_model_catalog: AgentModelCatalog::default(),
            codex_model_catalog: AgentModelCatalog::default(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AgentLaunchSpec {
    pub program: String,
    pub extra_env: Vec<(String, String)>,
}

fn get_agent_configured_path(settings: &AppSettings, agent: &str) -> String {
    match agent {
        "codex" => {
            if settings.codex_path.is_empty() {
                "codex".to_string()
            } else {
                settings.codex_path.clone()
            }
        }
        _ => {
            if settings.claude_path.is_empty() {
                "claude".to_string()
            } else {
                settings.claude_path.clone()
            }
        }
    }
}

fn clear_cached_versions() {
    *CACHED_CLAUDE_VERSION
        .get_or_init(|| Mutex::new(None))
        .lock() = None;
    *CACHED_CODEX_VERSION
        .get_or_init(|| Mutex::new(None))
        .lock() = None;
}

fn settings_lock() -> &'static Mutex<()> {
    SETTINGS_LOCK.get_or_init(|| Mutex::new(()))
}

fn nezha_dir() -> Result<PathBuf, String> {
    let home = crate::platform::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    Ok(home.join(".nezha"))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(nezha_dir()?.join("settings.json"))
}

/// ConPTY 预加载 crash-loop 标记的唯一路径来源:platform/windows.rs 的预加载
/// 与下方 save_use_sideloaded_conpty 的清除必须指向同一文件,不要各自拼路径。
pub(crate) fn conpty_preload_marker_path() -> Option<PathBuf> {
    nezha_dir().ok().map(|dir| dir.join(".conpty-preload-inflight"))
}

fn detect_path(binary: &str) -> String {
    crate::platform::detect_path(binary)
}

fn resolve_input_path(path: &str, binary: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return detect_path(binary);
    }

    let detected = detect_path(trimmed);
    if detected.is_empty() {
        trimmed.to_string()
    } else {
        detected
    }
}

#[cfg(not(windows))]
fn resolve_agent_launch_spec_from_path(agent: &str, path: &str) -> AgentLaunchSpec {
    AgentLaunchSpec {
        program: resolve_input_path(path, agent),
        extra_env: Vec::new(),
    }
}

#[cfg(windows)]
fn path_file_name_eq(path: &Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(expected))
}

#[cfg(windows)]
fn find_scoped_package_root(path: &Path, scope: &str, package: &str) -> Option<PathBuf> {
    let mut current = if path.is_dir() { Some(path) } else { path.parent() };
    while let Some(dir) = current {
        let parent = dir.parent()?;
        if path_file_name_eq(dir, package) && path_file_name_eq(parent, scope) {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

#[cfg(windows)]
fn npm_package_root_from_shim(path: &Path, scope: &str, package: &str) -> Option<PathBuf> {
    let shim_dir = path.parent()?;
    let candidate = shim_dir.join("node_modules").join(scope).join(package);
    candidate.is_dir().then_some(candidate)
}

#[cfg(windows)]
fn candidate_from_ancestors(path: &Path, scope: &str, package: &str, relative: &[&str]) -> Option<PathBuf> {
    let package_root = find_scoped_package_root(path, scope, package)
        .or_else(|| npm_package_root_from_shim(path, scope, package))?;
    let mut candidate = package_root;
    for segment in relative {
        candidate.push(segment);
    }
    candidate.is_file().then_some(candidate)
}

#[cfg(windows)]
fn codex_vendor_artifact_from_vendor_root(vendor_root: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    if !vendor_root.is_dir() {
        return None;
    }

    let mut arch_roots = fs::read_dir(vendor_root)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    arch_roots.sort();

    for arch_root in arch_roots {
        let exe = arch_root.join("codex").join("codex.exe");
        if exe.is_file() {
            let path_dir = arch_root.join("path");
            return Some((exe, path_dir.is_dir().then_some(path_dir)));
        }
    }

    None
}

#[cfg(windows)]
fn resolve_codex_vendor_artifact(path: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    if path_file_name_eq(path, "codex.exe") && path.parent().is_some_and(|parent| path_file_name_eq(parent, "codex")) {
        let arch_root = path.parent()?.parent()?;
        let path_dir = arch_root.join("path");
        return Some((path.to_path_buf(), path_dir.is_dir().then_some(path_dir)));
    }

    if let Some(package_root) = find_scoped_package_root(path, "@openai", "codex")
        .or_else(|| npm_package_root_from_shim(path, "@openai", "codex"))
    {
        if let Some(found) = codex_vendor_artifact_from_vendor_root(&package_root.join("vendor")) {
            return Some(found);
        }

        let openai_dir = package_root.join("node_modules").join("@openai");
        if openai_dir.is_dir() {
            let mut package_dirs = fs::read_dir(&openai_dir)
                .ok()?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|candidate| {
                    candidate.is_dir()
                        && candidate
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with("codex-win32-"))
                })
                .collect::<Vec<_>>();
            package_dirs.sort();

            for package_dir in package_dirs {
                if let Some(found) = codex_vendor_artifact_from_vendor_root(&package_dir.join("vendor")) {
                    return Some(found);
                }
            }
        }
    }

    None
}

#[cfg(windows)]
fn prepend_to_path(entries: &[PathBuf]) -> Option<String> {
    let prefixes = entries
        .iter()
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if prefixes.is_empty() {
        return None;
    }

    let existing = get_login_shell_path();
    let mut combined = prefixes.join(";");
    if !existing.is_empty() {
        combined.push(';');
        combined.push_str(existing);
    }
    Some(combined)
}

#[cfg(windows)]
fn resolve_agent_launch_spec_from_path(agent: &str, path: &str) -> AgentLaunchSpec {
    let resolved = resolve_input_path(path, agent);
    let resolved_path = Path::new(&resolved);

    match agent {
        "claude" => {
            let program = if let Some(exe) = candidate_from_ancestors(
                resolved_path,
                "@anthropic-ai",
                "claude-code",
                &["bin", "claude.exe"],
            ) {
                exe.to_string_lossy().into_owned()
            } else {
                resolved
            };
            AgentLaunchSpec {
                program,
                extra_env: Vec::new(),
            }
        }
        "codex" => {
            if let Some((program, path_dir)) = resolve_codex_vendor_artifact(resolved_path) {
                let mut extra_env = Vec::new();
                if let Some(path_value) = prepend_to_path(&path_dir.into_iter().collect::<Vec<_>>()) {
                    extra_env.push(("PATH".to_string(), path_value));
                }
                extra_env.push(("CODEX_MANAGED_BY_NPM".to_string(), "1".to_string()));
                AgentLaunchSpec {
                    program: program.to_string_lossy().into_owned(),
                    extra_env,
                }
            } else {
                AgentLaunchSpec {
                    program: resolved,
                    extra_env: Vec::new(),
                }
            }
        }
        _ => AgentLaunchSpec {
            program: resolved,
            extra_env: Vec::new(),
        },
    }
}

fn get_agent_launch_spec_from_settings(settings: &AppSettings, agent: &str) -> AgentLaunchSpec {
    resolve_agent_launch_spec_from_path(agent, &get_agent_configured_path(settings, agent))
}

fn normalize_optional_catalog_value(
    value: Option<String>,
    field: &str,
    max_bytes: usize,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    validate_catalog_value(trimmed, field, max_bytes)?;
    Ok(Some(trimmed.to_string()))
}

fn validate_catalog_value(value: &str, field: &str, max_bytes: usize) -> Result<(), String> {
    if value.len() > max_bytes {
        return Err(format!("{field} is too long (maximum {max_bytes} bytes)."));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{field} cannot contain control characters."));
    }
    Ok(())
}

fn normalize_model_options(models: Vec<AgentModelOption>) -> Result<Vec<AgentModelOption>, String> {
    if models.len() > MAX_MODEL_OPTIONS {
        return Err(format!(
            "Too many model options (maximum {MAX_MODEL_OPTIONS})."
        ));
    }

    let mut normalized = Vec::with_capacity(models.len());
    for option in models {
        let model = option.model.trim();
        if model.is_empty() {
            return Err("Model identifier cannot be empty.".to_string());
        }
        validate_catalog_value(model, "Model identifier", MAX_MODEL_ID_BYTES)?;
        if normalized
            .iter()
            .any(|existing: &AgentModelOption| existing.model == model)
        {
            return Err(format!("Duplicate model identifier: {model}"));
        }

        let label =
            normalize_optional_catalog_value(option.label, "Model label", MAX_MODEL_LABEL_BYTES)?;
        if option.reasoning_efforts.len() > MAX_REASONING_EFFORTS {
            return Err(format!(
                "Too many reasoning efforts for {model} (maximum {MAX_REASONING_EFFORTS})."
            ));
        }
        let mut reasoning_efforts = Vec::with_capacity(option.reasoning_efforts.len());
        for effort in option.reasoning_efforts {
            let effort = effort.trim();
            if effort.is_empty() {
                continue;
            }
            validate_catalog_value(
                effort,
                "Reasoning effort",
                MAX_REASONING_EFFORT_BYTES,
            )?;
            if !reasoning_efforts.iter().any(|existing| existing == effort) {
                reasoning_efforts.push(effort.to_string());
            }
        }
        let default_reasoning_effort = normalize_optional_catalog_value(
            option.default_reasoning_effort,
            "Default reasoning effort",
            MAX_REASONING_EFFORT_BYTES,
        )?;
        if let Some(default_effort) = default_reasoning_effort.as_ref() {
            if !reasoning_efforts.iter().any(|effort| effort == default_effort) {
                reasoning_efforts.push(default_effort.clone());
            }
        }

        normalized.push(AgentModelOption {
            model: model.to_string(),
            label,
            reasoning_efforts,
            default_reasoning_effort,
        });
    }
    Ok(normalized)
}

fn normalize_catalog(mut catalog: AgentModelCatalog) -> AgentModelCatalog {
    catalog.models = normalize_model_options(catalog.models).unwrap_or_default();
    catalog
}

fn normalize_settings(settings: AppSettings) -> AppSettings {
    AppSettings {
        claude_path: resolve_agent_launch_spec_from_path("claude", &settings.claude_path).program,
        codex_path: resolve_agent_launch_spec_from_path("codex", &settings.codex_path).program,
        send_shortcut: normalize_send_shortcut(settings.send_shortcut),
        terminal_shift_enter_newline: settings.terminal_shift_enter_newline,
        claude_force_default_tui: settings.claude_force_default_tui,
        terminal_scrollback: clamp_terminal_scrollback(settings.terminal_scrollback),
        terminal_copy_on_select: settings.terminal_copy_on_select,
        use_sideloaded_conpty: settings.use_sideloaded_conpty,
        claude_model_catalog: normalize_catalog(settings.claude_model_catalog),
        codex_model_catalog: normalize_catalog(settings.codex_model_catalog),
    }
}

fn load_settings_unlocked() -> AppSettings {
    let path = match settings_path() {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };

    if !path.exists() {
        let settings = normalize_settings(AppSettings {
            claude_path: detect_path("claude"),
            codex_path: detect_path("codex"),
            send_shortcut: default_send_shortcut(),
            terminal_shift_enter_newline: default_shift_enter_newline(),
            claude_force_default_tui: default_claude_force_default_tui(),
            terminal_scrollback: default_terminal_scrollback(),
            terminal_copy_on_select: false,
            use_sideloaded_conpty: default_use_sideloaded_conpty(),
            claude_model_catalog: AgentModelCatalog::default(),
            codex_model_catalog: AgentModelCatalog::default(),
        });
        if let Ok(dir) = nezha_dir() {
            let _ = fs::create_dir_all(&dir);
        }
        if let Ok(raw) = serde_json::to_string_pretty(&settings) {
            let _ = atomic_write(&path, &raw);
        }
        return settings;
    }

    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return AppSettings::default(),
    };
    let settings: AppSettings = serde_json::from_str(&raw).unwrap_or_default();
    let normalized = normalize_settings(settings.clone());
    if normalized != settings {
        if let Ok(raw) = serde_json::to_string_pretty(&normalized) {
            let _ = atomic_write(&path, &raw);
        }
    }
    normalized
}

pub fn load_settings_internal() -> AppSettings {
    let _guard = settings_lock().lock();
    load_settings_unlocked()
}

pub fn get_agent_launch_spec(agent: &str) -> AgentLaunchSpec {
    get_agent_launch_spec_from_settings(&load_settings_internal(), agent)
}

#[tauri::command]
pub async fn load_app_settings() -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(load_settings_internal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_app_settings(settings: AppSettings) -> Result<(), String> {
    {
        let _guard = settings_lock().lock();
        let dir = nezha_dir()?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = settings_path()?;
        let normalized = normalize_settings(settings);
        let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
        atomic_write(&path, &raw)?;
    }
    clear_cached_versions();
    crate::hooks::regenerate_claude_settings()?;
    Ok(())
}

#[tauri::command]
pub async fn save_agent_paths(claude_path: String, codex_path: String) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let normalized = {
            let _guard = settings_lock().lock();
            let mut settings = load_settings_unlocked();
            settings.claude_path = claude_path;
            settings.codex_path = codex_path;

            let dir = nezha_dir()?;
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = settings_path()?;
            let normalized = normalize_settings(settings);
            let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
            atomic_write(&path, &raw)?;
            normalized
        };
        clear_cached_versions();
        // 路径变化会改写 claude_version_gte 的判定结果(tui 字段是否写入),需要重新生成
        // Nezha 自有 settings 文件,否则下次启动任务会拿到与新路径版本不匹配的旧文件。
        crate::hooks::regenerate_claude_settings()?;
        Ok::<AppSettings, String>(normalized)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn catalog_mut<'a>(
    settings: &'a mut AppSettings,
    agent: &str,
) -> Result<&'a mut AgentModelCatalog, String> {
    match agent {
        "claude" => Ok(&mut settings.claude_model_catalog),
        "codex" => Ok(&mut settings.codex_model_catalog),
        _ => Err("Unsupported agent. Expected \"claude\" or \"codex\".".to_string()),
    }
}

fn save_settings_unlocked(settings: AppSettings) -> Result<AppSettings, String> {
    let dir = nezha_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = settings_path()?;
    let normalized = normalize_settings(settings);
    let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    atomic_write(&path, &raw)?;
    Ok(normalized)
}

#[tauri::command]
pub async fn save_agent_model_catalog(
    agent: String,
    models: Vec<AgentModelOption>,
) -> Result<AppSettings, String> {
    let models = normalize_model_options(models)?;
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        catalog_mut(&mut settings, &agent)?.models = models;
        save_settings_unlocked(settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_codex_model_option(value: &Value) -> Option<AgentModelOption> {
    let model = value
        .get("model")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)?
        .trim();
    if model.is_empty() {
        return None;
    }

    let label = value
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty() && *label != model)
        .map(str::to_string);
    let reasoning_efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|efforts| {
            efforts
                .iter()
                .filter_map(|effort| {
                    effort
                        .as_str()
                        .or_else(|| effort.get("reasoningEffort").and_then(Value::as_str))
                })
                .map(str::trim)
                .filter(|effort| !effort.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let default_reasoning_effort = value
        .get("defaultReasoningEffort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .map(str::to_string);

    Some(AgentModelOption {
        model: model.to_string(),
        label,
        reasoning_efforts,
        default_reasoning_effort,
    })
}

fn discover_codex_model_options(
    codex_rpc: Arc<Mutex<Option<crate::usage::CodexRpcClient>>>,
) -> Result<Vec<AgentModelOption>, String> {
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;

    for _ in 0..10 {
        let params = match cursor.as_ref() {
            Some(cursor) => json!({ "limit": 100, "cursor": cursor }),
            None => json!({ "limit": 100 }),
        };
        let result = crate::usage::call_codex_rpc_with_client(
            Arc::clone(&codex_rpc),
            "model/list",
            params,
            Duration::from_secs(10),
        )?;
        let page = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "Codex model/list response did not include a data array.".to_string())?;
        models.extend(page.iter().filter_map(parse_codex_model_option));

        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|cursor| !cursor.is_empty())
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }

    normalize_model_options(models)
}

#[tauri::command]
pub async fn initialize_agent_model_catalog(
    agent: String,
    task_manager: State<'_, TaskManager>,
) -> Result<AppSettings, String> {
    if agent != "codex" {
        return Err(
            "Automatic model discovery is not available for this agent; add models manually."
                .to_string(),
        );
    }
    let settings = load_settings_internal();
    if settings.codex_model_catalog.initialized {
        return Ok(settings);
    }

    // 初始化应严格使用刚保存的 Codex 路径；丢弃可能由用量面板基于旧路径启动的实例。
    // 先从锁内 take，再在锁外 drop（Drop 会 kill + wait，不能持锁做进程 I/O）。
    let stale_rpc = task_manager.codex_rpc.lock().take();
    drop(stale_rpc);
    let codex_rpc = Arc::clone(&task_manager.codex_rpc);
    let discovered =
        tokio::task::spawn_blocking(move || discover_codex_model_options(codex_rpc))
            .await
            .map_err(|e| e.to_string())??;
    if discovered.is_empty() {
        return Err("Codex returned no models; the catalog was left unchanged.".to_string());
    }
    let source_version =
        tokio::task::spawn_blocking(detect_codex_version).await.unwrap_or_default();

    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        let catalog = catalog_mut(&mut settings, "codex")?;
        if catalog.initialized {
            return Ok(settings);
        }

        let mut merged = catalog.models.clone();
        for option in discovered {
            if !merged.iter().any(|existing| existing.model == option.model) {
                merged.push(option);
            }
        }
        catalog.models = normalize_model_options(merged)?;
        catalog.initialized = true;
        catalog.initialized_at = Some(chrono::Utc::now().timestamp_millis());
        catalog.source_version = source_version;
        save_settings_unlocked(settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_send_shortcut(send_shortcut: String) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        settings.send_shortcut = normalize_send_shortcut(send_shortcut);

        let dir = nezha_dir()?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = settings_path()?;
        let normalized = normalize_settings(settings);
        let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
        atomic_write(&path, &raw)?;
        Ok::<AppSettings, String>(normalized)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_shift_enter_newline(enabled: bool) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        settings.terminal_shift_enter_newline = enabled;

        let dir = nezha_dir()?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = settings_path()?;
        let normalized = normalize_settings(settings);
        let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
        atomic_write(&path, &raw)?;
        Ok::<AppSettings, String>(normalized)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_terminal_scrollback(scrollback: u32) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        settings.terminal_scrollback = clamp_terminal_scrollback(scrollback);

        let dir = nezha_dir()?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = settings_path()?;
        let normalized = normalize_settings(settings);
        let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
        atomic_write(&path, &raw)?;
        Ok::<AppSettings, String>(normalized)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_terminal_copy_on_select(enabled: bool) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        settings.terminal_copy_on_select = enabled;

        let dir = nezha_dir()?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = settings_path()?;
        let normalized = normalize_settings(settings);
        let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
        atomic_write(&path, &raw)?;
        Ok::<AppSettings, String>(normalized)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_claude_force_default_tui(enabled: bool) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let normalized = {
            let _guard = settings_lock().lock();
            let mut settings = load_settings_unlocked();
            settings.claude_force_default_tui = enabled;

            let dir = nezha_dir()?;
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = settings_path()?;
            let normalized = normalize_settings(settings);
            let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
            atomic_write(&path, &raw)?;
            normalized
        };
        crate::hooks::regenerate_claude_settings()?;
        Ok::<AppSettings, String>(normalized)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 侧载 ConPTY 开关(仅 Windows 有实际效果)。切换后需重启应用才会生效:
/// portable-pty 的 CONPTY 是 lazy_static,进程内首次创建 PTY 后无法再切换实现。
#[tauri::command]
pub async fn save_use_sideloaded_conpty(enabled: bool) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        // 切换视为显式重试:清除 crash-loop 标记(见 platform/windows.rs),
        // 让下次启动重新尝试预加载。非 Windows 上文件不存在,删除是无操作。
        if let Some(marker) = conpty_preload_marker_path() {
            let _ = fs::remove_file(marker);
        }
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        settings.use_sideloaded_conpty = enabled;

        let dir = nezha_dir()?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = settings_path()?;
        let normalized = normalize_settings(settings);
        let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
        atomic_write(&path, &raw)?;
        Ok::<AppSettings, String>(normalized)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取侧载 ConPTY 开关(仅 Windows 预加载后台线程使用,见 platform/windows.rs)。
#[cfg(windows)]
pub(crate) fn use_sideloaded_conpty_enabled() -> bool {
    load_settings_internal().use_sideloaded_conpty
}

#[tauri::command]
pub async fn detect_agent_paths() -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(|| {
        let mut settings = load_settings_internal();
        settings.claude_path = detect_path("claude");
        settings.codex_path = detect_path("codex");
        Ok(normalize_settings(settings))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn detect_version(launch: &AgentLaunchSpec) -> Option<String> {
    let mut cmd = Command::new(&launch.program);
    crate::subprocess::configure_background_command(&mut cmd);
    cmd.arg("--version")
        .env("PATH", get_login_shell_path())
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    for (key, value) in &launch.extra_env {
        cmd.env(key, value);
    }
    let output = cmd.output().ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    text.split_whitespace()
        .find(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|s| s.to_string())
}

fn detect_versions_for_settings(settings: &AppSettings) -> AgentVersions {
    AgentVersions {
        claude_version: detect_version(&get_agent_launch_spec_from_settings(settings, "claude"))
            .unwrap_or_default(),
        codex_version: detect_version(&get_agent_launch_spec_from_settings(settings, "codex"))
            .unwrap_or_default(),
    }
}

fn parse_semver(v: &str) -> (u32, u32, u32) {
    let parts: Vec<&str> = v.split('.').collect();
    (
        parts.first().and_then(|s| s.parse().ok()).unwrap_or(0),
        parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
        parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
    )
}

pub fn detect_claude_version() -> Option<String> {
    let cache = CACHED_CLAUDE_VERSION.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock();
    if let Some(version) = guard.clone() {
        return version;
    }

    let detected = detect_version(&get_agent_launch_spec("claude"));
    *guard = Some(detected.clone());
    detected
}

pub fn detect_codex_version() -> Option<String> {
    let cache = CACHED_CODEX_VERSION.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock();
    if let Some(version) = guard.clone() {
        return version;
    }

    let detected = detect_version(&get_agent_launch_spec("codex"));
    *guard = Some(detected.clone());
    detected
}

/// 版本号统一走全局带缓存的探测；探测失败视为不满足。
pub fn claude_version_gte(min_version: &str) -> bool {
    match detect_claude_version() {
        Some(v) => parse_semver(&v) >= parse_semver(min_version),
        None => false,
    }
}

/// 版本号统一走全局带缓存的探测；探测失败视为不满足。
pub fn codex_version_gte(min_version: &str) -> bool {
    match detect_codex_version() {
        Some(v) => parse_semver(&v) >= parse_semver(min_version),
        None => false,
    }
}

#[tauri::command]
pub async fn detect_agent_versions_for_settings(settings: AppSettings) -> Result<AgentVersions, String> {
    tokio::task::spawn_blocking(move || detect_versions_for_settings(&settings))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AgentVersions {
    pub claude_version: String,
    pub codex_version: String,
}

static SYSTEM_FONTS: OnceLock<Vec<String>> = OnceLock::new();

#[tauri::command]
pub async fn get_system_fonts() -> Vec<String> {
    tokio::task::spawn_blocking(|| {
        SYSTEM_FONTS
            .get_or_init(|| {
                let source = font_kit::source::SystemSource::new();
                match source.all_families() {
                    Ok(mut families) => {
                        families.sort();
                        families
                    }
                    Err(_) => Vec::new(),
                }
            })
            .clone()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod model_catalog_tests {
    use super::*;

    #[test]
    fn parses_codex_model_list_metadata() {
        let value = json!({
            "model": "gpt-example",
            "displayName": "GPT Example",
            "supportedReasoningEfforts": [
                { "reasoningEffort": "low", "description": "Fast" },
                { "reasoningEffort": "high", "description": "Deep" }
            ],
            "defaultReasoningEffort": "high"
        });

        let parsed = parse_codex_model_option(&value).expect("model should parse");
        assert_eq!(parsed.model, "gpt-example");
        assert_eq!(parsed.label.as_deref(), Some("GPT Example"));
        assert_eq!(parsed.reasoning_efforts, vec!["low", "high"]);
        assert_eq!(parsed.default_reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn accepts_provider_specific_model_identifiers() {
        let normalized = normalize_model_options(vec![AgentModelOption {
            model: "arn:aws:bedrock:region:account:inference-profile/custom/model".to_string(),
            label: Some("  Production  ".to_string()),
            reasoning_efforts: vec!["low".to_string(), "high".to_string()],
            default_reasoning_effort: None,
        }])
        .expect("provider model should be accepted");

        assert_eq!(
            normalized[0].model,
            "arn:aws:bedrock:region:account:inference-profile/custom/model"
        );
        assert_eq!(normalized[0].label.as_deref(), Some("Production"));
    }

    #[test]
    fn rejects_duplicate_models_and_control_characters() {
        let duplicate = AgentModelOption {
            model: "same".to_string(),
            label: None,
            reasoning_efforts: vec![],
            default_reasoning_effort: None,
        };
        assert!(normalize_model_options(vec![duplicate.clone(), duplicate]).is_err());
        assert!(normalize_model_options(vec![AgentModelOption {
            model: "bad\nmodel".to_string(),
            label: None,
            reasoning_efforts: vec![],
            default_reasoning_effort: None,
        }])
        .is_err());
    }
}
