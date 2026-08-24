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

fn default_dsh_profile() -> String {
    "cc-tui".to_string()
}

fn default_terminal_scrollback() -> u32 {
    1000
}

fn default_use_sideloaded_conpty() -> bool {
    true
}

fn default_system_notifications() -> bool {
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
/// Codex 模型目录自动同步的过期阈值：超过该时长后打开设置页/启动时自动重同步。
const CODEX_MODEL_SYNC_TTL_MS: i64 = 6 * 60 * 60 * 1000;

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
    /// 模型来源：None = 手动添加；Some("file") = 由 codex models 配置文件同步；
    /// Some("rpc") = 由 codex model/list 同步。用于同步时「替换旧同步结果、保留手动项」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
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

/// 云效 (Aliyun DevOps / Projex) 集成配置，随应用级设置存放在 ~/.nezha/settings.json。
/// token 是用户个人访问令牌：仅存本地用户目录，禁止硬编码进代码或提交仓库。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct YunxiaoSettings {
    #[serde(default)]
    pub token: String,
    #[serde(rename = "organizationId", default)]
    pub organization_id: String,
    #[serde(
        rename = "organizationName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub organization_name: Option<String>,
    #[serde(rename = "projectId", default)]
    pub project_id: String,
    #[serde(rename = "projectName", default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(
        rename = "currentUserId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub current_user_id: Option<String>,
    #[serde(
        rename = "currentUserName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub current_user_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AppSettings {
    #[serde(default)]
    pub claude_path: String,
    #[serde(default)]
    pub codex_path: String,
    #[serde(default)]
    pub dsh_path: String,
    #[serde(default = "default_dsh_profile")]
    pub dsh_profile: String,
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
    /// Agent 需要确认或任务完成/失败时发送 OS 级系统通知（窗口未聚焦时）。
    #[serde(default = "default_system_notifications")]
    pub system_notifications: bool,
    /// 轻量 AI 辅助调用（任务命名 / 议题预填 / 汇总 / 知识沉淀 / commit message）
    /// 使用的模型；None = 跟随 Agent 默认（不传 --model）。
    #[serde(default)]
    pub claude_light_model: Option<String>,
    #[serde(default)]
    pub codex_light_model: Option<String>,
    /// 轻量 AI 辅助调用的思考深度；None = 跟随模型默认（不传 effort）。
    #[serde(default)]
    pub claude_light_reasoning_effort: Option<String>,
    #[serde(default)]
    pub codex_light_reasoning_effort: Option<String>,
    #[serde(default)]
    pub claude_model_catalog: AgentModelCatalog,
    #[serde(default)]
    pub codex_model_catalog: AgentModelCatalog,
    #[serde(default)]
    pub yunxiao: YunxiaoSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            claude_path: String::new(),
            codex_path: String::new(),
            dsh_path: String::new(),
            dsh_profile: default_dsh_profile(),
            send_shortcut: default_send_shortcut(),
            terminal_shift_enter_newline: default_shift_enter_newline(),
            claude_force_default_tui: default_claude_force_default_tui(),
            terminal_scrollback: default_terminal_scrollback(),
            terminal_copy_on_select: false,
            use_sideloaded_conpty: default_use_sideloaded_conpty(),
            system_notifications: default_system_notifications(),
            claude_light_model: None,
            codex_light_model: None,
            claude_light_reasoning_effort: None,
            codex_light_reasoning_effort: None,
            claude_model_catalog: AgentModelCatalog::default(),
            codex_model_catalog: AgentModelCatalog::default(),
            yunxiao: YunxiaoSettings::default(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AgentLaunchSpec {
    pub program: String,
    pub extra_env: Vec<(String, String)>,
}

/// 轻量 AI 辅助调用的模型配置（来自应用级设置，按 agent 区分）。
#[derive(Clone, Debug, Default)]
pub struct LightModelConfig {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
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
        "dsh" => {
            if settings.dsh_path.is_empty() {
                "dsh".to_string()
            } else {
                settings.dsh_path.clone()
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

pub(crate) fn get_agent_launch_spec_from_settings(
    settings: &AppSettings,
    agent: &str,
) -> AgentLaunchSpec {
    resolve_agent_launch_spec_from_path(agent, &get_agent_configured_path(settings, agent))
}

/// 从设置中读取指定 agent 的轻量 AI 辅助调用模型配置（无配置时为默认空值）。
pub fn get_light_model_config_from_settings(
    settings: &AppSettings,
    agent: &str,
) -> LightModelConfig {
    match agent {
        "codex" => LightModelConfig {
            model: settings.codex_light_model.clone(),
            reasoning_effort: settings.codex_light_reasoning_effort.clone(),
        },
        _ => LightModelConfig {
            model: settings.claude_light_model.clone(),
            reasoning_effort: settings.claude_light_reasoning_effort.clone(),
        },
    }
}

/// 一次性读取 agent 启动规格与轻量模型配置（共享一次设置文件读取）。
pub fn get_agent_launch_and_light_model(agent: &str) -> (AgentLaunchSpec, LightModelConfig) {
    let settings = load_settings_internal();
    (
        get_agent_launch_spec_from_settings(&settings, agent),
        get_light_model_config_from_settings(&settings, agent),
    )
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
        let source = normalize_optional_catalog_value(option.source, "Model source", 16)?;

        normalized.push(AgentModelOption {
            model: model.to_string(),
            label,
            reasoning_efforts,
            default_reasoning_effort,
            source,
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
        dsh_path: resolve_agent_launch_spec_from_path("dsh", &settings.dsh_path).program,
        dsh_profile: if settings.dsh_profile.trim().is_empty() {
            default_dsh_profile()
        } else {
            settings.dsh_profile
        },
        send_shortcut: normalize_send_shortcut(settings.send_shortcut),
        terminal_shift_enter_newline: settings.terminal_shift_enter_newline,
        claude_force_default_tui: settings.claude_force_default_tui,
        terminal_scrollback: clamp_terminal_scrollback(settings.terminal_scrollback),
        terminal_copy_on_select: settings.terminal_copy_on_select,
        use_sideloaded_conpty: settings.use_sideloaded_conpty,
        system_notifications: settings.system_notifications,
        claude_light_model: normalize_optional_catalog_value(
            settings.claude_light_model,
            "Claude light model",
            MAX_MODEL_ID_BYTES,
        )
        .unwrap_or_default(),
        codex_light_model: normalize_optional_catalog_value(
            settings.codex_light_model,
            "Codex light model",
            MAX_MODEL_ID_BYTES,
        )
        .unwrap_or_default(),
        claude_light_reasoning_effort: normalize_optional_catalog_value(
            settings.claude_light_reasoning_effort,
            "Claude light reasoning effort",
            MAX_REASONING_EFFORT_BYTES,
        )
        .unwrap_or_default(),
        codex_light_reasoning_effort: normalize_optional_catalog_value(
            settings.codex_light_reasoning_effort,
            "Codex light reasoning effort",
            MAX_REASONING_EFFORT_BYTES,
        )
        .unwrap_or_default(),
        claude_model_catalog: normalize_catalog(settings.claude_model_catalog),
        codex_model_catalog: normalize_catalog(settings.codex_model_catalog),
        yunxiao: settings.yunxiao,
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
            dsh_path: detect_path("dsh"),
            dsh_profile: default_dsh_profile(),
            send_shortcut: default_send_shortcut(),
            terminal_shift_enter_newline: default_shift_enter_newline(),
            claude_force_default_tui: default_claude_force_default_tui(),
            terminal_scrollback: default_terminal_scrollback(),
            terminal_copy_on_select: false,
            use_sideloaded_conpty: default_use_sideloaded_conpty(),
            system_notifications: default_system_notifications(),
            claude_light_model: None,
            codex_light_model: None,
            claude_light_reasoning_effort: None,
            codex_light_reasoning_effort: None,
            claude_model_catalog: AgentModelCatalog::default(),
            codex_model_catalog: AgentModelCatalog::default(),
            yunxiao: YunxiaoSettings::default(),
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

#[tauri::command]
pub async fn save_dsh_settings(dsh_path: String, dsh_profile: String) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        settings.dsh_path = dsh_path;
        settings.dsh_profile = dsh_profile;

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

/// 保存指定 agent 的轻量 AI 辅助调用模型配置（模型 + 思考深度，均可为空）。
#[tauri::command]
pub async fn save_light_model_config(
    agent: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<AppSettings, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {}", agent));
    }
    let model = normalize_optional_catalog_value(model, "Light model", MAX_MODEL_ID_BYTES)?;
    let reasoning_effort = normalize_optional_catalog_value(
        reasoning_effort,
        "Light reasoning effort",
        MAX_REASONING_EFFORT_BYTES,
    )?;
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        match agent.as_str() {
            "claude" => {
                settings.claude_light_model = model;
                settings.claude_light_reasoning_effort = reasoning_effort;
            }
            _ => {
                settings.codex_light_model = model;
                settings.codex_light_reasoning_effort = reasoning_effort;
            }
        }
        save_settings_unlocked(settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保存云效连接配置（令牌、组织、项目）。仅写入本地设置，不经过任何日志。
#[tauri::command]
pub async fn save_yunxiao_settings(
    token: String,
    organization_id: String,
    organization_name: Option<String>,
    project_id: String,
    project_name: Option<String>,
    current_user_id: Option<String>,
    current_user_name: Option<String>,
) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        settings.yunxiao = YunxiaoSettings {
            token: token.trim().to_string(),
            organization_id: organization_id.trim().to_string(),
            organization_name: organization_name
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            project_id: project_id.trim().to_string(),
            project_name: project_name
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            current_user_id: current_user_id
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            current_user_name: current_user_name
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        };
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
        source: Some("rpc".to_string()),
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

/// 解析 codex models 配置文件（model_catalog_json 指向的 JSON）中的单条模型。
/// 兼容 slug / model / id、display_name / displayName、
/// supported_reasoning_levels[].effort / supportedReasoningEfforts[]、
/// default_reasoning_level / defaultReasoningEffort 等字段命名差异。
fn parse_catalog_file_model(value: &Value) -> Option<AgentModelOption> {
    let model = value
        .get("slug")
        .or_else(|| value.get("model"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)?
        .trim();
    if model.is_empty() {
        return None;
    }

    let label = value
        .get("display_name")
        .or_else(|| value.get("displayName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty() && *label != model)
        .map(str::to_string);

    let reasoning_efforts = value
        .get("supported_reasoning_levels")
        .or_else(|| value.get("supportedReasoningEfforts"))
        .and_then(Value::as_array)
        .map(|efforts| {
            efforts
                .iter()
                .filter_map(|effort| {
                    effort
                        .as_str()
                        .or_else(|| effort.get("effort").and_then(Value::as_str))
                        .or_else(|| effort.get("reasoningEffort").and_then(Value::as_str))
                })
                .map(str::trim)
                .filter(|effort| !effort.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let default_reasoning_effort = value
        .get("default_reasoning_level")
        .or_else(|| value.get("defaultReasoningEffort"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .map(str::to_string);

    Some(AgentModelOption {
        model: model.to_string(),
        label,
        reasoning_efforts,
        default_reasoning_effort,
        source: Some("file".to_string()),
    })
}

/// 从 codex models 配置文件读取模型列表。
/// 路径优先取 ~/.codex/config.toml 的 model_catalog_json，缺省回退 ~/.codex/models.json。
/// 文件不存在或解析不出模型时返回 Ok(None)，由调用方回退到 RPC。
fn discover_codex_models_from_catalog_file() -> Result<Option<Vec<AgentModelOption>>, String> {
    let home = crate::platform::home_dir()
        .ok_or_else(|| "Cannot find home directory".to_string())?;
    let config_path = home.join(".codex").join("config.toml");
    let catalog_path = if config_path.exists() {
        let raw = fs::read_to_string(&config_path)
            .map_err(|e| format!("Cannot read ~/.codex/config.toml: {}", e))?;
        toml::from_str::<toml::Value>(&raw)
            .ok()
            .and_then(|value| {
                value
                    .get("model_catalog_json")
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(str::to_string)
            })
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex").join("models.json"))
    } else {
        home.join(".codex").join("models.json")
    };

    if !catalog_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&catalog_path).map_err(|e| {
        format!(
            "Cannot read codex model catalog {}: {}",
            catalog_path.display(),
            e
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "Cannot parse codex model catalog {}: {}",
            catalog_path.display(),
            e
        )
    })?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Codex model catalog {} has no models array.", catalog_path.display()))?;
    let options: Vec<AgentModelOption> = models.iter().filter_map(parse_catalog_file_model).collect();
    if options.is_empty() {
        return Ok(None);
    }
    Ok(Some(normalize_model_options(options)?))
}

/// 合并同步结果与现有目录：替换上一次的同步项，保留手动添加（source=None）
/// 且未被本次同步覆盖的模型。
fn merge_synced_models(
    discovered: Vec<AgentModelOption>,
    existing: &[AgentModelOption],
) -> Vec<AgentModelOption> {
    let synced_ids: Vec<String> = discovered.iter().map(|m| m.model.clone()).collect();
    let mut merged = discovered;
    for existing in existing.iter().cloned() {
        if existing.source.is_none() && !synced_ids.iter().any(|id| *id == existing.model) {
            merged.push(existing);
        }
    }
    merged
}

#[tauri::command]
pub async fn refresh_agent_model_catalog(
    agent: String,
    task_manager: State<'_, TaskManager>,
) -> Result<AppSettings, String> {
    if agent != "codex" {
        return Err(
            "Automatic model discovery is not available for this agent; add models manually."
                .to_string(),
        );
    }

    let file_models = tokio::task::spawn_blocking(discover_codex_models_from_catalog_file)
        .await
        .map_err(|e| e.to_string())?;
    let (discovered, _source) = match file_models {
        Ok(Some(models)) => (models, "file"),
        _ => {
            // 初始化应严格使用刚保存的 Codex 路径；丢弃可能由用量面板基于旧路径启动的实例。
            // 先从锁内 take，再在锁外 drop（Drop 会 kill + wait，不能持锁做进程 I/O）。
            let stale_rpc = task_manager.codex_rpc.lock().take();
            drop(stale_rpc);
            let codex_rpc = Arc::clone(&task_manager.codex_rpc);
            let models =
                tokio::task::spawn_blocking(move || discover_codex_model_options(codex_rpc))
                    .await
                    .map_err(|e| e.to_string())??;
            (models, "rpc")
        }
    };
    if discovered.is_empty() {
        return Err("Codex returned no models; the catalog was left unchanged.".to_string());
    }
    let source_version =
        tokio::task::spawn_blocking(detect_codex_version).await.unwrap_or_default();

    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        let catalog = catalog_mut(&mut settings, "codex")?;
        catalog.models = normalize_model_options(merge_synced_models(
            discovered,
            &catalog.models,
        ))?;
        catalog.initialized = true;
        catalog.initialized_at = Some(chrono::Utc::now().timestamp_millis());
        catalog.source_version = source_version;
        save_settings_unlocked(settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 应用启动后台调用：仅当存在 codex models 配置文件且目录未初始化/过期时，
/// 只读文件做一次轻量同步（不 spawn codex 进程）。失败静默，设置页可重试。
pub fn sync_codex_catalog_from_file_if_due() {
    let Ok(Some(models)) = discover_codex_models_from_catalog_file() else {
        return;
    };
    let _guard = settings_lock().lock();
    let mut settings = load_settings_unlocked();
    let Ok(catalog) = catalog_mut(&mut settings, "codex") else {
        return;
    };
    let due = if catalog.initialized {
        match catalog.initialized_at {
            Some(at) => chrono::Utc::now().timestamp_millis() - at > CODEX_MODEL_SYNC_TTL_MS,
            None => false,
        }
    } else {
        true
    };
    if !due {
        return;
    }
    if let Ok(merged) = normalize_model_options(merge_synced_models(models, &catalog.models)) {
        catalog.models = merged;
        catalog.initialized = true;
        catalog.initialized_at = Some(chrono::Utc::now().timestamp_millis());
        let _ = save_settings_unlocked(settings);
    }
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
pub async fn save_system_notifications(enabled: bool) -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = settings_lock().lock();
        let mut settings = load_settings_unlocked();
        settings.system_notifications = enabled;

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
        settings.dsh_path = detect_path("dsh");
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
            source: None,
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
            source: None,
        };
        assert!(normalize_model_options(vec![duplicate.clone(), duplicate]).is_err());
        assert!(normalize_model_options(vec![AgentModelOption {
            model: "bad\nmodel".to_string(),
            label: None,
            reasoning_efforts: vec![],
            default_reasoning_effort: None,
            source: None,
        }])
        .is_err());
    }

    #[test]
    fn light_model_config_maps_agent_fields() {
        let mut settings = AppSettings::default();
        settings.claude_light_model = Some("fast-claude".into());
        settings.claude_light_reasoning_effort = Some("low".into());
        settings.codex_light_model = Some("fast-codex".into());
        settings.codex_light_reasoning_effort = Some("high".into());

        let claude = get_light_model_config_from_settings(&settings, "claude");
        assert_eq!(claude.model.as_deref(), Some("fast-claude"));
        assert_eq!(claude.reasoning_effort.as_deref(), Some("low"));

        let codex = get_light_model_config_from_settings(&settings, "codex");
        assert_eq!(codex.model.as_deref(), Some("fast-codex"));
        assert_eq!(codex.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn light_model_config_defaults_to_claude_for_unknown_agents() {
        let mut settings = AppSettings::default();
        settings.claude_light_model = Some("fast-claude".into());
        let config = get_light_model_config_from_settings(&settings, "dsh");
        assert_eq!(config.model.as_deref(), Some("fast-claude"));
        assert_eq!(config.reasoning_effort, None);
    }

    #[test]
    fn normalize_settings_trims_light_model_values_and_rejects_control_chars() {
        let settings = AppSettings {
            claude_light_model: Some("  fast-model  ".into()),
            codex_light_reasoning_effort: Some("  low  ".into()),
            claude_light_reasoning_effort: Some("bad\ncontrol".into()),
            ..AppSettings::default()
        };
        let normalized = normalize_settings(settings);
        assert_eq!(normalized.claude_light_model.as_deref(), Some("fast-model"));
        assert_eq!(
            normalized.codex_light_reasoning_effort.as_deref(),
            Some("low")
        );
        // 控制字符在加载兜底时被丢弃为 None（保存命令才会返回 Err）
        assert_eq!(normalized.claude_light_reasoning_effort, None);
    }

    #[test]
    fn parses_catalog_file_model_with_snake_case_fields() {
        let value = json!({
            "slug": "Kimi-K3",
            "display_name": "Kimi-K3",
            "default_reasoning_level": "high",
            "supported_reasoning_levels": [
                { "effort": "low", "description": "Fast" },
                { "effort": "high", "description": "Deep" }
            ]
        });

        let parsed = parse_catalog_file_model(&value).expect("file model should parse");
        assert_eq!(parsed.model, "Kimi-K3");
        assert_eq!(parsed.source.as_deref(), Some("file"));
        assert_eq!(parsed.reasoning_efforts, vec!["low", "high"]);
        assert_eq!(parsed.default_reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn parses_catalog_file_model_with_camel_case_fallback() {
        let value = json!({
            "model": "gpt-x",
            "displayName": "GPT X",
            "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": ["low", "medium"]
        });

        let parsed = parse_catalog_file_model(&value).expect("file model should parse");
        assert_eq!(parsed.model, "gpt-x");
        assert_eq!(parsed.source.as_deref(), Some("file"));
        assert_eq!(parsed.reasoning_efforts, vec!["low", "medium"]);
        assert_eq!(parsed.default_reasoning_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn sync_merge_replaces_synced_models_and_keeps_manual_ones() {
        let synced = vec![
            AgentModelOption {
                model: "Kimi-K3".into(),
                label: None,
                reasoning_efforts: vec!["low".into(), "high".into()],
                default_reasoning_effort: Some("high".into()),
                source: Some("file".into()),
            },
            AgentModelOption {
                model: "new-model".into(),
                label: None,
                reasoning_efforts: vec![],
                default_reasoning_effort: None,
                source: Some("file".into()),
            },
        ];
        let existing = vec![
            // 上一次同步进来的模型：本次已从配置文件移除，应被替换掉
            AgentModelOption {
                model: "removed-model".into(),
                label: None,
                reasoning_efforts: vec![],
                default_reasoning_effort: None,
                source: Some("file".into()),
            },
            // 手动添加的模型：应保留
            AgentModelOption {
                model: "manual-model".into(),
                label: Some("Manual".into()),
                reasoning_efforts: vec![],
                default_reasoning_effort: None,
                source: None,
            },
        ];

        let merged = merge_synced_models(synced, &existing);
        let ids: Vec<&str> = merged.iter().map(|m| m.model.as_str()).collect();
        assert_eq!(ids, vec!["Kimi-K3", "new-model", "manual-model"]);
        assert!(!ids.contains(&"removed-model"));
    }
}
