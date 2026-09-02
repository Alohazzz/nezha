use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::Watcher;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::storage::{
    atomic_write, ensure_nezha_dirs, load_projects, nezha_dir, save_projects, Project,
};

// ── Data types ───────────────────────────────────────────────────────────────

/// 技能仓库来源：`path` = 本地目录；`git` = git 远端（URL + 可选分支）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    /// 序列化为 `sourceType`（前端契约）；兼容反序列化旧配置的 `type` 字段。
    #[serde(alias = "type")]
    pub source_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHubConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub_project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// 技能仓库来源；旧配置缺省时等价于 `type: "path"`（仅 hub_path）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SkillSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// SKILL 目录名（权威标识）
    pub name: String,
    /// frontmatter 的 name 字段，可与目录名不同
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// 解析后的 description（保留换行）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// skill 目录绝对路径
    pub path: String,
    /// frontmatter `scope`：universal = 用户级（所有项目可见）；project = 项目级（装到指定项目）。
    /// 缺省 universal。
    pub scope: String,
    /// frontmatter `project`：项目技能的目标项目标识（名称/路径关键词），用于安装预选与数据目录归属。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// frontmatter `build-command`：重建技能数据的命令（相对技能目录解析，如 `python scripts/bootstrap.py`），
    /// 由 Nezha 以数据目录为 cwd、注入 NEZHA_PROJECT_ROOT / NEZHA_SKILL_DATA_DIR 后执行。
    #[serde(rename = "buildCommand", skip_serializing_if = "Option::is_none")]
    pub build_command: Option<String>,
    /// frontmatter 解析失败时的错误描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallation {
    pub skill_name: String,
    /// 安装目标项目；universal 安装为空串
    pub project_id: String,
    pub agent: String,
    /// "universal" | "project"；旧记录缺省空串按 project 处理
    #[serde(default)]
    pub scope: String,
    /// 项目技能的数据目录（`<项目>/.nezha/skill-data/<技能名>/`）；universal 安装为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_path: Option<String>,
    pub installed_at: i64,
    pub link_path: String,
    pub target_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<String>, // "ok" | "broken" | "diverged"
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct InstallationsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    installations: Vec<SkillInstallation>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetHubResult {
    pub config: SkillHubConfig,
    pub project: Project,
    pub created_new_project: bool,
    /// 后端写入后的完整 projects 列表；前端用它替换 React state，避免竞态覆盖。
    pub projects: Vec<Project>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    /// "directory" | "file" | "symlink"
    pub existing_kind: String,
    /// 当现有路径是 symlink 时，这里是它指向的目标
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_target: Option<String>,
    pub link_path: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictInfo>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub already_installed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation: Option<SkillInstallation>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub ok: bool,
    pub removed_links: usize,
}

// ── Path helpers ─────────────────────────────────────────────────────────────

fn skill_hub_path() -> Result<PathBuf, String> {
    Ok(nezha_dir()?.join("skill_hub.json"))
}

fn installations_path() -> Result<PathBuf, String> {
    Ok(nezha_dir()?.join("skill_installations.json"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn agent_skills_dir(project_path: &Path, agent: &str) -> PathBuf {
    let sub = match agent {
        "codex" => ".codex/skills",
        _ => ".claude/skills",
    };
    project_path.join(sub)
}

/// 用户级 agent 技能目录（所有项目可见）。
fn user_agent_skills_dir(agent: &str) -> PathBuf {
    let sub = match agent {
        "codex" => ".codex/skills",
        _ => ".claude/skills",
    };
    crate::platform::home_dir()
        .map(|home| home.join(sub))
        .unwrap_or_else(|| PathBuf::from(sub))
}

/// 技能数据目录：跟随技能本身，位于技能目录内 `data/`（随技能仓库 git 统一管理）。
fn skill_data_dir(skill_dir: &Path) -> PathBuf {
    skill_dir.join("data")
}

/// 技能数据本地备份根目录（不入技能仓库 git）：`~/.nezha/skill-backups/<技能名>/`
fn skill_backup_root(skill_name: &str) -> Result<PathBuf, String> {
    Ok(nezha_dir()?.join("skill-backups").join(skill_name))
}

/// 从技能目录向上找 git 仓库根（技能仓库）。
fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

/// skill_name 必须是单段合法目录名：非空、非 `.` / `..`、不含路径分隔符。
/// 该名字会作为 `agent_skills_dir(...).join(&skill_name)` 的最后一段，必须严格限定。
fn validate_skill_name(skill_name: &str) -> Result<(), String> {
    if skill_name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }
    if skill_name == "." || skill_name == ".." {
        return Err(format!("Invalid skill name: {}", skill_name));
    }
    if skill_name.contains('/') || skill_name.contains('\\') || skill_name.contains('\0') {
        return Err(format!(
            "Skill name must not contain path separators: {}",
            skill_name
        ));
    }
    Ok(())
}

fn target_health(target: &Path) -> &'static str {
    if target.exists() {
        "ok"
    } else {
        "broken"
    }
}

// ── Hub config I/O ───────────────────────────────────────────────────────────

fn load_hub_config_internal() -> SkillHubConfig {
    let Ok(path) = skill_hub_path() else {
        return SkillHubConfig::default();
    };
    if !path.exists() {
        return SkillHubConfig::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SkillHubConfig>(&raw).ok())
        .unwrap_or_default()
}

/// 当前配置的技能库路径（供 agent_assist 读取技能内容，如 knowledge-sedimentation）。
pub(crate) fn configured_hub_path() -> Option<String> {
    load_hub_config_internal().hub_path
}

fn save_hub_config_internal(config: &SkillHubConfig) -> Result<(), String> {
    ensure_nezha_dirs()?;
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    atomic_write(&skill_hub_path()?, &raw)
}

fn load_installations_internal() -> InstallationsFile {
    let Ok(path) = installations_path() else {
        return InstallationsFile::default();
    };
    if !path.exists() {
        return InstallationsFile::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<InstallationsFile>(&raw).ok())
        .unwrap_or_default()
}

fn save_installations_internal(file: &InstallationsFile) -> Result<(), String> {
    ensure_nezha_dirs()?;
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    atomic_write(&installations_path()?, &raw)
}

// ── SKILL.md frontmatter parsing ─────────────────────────────────────────────
// 手写解析器，只关心 frontmatter 顶层 `name` 和 `description`。
// 支持：单行（含引号）、literal block (`|`、`|-`、`|+`)、folded (`>`、`>-`、`>+`)。

fn strip_yaml_quotes(s: &str) -> String {
    let trimmed = s.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if first == last && (first == b'"' || first == b'\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// 解析 YAML literal block scalar 的多行内容。
/// `lines` 是块下方的全部候选行；返回 (拼接后的内容, 消耗的行数)。
fn parse_block_scalar(lines: &[&str], folded: bool) -> (String, usize) {
    // 确定基准缩进（第一个非空行的前导空格数）
    let mut base_indent: Option<usize> = None;
    let mut consumed = 0usize;
    let mut collected: Vec<String> = Vec::new();

    for line in lines {
        // 空行：始终归属当前块
        if line.trim().is_empty() {
            collected.push(String::new());
            consumed += 1;
            continue;
        }
        let leading = line.chars().take_while(|c| *c == ' ').count();
        // 顶层 key 一定从第 0 列开始；只要后续行没缩进就视为块结束
        if leading == 0 {
            break;
        }
        let base = *base_indent.get_or_insert(leading);
        if leading < base {
            break;
        }
        collected.push(line[base..].to_string());
        consumed += 1;
    }

    // 去掉块末尾的空行（默认 clip 行为）
    while collected.last().map(|s| s.is_empty()).unwrap_or(false) {
        collected.pop();
    }

    let joined = if folded {
        fold_lines(&collected)
    } else {
        collected.join("\n")
    };
    (joined, consumed)
}

/// YAML folded scalar 规则：
/// - 相邻非空行用空格连接
/// - 单个空行变成一个换行
/// - 多个连续空行 → n-1 个换行
fn fold_lines(lines: &[String]) -> String {
    let mut out = String::new();
    let mut prev_blank = false;
    let mut first = true;
    for line in lines {
        if line.is_empty() {
            if first {
                first = false;
                prev_blank = true;
                continue;
            }
            out.push('\n');
            prev_blank = true;
            continue;
        }
        if !first && !prev_blank {
            out.push(' ');
        }
        out.push_str(line);
        first = false;
        prev_blank = false;
    }
    out
}

#[derive(Default)]
struct ParsedFrontmatter {
    name: Option<String>,
    description: Option<String>,
    scope: Option<String>,
    project: Option<String>,
    build_command: Option<String>,
}

fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() || lines[0].trim() != "---" {
        return ParsedFrontmatter::default();
    }

    // 定位 frontmatter 结束 `---`
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim() == "---" {
            end = i;
            break;
        }
    }
    let fm = &lines[1..end];

    let mut parsed = ParsedFrontmatter::default();
    let mut i = 0;
    while i < fm.len() {
        let line = fm[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        // 顶层 key 必须从第 0 列开始
        if line.starts_with(|c: char| c.is_whitespace()) {
            i += 1;
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            i += 1;
            continue;
        };
        let key = key.trim();
        let value_part = rest.trim();

        // 检测 block scalar 引导符
        let block_marker = value_part.chars().next().filter(|c| *c == '|' || *c == '>');

        if let Some(marker) = block_marker {
            // 跳过 chomping 修饰符 `-` / `+`，本实现统一按 clip 行为
            let folded = marker == '>';
            let (value, consumed) = parse_block_scalar(&fm[i + 1..], folded);
            match key {
                "name" => parsed.name = Some(value),
                "description" => parsed.description = Some(value),
                "scope" => parsed.scope = Some(value),
                "project" => parsed.project = Some(value),
                "build-command" => parsed.build_command = Some(value),
                _ => {}
            }
            i += 1 + consumed;
        } else {
            let value = strip_yaml_quotes(value_part);
            match key {
                "name" => parsed.name = Some(value),
                "description" => parsed.description = Some(value),
                "scope" => parsed.scope = Some(value),
                "project" => parsed.project = Some(value),
                "build-command" => parsed.build_command = Some(value),
                _ => {}
            }
            i += 1;
        }
    }

    parsed
}

// ── Skill scanning ───────────────────────────────────────────────────────────

fn parse_skill_entry(dir_path: &Path, name: &str) -> Skill {
    let skill_md = dir_path.join("SKILL.md");
    let (display_name, description, scope, project, build_command, has_error) =
        match fs::read_to_string(&skill_md) {
            Ok(content) => {
                let parsed = parse_frontmatter(&content);
                (
                    parsed.name,
                    parsed.description,
                    parsed.scope,
                    parsed.project,
                    parsed.build_command,
                    None,
                )
            }
            Err(e) => (
                None,
                None,
                None,
                None,
                None,
                Some(format!("Failed to read SKILL.md: {}", e)),
            ),
        };
    Skill {
        name: name.to_string(),
        display_name,
        description,
        path: dir_path.to_string_lossy().into_owned(),
        scope: if scope.as_deref() == Some("project") {
            "project".to_string()
        } else {
            "universal".to_string()
        },
        project,
        build_command,
        has_error,
    }
}

/// 递归扫描目录：含 SKILL.md 的目录视为 skill，否则继续向下遍历子目录。
/// 限制深度以及拒绝 symlink 子目录，避免被恶意/意外构造的循环 symlink 撑爆栈。
const MAX_SCAN_DEPTH: usize = 6;

fn collect_skills(dir: &Path, skills: &mut Vec<Skill>, depth: usize) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // 用 symlink_metadata 避免 follow symlink（防止循环 symlink 爆栈）
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) if !n.starts_with('.') => n.to_string(),
            _ => continue,
        };
        if path.join("SKILL.md").is_file() {
            skills.push(parse_skill_entry(&path, &name));
        } else {
            collect_skills(&path, skills, depth + 1);
        }
    }
}

fn scan_skills_in(hub_path: &Path) -> Vec<Skill> {
    let mut skills: Vec<Skill> = Vec::new();
    collect_skills(hub_path, &mut skills, 0);
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    skills
}

// ── Symlink helpers ──────────────────────────────────────────────────────────

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    match std::os::windows::fs::symlink_dir(target, link) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            // os error 1314：创建符号链接需要「开发者模式/管理员」特权。
            // 回退到目录联接（junction，`mklink /J`）——无需特权、跨卷可用，
            // 且对 agent/健康检查/卸载与软链行为一致（is_symlink=true、read_link 可解析）。
            create_junction(target, link)
        }
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn create_junction(target: &Path, link: &Path) -> std::io::Result<()> {
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .map_err(|e| std::io::Error::new(e.kind(), format!("启动 mklink 失败: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "mklink /J 创建目录联接失败（请开启开发者模式或以管理员运行，或检查目标卷是否支持联接）",
        ))
    }
}

fn classify_existing(path: &Path) -> Option<(String, Option<String>)> {
    let meta = fs::symlink_metadata(path).ok()?;
    let kind = if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "directory"
    } else {
        "file"
    };
    let target = if meta.file_type().is_symlink() {
        fs::read_link(path)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };
    Some((kind.to_string(), target))
}

/// 删除已存在的 link_path（symlink / 普通目录 / 文件均支持）
fn remove_existing(path: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if meta.file_type().is_symlink() {
        remove_symlink_path(path).map_err(|e| e.to_string())
    } else if meta.is_file() {
        fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    }
}

/// 删除软链。Windows 上目录软链必须用 `remove_dir` 移除
/// （`remove_file` 会返回 `拒绝访问 / os error 5`），Unix 统一走 unlink。
fn remove_symlink_path(link: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        match fs::remove_file(link) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => fs::remove_dir(link),
            Err(e) => Err(e),
        }
    }
    #[cfg(not(windows))]
    {
        fs::remove_file(link)
    }
}

fn symlink_points_to(link_path: &Path, expected_canonical: &Path) -> bool {
    let Ok(target) = fs::read_link(link_path) else {
        return false;
    };
    let resolved = if target.is_absolute() {
        target
    } else {
        link_path
            .parent()
            .map(|parent| parent.join(&target))
            .unwrap_or(target)
    };
    resolved
        .canonicalize()
        .map(|actual| actual == expected_canonical)
        .unwrap_or(false)
}

fn installation_targets_skill(ins: &SkillInstallation, expected_canonical: &Path) -> bool {
    let target = Path::new(&ins.target_path);
    target
        .canonicalize()
        .map(|actual| actual == expected_canonical)
        .unwrap_or_else(|_| target == expected_canonical)
}

fn remove_symlink_if_present(link_path: &Path) -> Result<bool, String> {
    let Ok(meta) = fs::symlink_metadata(link_path) else {
        return Ok(false);
    };
    if !meta.file_type().is_symlink() {
        return Ok(false);
    }
    remove_symlink_path(link_path)
        .map_err(|e| format!("Failed to remove symlink {}: {}", link_path.display(), e))?;
    Ok(true)
}

// ── 技能仓库来源（本地路径 / git 远端）───────────────────────────────────────

const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const BUILD_TIMEOUT: Duration = Duration::from_secs(300);
const SKILL_REPOS_SUBDIR: &str = "skill_repos";
const SKILL_WATCH_DEBOUNCE: Duration = Duration::from_millis(300);
const GIT_ERROR_SNIPPET: usize = 600;
const BUILD_OUTPUT_SNIPPET: usize = 4000;
const MAX_BACKUPS: usize = 5;

/// 校验 git 仓库地址：仅允许 https:// 与 git@（ssh）两种形态。
fn validate_git_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("技能仓库地址不能为空".to_string());
    }
    if trimmed.contains(char::is_whitespace) {
        return Err("技能仓库地址不能包含空白字符".to_string());
    }
    if trimmed.starts_with("https://") || trimmed.starts_with("git@") {
        Ok(trimmed.to_string())
    } else {
        Err("仅支持 https:// 或 git@（ssh）形式的技能仓库地址".to_string())
    }
}

/// 由仓库地址推导本地缓存目录名：去 scheme/协议前缀，非法字符统一替换为 `-`，
/// 禁止以 `.` 开头/结尾（防隐藏目录与 `..` 穿越）。
fn sanitize_repo_dir_name(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    for prefix in ["https://", "http://", "git@"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.to_string();
            break;
        }
    }
    // ssh 形态 `git@github.com:org/repo.git` 去掉前缀后是 `github.com:org/repo.git`
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    while out.starts_with('.') {
        out.remove(0);
    }
    while out.ends_with('.') {
        out.pop();
    }
    if out.is_empty() || out == ".." {
        out = "skills".to_string();
    }
    out
}

async fn read_pipe_to_end<R: AsyncRead + Unpin>(
    mut pipe: R,
    stream_name: &str,
) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    pipe.read_to_end(&mut data)
        .await
        .map_err(|e| format!("读取 git {} 失败: {e}", stream_name))?;
    Ok(data)
}

/// 参数化运行子进程（不经 shell），超时强制 kill。
async fn run_process_with_env(
    program: String,
    args: Vec<String>,
    current_dir: Option<PathBuf>,
    envs: Vec<(String, String)>,
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    let mut cmd = tokio::process::Command::new(&program);
    crate::subprocess::configure_background_tokio_command(&mut cmd);
    cmd.args(&args);
    if let Some(dir) = current_dir {
        cmd.current_dir(dir);
    }
    for (key, value) in envs {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 {program} 失败: {e}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 git 标准输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 git 错误输出")?;
    let stdout_task = tokio::spawn(read_pipe_to_end(stdout, "标准输出"));
    let stderr_task = tokio::spawn(read_pipe_to_end(stderr, "错误输出"));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(|e| format!("{program} 进程等待失败: {e}"))?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(format!("{program} 超时（{} 秒）", timeout.as_secs()));
        }
    };
    let stdout_data = stdout_task
        .await
        .map_err(|e| format!("git 标准输出任务失败: {e}"))??;
    let stderr_data = stderr_task
        .await
        .map_err(|e| format!("git 错误输出任务失败: {e}"))??;
    Ok((
        status.success(),
        String::from_utf8_lossy(&stdout_data).into_owned(),
        String::from_utf8_lossy(&stderr_data).into_owned(),
    ))
}

/// 参数化运行 git 子进程（不经 shell），超时强制 kill。
async fn run_git(
    args: Vec<String>,
    current_dir: Option<PathBuf>,
) -> Result<(bool, String, String), String> {
    run_process_with_env(
        "git".to_string(),
        args,
        current_dir,
        Vec::new(),
        GIT_TIMEOUT,
    )
    .await
}

fn truncate_git_error(err: &str) -> String {
    let trimmed = err.trim();
    if trimmed.chars().count() > GIT_ERROR_SNIPPET {
        let mut s: String = trimmed.chars().take(GIT_ERROR_SNIPPET).collect();
        s.push_str("…（已截断）");
        s
    } else {
        trimmed.to_string()
    }
}

/// 恢复工作树中被删除的跟踪文件（技能缓存以远端为准：技能目录被误删后，
/// 同步应能找回；`git pull --ff-only` 对未提交删除是 no-op，必须先恢复）。
async fn restore_deleted_tracked_files(repo_dir: &Path) -> Result<(), String> {
    let repo = repo_dir.to_string_lossy().into_owned();
    let (ok, out, err) = run_git(
        vec![
            "-C".to_string(),
            repo.clone(),
            "status".to_string(),
            "--porcelain".to_string(),
        ],
        None,
    )
    .await?;
    if !ok {
        return Err(format!("git status 失败：{}", truncate_git_error(&err)));
    }
    let deleted: Vec<String> = out
        .lines()
        .filter(|line| line.starts_with(" D "))
        .map(|line| line[3..].trim().to_string())
        .filter(|path| !path.is_empty())
        .collect();
    if deleted.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "-C".to_string(),
        repo,
        "checkout".to_string(),
        "--".to_string(),
    ];
    args.extend(deleted);
    let (ok_checkout, _out_checkout, err_checkout) = run_git(args, None).await?;
    if !ok_checkout {
        return Err(format!(
            "恢复已删除的技能文件失败：{}",
            truncate_git_error(&err_checkout)
        ));
    }
    Ok(())
}

/// 快进更新缓存仓库到远端状态（缓存以远端为准，只允许 fast-forward）。
/// 必须强制 `--no-rebase`：用户全局/本地 `pull.rebase=true` 会把 pull 劫持成 rebase，
/// 而 rebase 拒绝任何未暂存改动，导致「缓存有本地改动」时同步必失败
/// （git 2.18 实测 `--ff-only` 拦不住 rebase 路径）。
async fn ff_only_update(repo_dir: &Path) -> Result<(), String> {
    let repo = repo_dir.to_string_lossy().into_owned();
    let (ok, _out, err) = run_git(
        vec![
            "-C".to_string(),
            repo,
            "pull".to_string(),
            "--no-rebase".to_string(),
            "--ff-only".to_string(),
        ],
        None,
    )
    .await?;
    if !ok {
        return Err(format!(
            "git pull --ff-only 失败（缓存有本地改动或已分叉）: {}",
            truncate_git_error(&err)
        ));
    }
    Ok(())
}

/// git 源同步：缓存缺失则 shallow clone，存在则 fetch 探测、有变更才 --ff-only pull。
/// 返回 (hub 目录绝对路径, 当前 commit)。
async fn sync_git_repo(source: &SkillSource) -> Result<(String, String), String> {
    let url = validate_git_url(source.url.as_deref().unwrap_or(""))?;
    let branch = source
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);

    let cache_root = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        let root = nezha_dir()?.join(SKILL_REPOS_SUBDIR);
        std::fs::create_dir_all(&root).map_err(|e| format!("创建技能仓库缓存目录失败: {e}"))?;
        Ok(root)
    })
    .await
    .map_err(|e| e.to_string())??;
    let repo_dir = cache_root.join(sanitize_repo_dir_name(&url));
    let repo_dir_str = repo_dir.to_string_lossy().into_owned();

    let mut missing = tokio::task::spawn_blocking({
        let repo_dir = repo_dir.clone();
        move || !repo_dir.join(".git").exists()
    })
    .await
    .map_err(|e| e.to_string())?;

    // `.git` 存在 ≠ 可用克隆：一次被中断的 clone、或手工搬进来的残缺目录都会留下一个
    // git 无法识别的 `.git`（`git status` 会报 "not a git repository"）。这里先用 git
    // 实证校验仓库有效性，非法则清掉缓存走全新 clone，让同步能自愈而不是硬报错。
    if !missing {
        let (ok_repo, _out_repo, _err_repo) = run_git(
            vec![
                "-C".to_string(),
                repo_dir_str.clone(),
                "rev-parse".to_string(),
                "--is-inside-work-tree".to_string(),
            ],
            None,
        )
        .await?;
        if !ok_repo {
            let dir_to_remove = repo_dir.clone();
            tokio::task::spawn_blocking(move || {
                let _ = std::fs::remove_dir_all(&dir_to_remove);
            })
            .await
            .map_err(|e| e.to_string())?;
            missing = true;
        }
    }

    if missing {
        let mut args = vec!["clone".to_string(), "--depth".to_string(), "1".to_string()];
        if let Some(b) = &branch {
            args.push("--branch".to_string());
            args.push(b.clone());
        }
        args.push(url.clone());
        args.push(repo_dir_str.clone());
        let (ok, _out, err) = run_git(args, None).await?;
        if !ok {
            // 清理半成品，允许下次重试
            let _ = tokio::task::spawn_blocking(move || {
                let _ = std::fs::remove_dir_all(&repo_dir);
            })
            .await;
            return Err(format!("git clone 失败: {}", truncate_git_error(&err)));
        }
    } else {
        // 缓存以远端为准：先找回被删除的跟踪文件（如技能目录被误删），再探测远端
        restore_deleted_tracked_files(&repo_dir).await?;
        let (ok, _out, err) = run_git(
            vec![
                "-C".to_string(),
                repo_dir_str.clone(),
                "fetch".to_string(),
                "origin".to_string(),
            ],
            None,
        )
        .await?;
        if !ok {
            return Err(format!(
                "git fetch 失败（沿用上次缓存）: {}",
                truncate_git_error(&err)
            ));
        }
        let (ok_head, head, _err_head) = run_git(
            vec![
                "-C".to_string(),
                repo_dir_str.clone(),
                "rev-parse".to_string(),
                "HEAD".to_string(),
            ],
            None,
        )
        .await?;
        let (ok_fetched, fetched, _err_fetched) = run_git(
            vec![
                "-C".to_string(),
                repo_dir_str.clone(),
                "rev-parse".to_string(),
                "FETCH_HEAD".to_string(),
            ],
            None,
        )
        .await?;
        if !ok_head || !ok_fetched {
            return Err("读取 git 版本信息失败，沿用上次缓存".to_string());
        }
        if head.trim() != fetched.trim() {
            ff_only_update(&repo_dir).await?;
        }
    }

    let (ok_commit, commit, err_commit) = run_git(
        vec![
            "-C".to_string(),
            repo_dir_str.clone(),
            "rev-parse".to_string(),
            "HEAD".to_string(),
        ],
        None,
    )
    .await?;
    if !ok_commit {
        return Err(format!(
            "读取 git commit 失败: {}",
            truncate_git_error(&err_commit)
        ));
    }
    Ok((repo_dir_str, commit.trim().to_string()))
}

async fn load_hub_config_async() -> Result<SkillHubConfig, String> {
    tokio::task::spawn_blocking(load_hub_config_internal)
        .await
        .map_err(|e| e.to_string())
}

async fn save_hub_config_async(cfg: SkillHubConfig) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_hub_config_internal(&cfg))
        .await
        .map_err(|e| e.to_string())?
}

/// 同步路径源：校验目录存在并刷新时间戳（技能扫描由 list_skills 负责）。
async fn sync_path_source(cfg: SkillHubConfig) -> Result<SkillHubConfig, String> {
    let hub = cfg
        .hub_path
        .clone()
        .ok_or_else(|| "技能库尚未配置".to_string())?;
    let exists = tokio::task::spawn_blocking(move || Path::new(&hub).is_dir())
        .await
        .map_err(|e| e.to_string())?;
    let mut cfg = cfg;
    if !exists {
        cfg.last_sync_error = Some("技能库目录不存在".to_string());
        save_hub_config_async(cfg.clone()).await?;
        return Err("技能库目录不存在".to_string());
    }
    cfg.last_synced_at = Some(now_ms());
    cfg.last_sync_error = None;
    save_hub_config_async(cfg.clone()).await?;
    Ok(cfg)
}

/// 按配置执行一次同步并持久化状态；失败时记录 lastSyncError（fail-soft）。
async fn sync_skill_source_persist(cfg: SkillHubConfig) -> Result<SkillHubConfig, String> {
    let Some(source) = cfg.source.clone() else {
        // 旧配置（无 source）等价于路径源
        return sync_path_source(cfg).await;
    };
    match source.source_type.as_str() {
        "git" => match sync_git_repo(&source).await {
            Ok((hub_path, commit)) => {
                let mut cfg = cfg;
                cfg.hub_path = Some(hub_path);
                cfg.last_synced_at = Some(now_ms());
                cfg.last_synced_commit = Some(commit);
                cfg.last_sync_error = None;
                save_hub_config_async(cfg.clone()).await?;
                Ok(cfg)
            }
            Err(e) => {
                let mut cfg = cfg;
                cfg.last_sync_error = Some(e.clone());
                save_hub_config_async(cfg.clone()).await?;
                Err(e)
            }
        },
        "path" => sync_path_source(cfg).await,
        other => Err(format!("Unsupported source type: {other}")),
    }
}

/// 启动时后台同步（git 源 fetch/pull，失败静默沿用缓存），完成后广播刷新事件。
pub async fn startup_sync(app: AppHandle) {
    let cfg = match load_hub_config_async().await {
        Ok(cfg) => cfg,
        Err(_) => return,
    };
    if cfg.source.as_ref().map(|s| s.source_type.as_str()) == Some("git") {
        let _ = sync_skill_source_persist(cfg).await;
    }
    let _ = app.emit("skill-hub-changed", serde_json::json!({}));
}

// ── 本地路径源文件变更监听 ────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SkillSourceWatcher {
    watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    watched_path: Arc<Mutex<Option<PathBuf>>>,
}

/// 在 Tauri setup 阶段调用：注册托管状态 + 启动防抖 emit 线程 + 挂上现有 hub 路径。
pub fn init_skill_source_watcher(app: &tauri::App) {
    let (tx, rx) = mpsc::channel::<()>();
    let watcher = notify::RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let _ = tx.send(());
        },
        notify::Config::default(),
    )
    .ok();

    let state = SkillSourceWatcher {
        watcher: Arc::new(Mutex::new(watcher)),
        watched_path: Arc::new(Mutex::new(None)),
    };
    app.manage(state);

    let cfg = load_hub_config_internal();
    if let Some(hub) = cfg.hub_path.as_deref() {
        rearm_skill_source_watcher(&app.state::<SkillSourceWatcher>(), Some(hub));
    }

    let handle = app.handle().clone();
    std::thread::spawn(move || run_skill_source_debounce(handle, rx));
}

fn run_skill_source_debounce(app: AppHandle, rx: mpsc::Receiver<()>) {
    loop {
        let Ok(_) = rx.recv() else { return };
        let deadline = Instant::now() + SKILL_WATCH_DEBOUNCE;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = app.emit("skill-hub-changed", serde_json::json!({}));
    }
}

/// 重挂监听：换路径 / 清空时先摘旧 watch（递归监听技能仓库，规模小、安全）。
fn rearm_skill_source_watcher(state: &SkillSourceWatcher, path: Option<&str>) {
    let mut watcher_guard = state.watcher.lock();
    let mut watched_guard = state.watched_path.lock();
    let Some(w) = watcher_guard.as_mut() else {
        *watched_guard = None;
        return;
    };
    if let Some(old) = watched_guard.as_ref() {
        let _ = w.unwatch(old);
    }
    *watched_guard = None;
    if let Some(raw) = path {
        let dir = PathBuf::from(raw);
        if dir.is_dir() && w.watch(&dir, notify::RecursiveMode::Recursive).is_ok() {
            *watched_guard = Some(dir);
        }
    }
}

fn canonicalize_hub_dir(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Hub path cannot be empty".to_string());
    }
    let target = Path::new(raw);
    if !target.is_absolute() {
        return Err("Hub path must be absolute".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Cannot resolve hub path: {e}"))?;
    if !canonical.is_dir() {
        return Err("Hub path is not a directory".to_string());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// 把 hub 目录登记为特殊项目（与既有 set_skill_hub_path 行为一致）。
fn register_hub_project(hub_path: &str) -> Result<(Project, bool, Vec<Project>), String> {
    let canonical = Path::new(hub_path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve hub path: {e}"))?;
    if !canonical.is_dir() {
        return Err("Hub path is not a directory".to_string());
    }
    let hub_path_str = canonical.to_string_lossy().into_owned();

    let mut projects = load_projects()?;
    let existing = projects
        .iter()
        .find(|p| Path::new(&p.path).canonicalize().ok().as_deref() == Some(canonical.as_path()))
        .cloned();

    let (project, created_new_project) = match existing {
        Some(p) => (p, false),
        None => {
            let name = canonical
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("skills_hub")
                .to_string();
            let new_project = Project {
                id: now_ms().to_string(),
                name,
                path: hub_path_str.clone(),
                branch: None,
                last_opened_at: now_ms(),
                hidden_from_rail: false,
            };
            projects.push(new_project.clone());
            save_projects(projects.clone())?;
            (new_project, true)
        }
    };
    Ok((project, created_new_project, projects))
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_skill_hub_config() -> Result<SkillHubConfig, String> {
    tokio::task::spawn_blocking(load_hub_config_internal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_skill_hub_path(
    path: String,
    state: tauri::State<'_, SkillSourceWatcher>,
) -> Result<SetHubResult, String> {
    let (result, hub_path) =
        tokio::task::spawn_blocking(move || -> Result<(SetHubResult, String), String> {
            let canonical = canonicalize_hub_dir(&path)?;
            let (project, created_new_project, projects) = register_hub_project(&canonical)?;
            let config = SkillHubConfig {
                hub_path: Some(canonical.clone()),
                hub_project_id: Some(project.id.clone()),
                created_at: Some(now_ms()),
                ..Default::default()
            };
            save_hub_config_internal(&config)?;
            Ok((
                SetHubResult {
                    config,
                    project,
                    created_new_project,
                    projects,
                },
                canonical,
            ))
        })
        .await
        .map_err(|e| e.to_string())??;
    rearm_skill_source_watcher(state.inner(), Some(&hub_path));
    Ok(result)
}

/// 设置技能仓库来源：`sourceType = "path"` 用本地目录；`"git"` 用远端 URL（可选分支），
/// git 源会先完成首次 clone（同步失败则不保存配置，允许重试）。
#[tauri::command]
pub async fn set_skill_source(
    source_type: String,
    path: Option<String>,
    url: Option<String>,
    branch: Option<String>,
    state: tauri::State<'_, SkillSourceWatcher>,
) -> Result<SetHubResult, String> {
    let (result, hub_path) = match source_type.trim() {
        "path" => {
            let raw = path.ok_or_else(|| "缺少本地目录路径".to_string())?;
            tokio::task::spawn_blocking(move || -> Result<(SetHubResult, String), String> {
                let canonical = canonicalize_hub_dir(&raw)?;
                let (project, created_new_project, projects) = register_hub_project(&canonical)?;
                let source = SkillSource {
                    source_type: "path".to_string(),
                    path: Some(canonical.clone()),
                    url: None,
                    branch: None,
                };
                let config = SkillHubConfig {
                    hub_path: Some(canonical.clone()),
                    hub_project_id: Some(project.id.clone()),
                    created_at: Some(now_ms()),
                    source: Some(source),
                    ..Default::default()
                };
                save_hub_config_internal(&config)?;
                Ok((
                    SetHubResult {
                        config,
                        project,
                        created_new_project,
                        projects,
                    },
                    canonical,
                ))
            })
            .await
            .map_err(|e| e.to_string())??
        }
        "git" => {
            let url = validate_git_url(url.as_deref().unwrap_or(""))?;
            let branch = branch
                .map(|b| b.trim().to_string())
                .filter(|b| !b.is_empty());
            let source = SkillSource {
                source_type: "git".to_string(),
                path: None,
                url: Some(url),
                branch,
            };
            let (hub_path, commit) = sync_git_repo(&source).await?;
            let hub_path_for_register = hub_path.clone();
            let (project, created_new_project, projects) =
                tokio::task::spawn_blocking(move || register_hub_project(&hub_path_for_register))
                    .await
                    .map_err(|e| e.to_string())??;
            let config = SkillHubConfig {
                hub_path: Some(hub_path.clone()),
                hub_project_id: Some(project.id.clone()),
                created_at: Some(now_ms()),
                source: Some(source),
                last_synced_at: Some(now_ms()),
                last_synced_commit: Some(commit),
                ..Default::default()
            };
            save_hub_config_async(config.clone()).await?;
            (
                SetHubResult {
                    config,
                    project,
                    created_new_project,
                    projects,
                },
                hub_path,
            )
        }
        other => return Err(format!("Unsupported source type: {other}")),
    };
    rearm_skill_source_watcher(state.inner(), Some(&hub_path));
    Ok(result)
}

/// 立即同步一次技能仓库（git：fetch + ff-only；path：校验目录 + 刷新时间戳），
/// 返回更新后的完整配置（含 lastSyncError）。
#[tauri::command]
pub async fn sync_skill_source() -> Result<SkillHubConfig, String> {
    let cfg = load_hub_config_async().await?;
    sync_skill_source_persist(cfg).await
}

/// 当前技能仓库来源状态（含上次同步时间 / commit / 错误），与配置同源。
#[tauri::command]
pub async fn get_skill_source_status() -> Result<SkillHubConfig, String> {
    get_skill_hub_config().await
}

#[tauri::command]
pub async fn clear_skill_hub(state: tauri::State<'_, SkillSourceWatcher>) -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let cfg = SkillHubConfig::default();
        save_hub_config_internal(&cfg)
    })
    .await
    .map_err(|e| e.to_string())??;
    rearm_skill_source_watcher(state.inner(), None);
    Ok(())
}

#[tauri::command]
pub async fn list_skills() -> Result<Vec<Skill>, String> {
    tokio::task::spawn_blocking(|| {
        let cfg = load_hub_config_internal();
        let Some(hub_path) = cfg.hub_path.as_deref() else {
            return Ok(Vec::new());
        };
        Ok(scan_skills_in(Path::new(hub_path)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_skill_installations(
    skill_name: Option<String>,
) -> Result<Vec<SkillInstallation>, String> {
    tokio::task::spawn_blocking(move || {
        let file = load_installations_internal();
        let mut out: Vec<SkillInstallation> = file
            .installations
            .into_iter()
            .filter(|ins| match &skill_name {
                Some(name) => ins.skill_name == *name,
                None => true,
            })
            .collect();

        // 健康度校验：用 canonicalize 比对，避免 trailing `/` / 大小写差异误报 diverged
        for ins in &mut out {
            let link = Path::new(&ins.link_path);
            let target_canonical = Path::new(&ins.target_path).canonicalize();
            ins.health = Some(match fs::symlink_metadata(link) {
                Err(_) => "broken".to_string(),
                Ok(meta) if !meta.file_type().is_symlink() => "diverged".to_string(),
                Ok(_) => match target_canonical {
                    Err(_) => "broken".to_string(),
                    Ok(expected) if symlink_points_to(link, &expected) => "ok".to_string(),
                    Ok(_) => "diverged".to_string(),
                },
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 清理全部失效安装：仅删除 broken 的软链与记录；diverged（用户改成了普通目录/文件）
/// 一律保留，绝不触碰非软链内容。返回清理条数。
#[tauri::command]
pub async fn cleanup_broken_skill_installations() -> Result<usize, String> {
    tokio::task::spawn_blocking(|| {
        let mut file = load_installations_internal();
        let mut kept: Vec<SkillInstallation> = Vec::new();
        let mut removed = 0usize;
        for ins in file.installations {
            let link = Path::new(&ins.link_path);
            let healthy = match fs::symlink_metadata(link) {
                Err(_) => false,
                // 非软链（用户自建目录/文件）视为 diverged，保留
                Ok(meta) if !meta.file_type().is_symlink() => true,
                Ok(_) => Path::new(&ins.target_path)
                    .canonicalize()
                    .map(|t| symlink_points_to(link, &t))
                    .unwrap_or(false),
            };
            if healthy {
                kept.push(ins);
            } else {
                if let Ok(meta) = fs::symlink_metadata(link) {
                    if meta.file_type().is_symlink() {
                        let _ = remove_symlink_path(link);
                    }
                }
                removed += 1;
            }
        }
        file.installations = kept;
        if removed > 0 {
            save_installations_internal(&file)?;
        }
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── 项目技能数据管理（数据统一放在 <项目>/.nezha/skill-data/<技能名>/）─────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillDataStatus {
    pub data_path: String,
    pub exists: bool,
    pub file_count: usize,
    pub last_modified: Option<i64>,
}

fn count_files_in(dir: &Path) -> usize {
    fn walk(dir: &Path, count: &mut usize, depth: usize) {
        if depth > 12 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                walk(&path, count, depth + 1);
            } else {
                *count += 1;
            }
        }
    }
    let mut count = 0;
    walk(dir, &mut count, 0);
    count
}

fn latest_mtime_in(dir: &Path) -> Option<i64> {
    fn walk(dir: &Path, best: &mut Option<i64>, depth: usize) {
        if depth > 12 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                walk(&path, best, depth + 1);
            } else if let Ok(modified) = meta.modified() {
                if let Ok(ts) = modified.duration_since(UNIX_EPOCH) {
                    let ms = ts.as_millis() as i64;
                    if best.map(|b| ms > b).unwrap_or(true) {
                        *best = Some(ms);
                    }
                }
            }
        }
    }
    let mut best = None;
    walk(dir, &mut best, 0);
    best
}

fn resolve_project(project_id: &str) -> Result<(String, PathBuf), String> {
    let projects = load_projects()?;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    let project_path = Path::new(&project.path);
    if !project_path.is_dir() {
        return Err(format!("Project path does not exist: {}", project.path));
    }
    Ok((project.path.clone(), project_path.to_path_buf()))
}

/// 从安装记录解析技能目录（target_path，指向技能仓库内的技能文件夹）。
fn resolve_skill_dir(skill_name: &str, project_id: &str) -> Result<PathBuf, String> {
    let file = load_installations_internal();
    let ins = file
        .installations
        .iter()
        .find(|i| i.skill_name == skill_name && i.project_id == project_id)
        .ok_or_else(|| "技能未安装到该项目".to_string())?;
    let skill_dir = Path::new(&ins.target_path);
    if !skill_dir.is_dir() {
        return Err(format!("技能目录不存在：{}", ins.target_path));
    }
    Ok(skill_dir.to_path_buf())
}

/// 查询技能数据目录状态（存在 / 文件数 / 最后修改）。
#[tauri::command]
pub async fn get_skill_data_status(
    skill_name: String,
    project_id: String,
) -> Result<SkillDataStatus, String> {
    tokio::task::spawn_blocking(move || {
        validate_skill_name(&skill_name)?;
        let skill_dir = resolve_skill_dir(&skill_name, &project_id)?;
        let data_dir = skill_data_dir(&skill_dir);
        let exists = data_dir.is_dir();
        Ok(SkillDataStatus {
            data_path: data_dir.to_string_lossy().into_owned(),
            exists,
            file_count: if exists { count_files_in(&data_dir) } else { 0 },
            last_modified: if exists {
                latest_mtime_in(&data_dir)
            } else {
                None
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 备份技能数据目录到 `~/.nezha/skill-backups/<技能名>/<时间戳>/`（本地，不入技能仓库 git），
/// 保留最近 5 份。返回备份目录路径。
#[tauri::command]
pub async fn backup_skill_data(skill_name: String, project_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_skill_name(&skill_name)?;
        let skill_dir = resolve_skill_dir(&skill_name, &project_id)?;
        let data_dir = skill_data_dir(&skill_dir);
        if !data_dir.is_dir() {
            return Err("技能数据目录不存在，无需备份".to_string());
        }
        let backup_root = skill_backup_root(&skill_name)?;
        fs::create_dir_all(&backup_root)
            .map_err(|e| format!("Failed to create backup root: {e}"))?;
        let dest = backup_root.join(now_ms().to_string());
        copy_dir_recursive(&data_dir, &dest)?;
        prune_backups(&backup_root, MAX_BACKUPS);
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create {}: {e}", dst.display()))?;
    let entries =
        fs::read_dir(src).map_err(|e| format!("Failed to read {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let target = dst.join(entry.file_name());
        if meta.file_type().is_symlink() {
            // 备份只复制真实文件，跳过软链
            continue;
        } else if meta.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            fs::copy(&path, &target)
                .map_err(|e| format!("Failed to copy {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// 按目录名（时间戳）升序保留最近 keep 份备份。
fn prune_backups(backup_root: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(backup_root) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    let excess = dirs.len().saturating_sub(keep);
    for dir in dirs.into_iter().take(excess) {
        let _ = fs::remove_dir_all(&dir);
    }
}

/// 执行技能声明的 `build-command` 重建数据：cwd = 数据目录，
/// 注入 NEZHA_PROJECT_ROOT / NEZHA_SKILL_DATA_DIR / HIS_REPO 环境变量。
/// 重建成功后把数据目录提交并推送到技能仓库（git 统一管理）。
/// 返回（截断的）命令输出与 git 结果。
#[tauri::command]
pub async fn run_skill_data_build(
    skill_name: String,
    project_id: String,
) -> Result<String, String> {
    validate_skill_name(&skill_name)?;

    let skill_name_for_resolve = skill_name.clone();
    let project_id_for_resolve = project_id.clone();
    let skill_dir = tokio::task::spawn_blocking(move || {
        resolve_skill_dir(&skill_name_for_resolve, &project_id_for_resolve)
    })
    .await
    .map_err(|e| e.to_string())??;
    let data_dir = skill_data_dir(&skill_dir);
    let data_dir_str = data_dir.to_string_lossy().into_owned();

    let project_path = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let (project_path, _project_dir) = resolve_project(&project_id)?;
        Ok(project_path)
    })
    .await
    .map_err(|e| e.to_string())??;

    let skill_dir_for_cmd = skill_dir.clone();
    let build_command = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let content = fs::read_to_string(skill_dir_for_cmd.join("SKILL.md"))
            .map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;
        let parsed = parse_frontmatter(&content);
        parsed
            .build_command
            .ok_or_else(|| "该技能未声明 build-command，无法自动重建".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    // 空格分词；相对路径参数基于技能目录解析
    let argv: Vec<String> = build_command
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if argv.is_empty() {
        return Err("build-command 为空".to_string());
    }
    let program = argv[0].clone();
    let mut args: Vec<String> = Vec::new();
    for arg in &argv[1..] {
        let candidate = Path::new(arg);
        if candidate.is_relative() && (arg.contains('/') || arg.contains('\\')) {
            args.push(skill_dir.join(arg).to_string_lossy().into_owned());
        } else {
            args.push(arg.clone());
        }
    }
    let envs = vec![
        ("NEZHA_PROJECT_ROOT".to_string(), project_path.clone()),
        ("NEZHA_SKILL_DATA_DIR".to_string(), data_dir_str.clone()),
        ("HIS_REPO".to_string(), project_path),
    ];
    let (ok, stdout, stderr) =
        run_process_with_env(program, args, Some(data_dir.clone()), envs, BUILD_TIMEOUT).await?;
    let combined = format!("{}{}", stdout.trim(), stderr.trim());
    let snippet = if combined.chars().count() > BUILD_OUTPUT_SNIPPET {
        let mut s: String = combined.chars().take(BUILD_OUTPUT_SNIPPET).collect();
        s.push_str("…（已截断）");
        s
    } else {
        combined
    };
    if !ok {
        return Err(format!("重建数据失败：{}", snippet));
    }

    // git 统一管理：把数据目录变更提交并推送到技能仓库
    let mut report = snippet;
    if let Some(repo_root) = find_git_root(&skill_dir) {
        let rel = data_dir
            .strip_prefix(&repo_root)
            .unwrap_or(&data_dir)
            .to_string_lossy()
            .into_owned();
        let repo_root_str = repo_root.to_string_lossy().into_owned();
        let commit_msg = format!("docs({}): rebuild skill data", skill_name);
        let (ok_add, _out_add, err_add) = run_git(
            vec![
                "-C".to_string(),
                repo_root_str.clone(),
                "add".to_string(),
                "--".to_string(),
                rel.clone(),
            ],
            None,
        )
        .await?;
        if !ok_add {
            report.push_str(&format!("\ngit add 失败：{}", truncate_git_error(&err_add)));
        } else {
            let (ok_commit, out_commit, err_commit) = run_git(
                vec![
                    "-C".to_string(),
                    repo_root_str.clone(),
                    "commit".to_string(),
                    "-m".to_string(),
                    commit_msg,
                ],
                None,
            )
            .await?;
            let nothing_to_commit = out_commit.contains("nothing to commit")
                || err_commit.contains("nothing to commit");
            if !ok_commit && !nothing_to_commit {
                return Err(format!(
                    "提交技能数据失败：{}",
                    truncate_git_error(&err_commit)
                ));
            }
            if ok_commit {
                let (ok_push, _out_push, err_push) = run_git(
                    vec![
                        "-C".to_string(),
                        repo_root_str,
                        "push".to_string(),
                        "origin".to_string(),
                        "HEAD".to_string(),
                    ],
                    None,
                )
                .await?;
                let push_note = if ok_push {
                    "\n已提交并推送到技能仓库".to_string()
                } else {
                    format!("\n已提交，但推送失败：{}", truncate_git_error(&err_push))
                };
                report.push_str(&push_note);
            } else {
                report.push_str("\n技能数据无变更，无需提交");
            }
        }
    }
    Ok(report)
}

#[tauri::command]
pub async fn install_skill(
    skill_name: String,
    skill_path: String,
    project_id: String,
    agent: String,
    scope: String,
    strategy: String,
) -> Result<InstallResult, String> {
    tokio::task::spawn_blocking(move || {
        if !matches!(agent.as_str(), "claude" | "codex") {
            return Err(format!("Unsupported agent: {}", agent));
        }
        if !matches!(scope.as_str(), "universal" | "project") {
            return Err(format!("Unsupported scope: {}", scope));
        }
        if !matches!(
            strategy.as_str(),
            "detect" | "skip" | "overwrite" | "cancel"
        ) {
            return Err(format!("Unsupported strategy: {}", strategy));
        }
        validate_skill_name(&skill_name)?;

        // cancel 是显式无操作
        if strategy == "cancel" {
            return Ok(InstallResult {
                ok: false,
                cancelled: true,
                ..Default::default()
            });
        }

        let skill_dir = Path::new(&skill_path);
        if !skill_dir.is_dir() {
            return Err(format!(
                "Skill '{}' not found at path: {}",
                skill_name, skill_path
            ));
        }
        if !skill_dir.join("SKILL.md").is_file() {
            return Err(format!("Skill '{}' has no SKILL.md", skill_name));
        }
        // skill_path 最后一段必须与 skill_name 一致，防止伪造目录名
        if skill_dir.file_name().and_then(|s| s.to_str()) != Some(skill_name.as_str()) {
            return Err(format!(
                "Skill path '{}' does not match skill name '{}'",
                skill_path, skill_name
            ));
        }

        // 校验 skill 路径必须位于已配置的 hub 目录内
        let cfg = load_hub_config_internal();
        let hub_path = cfg
            .hub_path
            .as_deref()
            .ok_or_else(|| "Skill Hub is not configured".to_string())?;
        let hub_canonical = Path::new(hub_path)
            .canonicalize()
            .map_err(|e| format!("Cannot resolve hub path '{}': {}", hub_path, e))?;
        let skill_canonical = skill_dir
            .canonicalize()
            .map_err(|e| format!("Cannot resolve skill path '{}': {}", skill_path, e))?;
        if !skill_canonical.starts_with(&hub_canonical) {
            return Err(format!(
                "Skill path '{}' is not inside hub '{}'",
                skill_path, hub_path
            ));
        }

        // 作用域决定落位：universal → 用户级技能目录（所有项目可见）；
        // project → 指定项目的技能目录。project_id 仅在 project 作用域下有效。
        let resolved_project_id: String;
        let mut data_path: Option<String> = None;
        let skills_root = if scope == "universal" {
            resolved_project_id = String::new();
            user_agent_skills_dir(&agent)
        } else {
            let projects = load_projects()?;
            let project = projects
                .iter()
                .find(|p| p.id == project_id)
                .ok_or_else(|| format!("Project '{}' not found", project_id))?;
            let project_path = Path::new(&project.path);
            if !project_path.is_dir() {
                return Err(format!("Project path does not exist: {}", project.path));
            }
            resolved_project_id = project.id.clone();
            // 技能数据跟随技能目录 `<技能>/data/`，由技能仓库 git 统一管理（安装时不创建）
            data_path = Some(skill_data_dir(&skill_canonical).to_string_lossy().into_owned());
            agent_skills_dir(project_path, &agent)
        };
        fs::create_dir_all(&skills_root)
            .map_err(|e| format!("Failed to create {}: {}", skills_root.display(), e))?;
        let link_path = skills_root.join(&skill_name);

        let target_path_str = skill_canonical.to_string_lossy().into_owned();
        let link_path_str = link_path.to_string_lossy().into_owned();

        if strategy == "skip" {
            return Ok(InstallResult {
                ok: true,
                skipped: true,
                ..Default::default()
            });
        }

        // detect / overwrite 共同入口：检查 link_path 现状
        let existing = classify_existing(&link_path);

        if let Some((kind, existing_target)) = existing.as_ref() {
            let already_same_symlink =
                kind == "symlink" && symlink_points_to(&link_path, &skill_canonical);

            if already_same_symlink {
                // 幂等：补全 installations 记录
                let installation = upsert_installation(
                    &skill_name,
                    &resolved_project_id,
                    &agent,
                    &scope,
                    data_path.as_deref(),
                    &link_path_str,
                    &target_path_str,
                )?;
                return Ok(InstallResult {
                    ok: true,
                    already_installed: true,
                    installation: Some(installation),
                    ..Default::default()
                });
            }

            if strategy == "detect" {
                return Ok(InstallResult {
                    ok: false,
                    conflict: Some(ConflictInfo {
                        existing_kind: kind.clone(),
                        existing_target: existing_target.clone(),
                        link_path: link_path_str,
                    }),
                    ..Default::default()
                });
            }

            // overwrite
            remove_existing(&link_path)?;
        }

        create_symlink(&skill_canonical, &link_path).map_err(|e| {
            format!(
                "Failed to create skill link {} -> {}: {}（Windows 提示没有所需特权时，请开启开发者模式或以管理员运行）",
                link_path.display(),
                skill_canonical.display(),
                e
            )
        })?;

        let installation = upsert_installation(
            &skill_name,
            &resolved_project_id,
            &agent,
            &scope,
            data_path.as_deref(),
            &link_path_str,
            &target_path_str,
        )?;

        Ok(InstallResult {
            ok: true,
            installation: Some(installation),
            ..Default::default()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn uninstall_skill(
    skill_name: String,
    project_id: String,
    agent: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_skill_name(&skill_name)?;
        if !matches!(agent.as_str(), "claude" | "codex") {
            return Err(format!("Unsupported agent: {}", agent));
        }
        let mut file = load_installations_internal();
        let target = file.installations.iter().find(|ins| {
            ins.skill_name == skill_name && ins.project_id == project_id && ins.agent == agent
        });

        let link_path = match target {
            Some(ins) => PathBuf::from(&ins.link_path),
            None => {
                // 即使没有记录，也尝试按约定路径清理
                if project_id.is_empty() {
                    user_agent_skills_dir(&agent).join(&skill_name)
                } else {
                    let projects = load_projects()?;
                    let project = projects
                        .iter()
                        .find(|p| p.id == project_id)
                        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
                    agent_skills_dir(Path::new(&project.path), &agent).join(&skill_name)
                }
            }
        };

        // 仅当现存的是 symlink 时才删除；普通目录保留以防误删用户内容
        if let Ok(meta) = fs::symlink_metadata(&link_path) {
            if meta.file_type().is_symlink() {
                remove_symlink_path(&link_path).map_err(|e| e.to_string())?;
            }
        }

        file.installations.retain(|ins| {
            !(ins.skill_name == skill_name && ins.project_id == project_id && ins.agent == agent)
        });
        save_installations_internal(&file)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除项目时调用：清掉该项目所有 skill 安装记录，并尽力删除残留 symlink。
/// best-effort：symlink 删不掉（项目目录已不在等）不视为错误。
#[tauri::command]
pub async fn cleanup_installations_for_project(project_id: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let mut file = load_installations_internal();
        let original_len = file.installations.len();

        for ins in file
            .installations
            .iter()
            .filter(|i| i.project_id == project_id)
        {
            let link = Path::new(&ins.link_path);
            if let Ok(meta) = fs::symlink_metadata(link) {
                if meta.file_type().is_symlink() {
                    let _ = remove_symlink_path(link);
                }
            }
        }

        file.installations
            .retain(|ins| ins.project_id != project_id);
        let removed = original_len - file.installations.len();
        if removed > 0 {
            save_installations_internal(&file)?;
        }
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_skill(skill_name: String, skill_path: String) -> Result<DeleteResult, String> {
    tokio::task::spawn_blocking(move || {
        validate_skill_name(&skill_name)?;
        let skill_dir = Path::new(&skill_path);
        if !skill_dir.is_dir() {
            return Err(format!(
                "Skill '{}' not found at path: {}",
                skill_name, skill_path
            ));
        }
        if !skill_dir.join("SKILL.md").is_file() {
            return Err(format!("Skill '{}' has no SKILL.md", skill_name));
        }
        if skill_dir.file_name().and_then(|s| s.to_str()) != Some(skill_name.as_str()) {
            return Err(format!(
                "Skill path '{}' does not match skill name '{}'",
                skill_path, skill_name
            ));
        }

        let cfg = load_hub_config_internal();
        let hub_path = cfg
            .hub_path
            .as_deref()
            .ok_or_else(|| "Skill Hub is not configured".to_string())?;
        let hub_canonical = Path::new(hub_path)
            .canonicalize()
            .map_err(|e| format!("Cannot resolve hub path: {}", e))?;
        let skill_canonical = skill_dir
            .canonicalize()
            .map_err(|e| format!("Cannot resolve skill path: {}", e))?;
        if !skill_canonical.starts_with(&hub_canonical) {
            return Err(format!(
                "Skill path '{}' is not inside hub '{}'",
                skill_path, hub_path
            ));
        }

        let file = load_installations_internal();
        let mut candidate_links: HashSet<PathBuf> = file
            .installations
            .iter()
            .filter(|ins| {
                ins.skill_name == skill_name && installation_targets_skill(ins, &skill_canonical)
            })
            .map(|ins| PathBuf::from(&ins.link_path))
            .collect();

        for project in load_projects()? {
            let project_path = Path::new(&project.path);
            for agent in ["claude", "codex"] {
                let link = agent_skills_dir(project_path, agent).join(&skill_name);
                if symlink_points_to(&link, &skill_canonical) {
                    candidate_links.insert(link);
                }
            }
        }
        for agent in ["claude", "codex"] {
            let link = user_agent_skills_dir(agent).join(&skill_name);
            if symlink_points_to(&link, &skill_canonical) {
                candidate_links.insert(link);
            }
        }

        let mut removed_links = 0usize;
        for link_path in candidate_links {
            if remove_symlink_if_present(&link_path)? {
                removed_links += 1;
            }
        }

        fs::remove_dir_all(&skill_canonical)
            .map_err(|e| format!("Failed to delete skill directory: {}", e))?;

        let mut file = file;
        file.installations.retain(|ins| {
            !(ins.skill_name == skill_name && installation_targets_skill(ins, &skill_canonical))
        });
        save_installations_internal(&file)?;

        Ok(DeleteResult {
            ok: true,
            removed_links,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn upsert_installation(
    skill_name: &str,
    project_id: &str,
    agent: &str,
    scope: &str,
    data_path: Option<&str>,
    link_path: &str,
    target_path: &str,
) -> Result<SkillInstallation, String> {
    let mut file = load_installations_internal();
    if file.version == 0 {
        file.version = 1;
    }
    let now = now_ms();
    let mut existing_idx: Option<usize> = None;
    for (i, ins) in file.installations.iter().enumerate() {
        if ins.skill_name == skill_name && ins.project_id == project_id && ins.agent == agent {
            existing_idx = Some(i);
            break;
        }
    }
    let health = target_health(Path::new(target_path)).to_string();
    let installation = SkillInstallation {
        skill_name: skill_name.to_string(),
        project_id: project_id.to_string(),
        agent: agent.to_string(),
        scope: scope.to_string(),
        data_path: data_path.map(str::to_string),
        installed_at: now,
        link_path: link_path.to_string(),
        target_path: target_path.to_string(),
        health: Some(health),
    };
    match existing_idx {
        Some(idx) => file.installations[idx] = installation.clone(),
        None => file.installations.push(installation.clone()),
    }
    save_installations_internal(&file)?;
    Ok(installation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_single_line_description() {
        let md = "---\nname: foo\ndescription: hello world\n---\nbody";
        let p = parse_frontmatter(md);
        assert_eq!(p.name.as_deref(), Some("foo"));
        assert_eq!(p.description.as_deref(), Some("hello world"));
    }

    #[test]
    fn parse_literal_block_description() {
        let md = "---\nname: foo\ndescription: |\n  line 1\n  line 2\n  line 3\n---\n";
        let p = parse_frontmatter(md);
        assert_eq!(p.description.as_deref(), Some("line 1\nline 2\nline 3"));
    }

    #[test]
    fn parse_literal_block_with_blank_line() {
        let md = "---\ndescription: |\n  para 1\n\n  para 2\n---\n";
        let p = parse_frontmatter(md);
        assert_eq!(p.description.as_deref(), Some("para 1\n\npara 2"));
    }

    #[test]
    fn parse_folded_block() {
        let md = "---\ndescription: >\n  line 1\n  line 2\n\n  line 3\n---\n";
        let p = parse_frontmatter(md);
        assert_eq!(p.description.as_deref(), Some("line 1 line 2\nline 3"));
    }

    #[test]
    fn parse_quoted_value() {
        let md = "---\nname: \"my-skill\"\n---\n";
        let p = parse_frontmatter(md);
        assert_eq!(p.name.as_deref(), Some("my-skill"));
    }

    #[test]
    fn parse_ignores_other_fields() {
        let md = "---\nname: foo\ndisable-model-invocation: false\ndescription: bar\n---\n";
        let p = parse_frontmatter(md);
        assert_eq!(p.name.as_deref(), Some("foo"));
        assert_eq!(p.description.as_deref(), Some("bar"));
    }

    #[test]
    fn validate_git_url_accepts_https_and_ssh() {
        assert_eq!(
            validate_git_url(" https://github.com/x/skills.git ").unwrap(),
            "https://github.com/x/skills.git"
        );
        assert_eq!(
            validate_git_url("git@github.com:x/skills.git").unwrap(),
            "git@github.com:x/skills.git"
        );
    }

    #[test]
    fn validate_git_url_rejects_unsupported() {
        assert!(validate_git_url("").is_err());
        assert!(validate_git_url("http://github.com/x/skills.git").is_err());
        assert!(validate_git_url("file:///tmp/skills").is_err());
        assert!(validate_git_url("github.com/x/skills.git").is_err());
        assert!(validate_git_url("https://x y.com/skills").is_err());
    }

    #[test]
    fn sanitize_repo_dir_name_maps_urls_to_safe_names() {
        assert_eq!(
            sanitize_repo_dir_name("https://github.com/x/skills.git"),
            "github.com-x-skills.git"
        );
        assert_eq!(
            sanitize_repo_dir_name("git@github.com:x/skills.git"),
            "github.com-x-skills.git"
        );
        assert_eq!(sanitize_repo_dir_name(".."), "skills");
        assert!(!sanitize_repo_dir_name("...").starts_with('.'));
        assert!(!sanitize_repo_dir_name("https://..//x").starts_with('.'));
    }

    #[test]
    fn legacy_hub_config_deserializes_without_source() {
        let json = r#"{"hubProjectId":"1","hubPath":"C:\\skills","createdAt":123}"#;
        let cfg: SkillHubConfig = serde_json::from_str(json).expect("legacy config parses");
        assert_eq!(cfg.hub_path.as_deref(), Some("C:\\skills"));
        assert!(cfg.source.is_none());
        assert!(cfg.last_sync_error.is_none());
    }

    #[test]
    fn skill_source_serializes_as_source_type() {
        let src = SkillSource {
            source_type: "git".to_string(),
            path: None,
            url: Some("https://github.com/x/skills.git".to_string()),
            branch: Some("main".to_string()),
        };
        let json = serde_json::to_string(&src).expect("serializes");
        assert!(json.contains("\"sourceType\":\"git\""));
        assert!(!json.contains("\"type\":\"git\""));
        assert!(json.contains("\"url\":\"https://github.com/x/skills.git\""));
        assert!(json.contains("\"branch\":\"main\""));
    }

    #[test]
    fn skill_source_deserializes_legacy_type_field() {
        // 旧版本配置存的是 `type`，必须兼容读取，否则用户已保存的 git 来源会丢
        let src: SkillSource = serde_json::from_str(
            r#"{"type":"git","url":"https://codeup.aliyun.com/x/SkillHub.git"}"#,
        )
        .expect("legacy source parses");
        assert_eq!(src.source_type, "git");
        assert_eq!(
            src.url.as_deref(),
            Some("https://codeup.aliyun.com/x/SkillHub.git")
        );
    }

    #[test]
    fn restores_deleted_tracked_files_in_git_repo() {
        // 回归：技能目录被误删后，同步应能找回（git pull --ff-only 对未提交删除是 no-op）。
        let dir = std::env::temp_dir().join(format!("nezha-git-restore-{}", now_ms()));
        let skill = dir.join("skill-a");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "x").unwrap();
        let run = |args: &[&str]| -> bool {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-q"]) || !run(&["add", "-A"]) || !run(&["commit", "-q", "-m", "init"]) {
            let _ = fs::remove_dir_all(&dir);
            return; // git 不可用（如无 user 配置）时跳过
        }
        fs::remove_dir_all(&skill).unwrap();
        assert!(!skill.exists());
        let restored = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(restore_deleted_tracked_files(&dir));
        assert!(restored.is_ok(), "restore failed: {restored:?}");
        assert!(skill.join("SKILL.md").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ff_only_update_wins_over_pull_rebase_with_dirty_cache() {
        // 回归：用户全局/本地 `pull.rebase=true` 会把 `git pull --ff-only` 劫持成 rebase，
        // 而 rebase 拒绝任何未暂存改动，导致「缓存有本地改动」时同步必失败
        // （git 2.18 实测：--ff-only 拦不住 rebase 路径）。
        // ff_only_update 必须强制 --no-rebase，让脏文件未被更新触碰时也能快进成功。
        let dir = std::env::temp_dir().join(format!("nezha-ffonly-rebase-{}", now_ms()));
        let cache = dir.join("cache");
        fs::create_dir_all(&dir).unwrap();
        let run = |cwd: &Path, args: &[&str]| -> Option<std::process::Output> {
            std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .ok()
        };
        let ok = |out: &Option<std::process::Output>| {
            out.as_ref().map(|o| o.status.success()).unwrap_or(false)
        };
        let stderr = |out: &Option<std::process::Output>| {
            out.as_ref()
                .map(|o| String::from_utf8_lossy(&o.stderr).into_owned())
                .unwrap_or_default()
        };

        if !ok(&run(&dir, &["init", "-q", "--bare", "remote.git"]))
            || !ok(&run(&dir, &["clone", "-q", "remote.git", "cache"]))
        {
            let _ = fs::remove_dir_all(&dir);
            return; // git 不可用时跳过
        }

        // 远端两个提交；缓存落后一个提交
        fs::write(cache.join("a.txt"), "v1").unwrap();
        fs::write(cache.join("b.txt"), "b1").unwrap();
        let add = run(&cache, &["add", "-A"]);
        assert!(ok(&add), "add failed: {}", stderr(&add));
        let commit1 = run(
            &cache,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                "c1",
            ],
        );
        assert!(ok(&commit1), "commit failed: {}", stderr(&commit1));
        let push1 = run(&cache, &["push", "-q", "origin", "HEAD:master"]);
        assert!(ok(&push1), "push failed: {}", stderr(&push1));

        fs::write(cache.join("a.txt"), "v2").unwrap();
        let add2 = run(&cache, &["add", "-A"]);
        assert!(ok(&add2));
        let commit2 = run(
            &cache,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                "c2",
            ],
        );
        assert!(ok(&commit2), "commit failed: {}", stderr(&commit2));
        let push2 = run(&cache, &["push", "-q", "origin", "HEAD:master"]);
        assert!(ok(&push2));
        let reset = run(&cache, &["reset", "-q", "--hard", "HEAD~1"]);
        assert!(ok(&reset), "reset failed: {}", stderr(&reset));

        // 复刻报错环境：pull.rebase=true + 缓存有未暂存改动（且未被更新触碰）
        let cfg = run(&cache, &["config", "pull.rebase", "true"]);
        assert!(ok(&cfg), "config failed: {}", stderr(&cfg));
        fs::write(cache.join("b.txt"), "b-dirty").unwrap();

        let updated = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(ff_only_update(&cache));
        assert!(updated.is_ok(), "ff-only update failed: {updated:?}");
        let head = run(&cache, &["rev-parse", "HEAD"]);
        let origin = run(&cache, &["rev-parse", "origin/master"]);
        assert_eq!(
            head.map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default()
                .trim(),
            origin
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default()
                .trim(),
            "cache should be fast-forwarded to remote"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_frontmatter_scope() {
        let p = parse_frontmatter("---\nname: foo\nscope: project\n---\nbody");
        assert_eq!(p.scope.as_deref(), Some("project"));
        let p2 = parse_frontmatter("---\nname: foo\n---\nbody");
        assert_eq!(p2.scope, None);
        let p3 = parse_frontmatter("---\nname: foo\nscope: universal\n---\nbody");
        assert_eq!(p3.scope.as_deref(), Some("universal"));
    }

    #[test]
    fn parse_frontmatter_project_and_build_command() {
        let p = parse_frontmatter(
            "---\nname: kg\nscope: project\nproject: Hsp 2.0\nbuild-command: python scripts/bootstrap.py\n---\nbody",
        );
        assert_eq!(p.project.as_deref(), Some("Hsp 2.0"));
        assert_eq!(
            p.build_command.as_deref(),
            Some("python scripts/bootstrap.py")
        );
        let dir = std::env::temp_dir().join(format!("nezha-skill-build-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: kg\nscope: project\nproject: Hsp 2.0\nbuild-command: python scripts/bootstrap.py\n---\nbody",
        )
        .unwrap();
        let skill = parse_skill_entry(&dir, "kg");
        assert_eq!(skill.project.as_deref(), Some("Hsp 2.0"));
        assert_eq!(
            skill.build_command.as_deref(),
            Some("python scripts/bootstrap.py")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skill_data_dir_follows_skill_folder() {
        let skill = Path::new("C:\\repo\\hsp-skillhub\\his-knowledge-graph");
        assert_eq!(
            skill_data_dir(skill),
            PathBuf::from("C:\\repo\\hsp-skillhub\\his-knowledge-graph\\data")
        );
        assert_eq!(
            find_git_root(Path::new("C:\\repo\\hsp-skillhub\\his-knowledge-graph")),
            None
        );
    }

    #[test]
    fn parse_skill_entry_defaults_scope_to_universal() {
        let dir = std::env::temp_dir().join(format!("nezha-skill-scope-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: foo\n---\nbody").unwrap();
        let skill = parse_skill_entry(&dir, "foo");
        assert_eq!(skill.scope, "universal");
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: foo\nscope: project\n---\nbody",
        )
        .unwrap();
        let skill = parse_skill_entry(&dir, "foo");
        assert_eq!(skill.scope, "project");
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: foo\nscope: weird\n---\nbody",
        )
        .unwrap();
        let skill = parse_skill_entry(&dir, "foo");
        assert_eq!(skill.scope, "universal");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_installation_deserializes_without_scope() {
        let json = r#"{"skillName":"s","projectId":"p1","agent":"claude","installedAt":1,"linkPath":"l","targetPath":"t"}"#;
        let ins: SkillInstallation =
            serde_json::from_str(json).expect("legacy installation parses");
        assert_eq!(ins.scope, "");
        assert_eq!(ins.project_id, "p1");
    }

    #[cfg(windows)]
    #[test]
    fn removes_windows_directory_symlink() {
        // Windows 上 fs::remove_file 删除目录软链会返回「拒绝访问 (os error 5)」，
        // remove_symlink_path 必须能删掉目录软链（回归：卸载/覆盖/清理全链路共用）。
        let dir = std::env::temp_dir().join(format!("nezha-remove-symlink-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let link = dir.join("link");
        // 创建目录软链依赖开发者模式/管理员权限；不可用时跳过（本机无法复现该路径）。
        if std::os::windows::fs::symlink_dir(&dir, &link).is_err() {
            return;
        }
        assert!(fs::symlink_metadata(&link).is_ok());
        remove_symlink_path(&link).expect("directory symlink should be removable");
        assert!(fs::symlink_metadata(&link).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn junction_fallback_creates_working_link_without_privilege() {
        // 回归：无开发者模式/管理员权限时 symlink_dir 报 os error 1314，
        // create_junction（mklink /J）无需特权，且可被 read_link/健康检查/卸载正常处理。
        let dir = std::env::temp_dir().join(format!("nezha-junction-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let link = dir.join("link");
        match create_junction(&dir, &link) {
            Ok(()) => {
                let meta = fs::symlink_metadata(&link).expect("junction metadata");
                assert!(meta.file_type().is_symlink(), "junction 应按 symlink 处理");
                let target = fs::read_link(&link).expect("junction read_link");
                assert_eq!(
                    target.canonicalize().ok(),
                    Some(dir.canonicalize().expect("dir canonicalize"))
                );
                remove_symlink_path(&link).expect("junction removable via remove_symlink_path");
                assert!(fs::symlink_metadata(&link).is_err());
            }
            Err(_) => {
                // cmd/mklink 不可用（极少数环境）时跳过
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
