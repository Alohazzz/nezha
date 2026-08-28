use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;

/// Running build processes: build_id -> child OS pid (for tree-kill on cancel).
static RUNNING_BUILDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn running_builds() -> &'static Mutex<HashMap<String, u32>> {
    RUNNING_BUILDS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BuildConfig {
    #[serde(default)]
    pub script_path: String,
    #[serde(default)]
    pub msbuild_path: String,
    #[serde(default = "default_solution")]
    pub solution: String,
    #[serde(default = "default_configuration")]
    pub configuration: String,
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default)]
    pub external_dll_dir: String,
    #[serde(default)]
    pub skip_external_check: bool,
    #[serde(default)]
    pub skip_restore: bool,
    #[serde(default)]
    pub skip_clean: bool,
    #[serde(default)]
    pub default_branch: String,
    #[serde(default = "default_max_parallel")]
    pub max_parallel: u32,
}

fn default_solution() -> String {
    "Hsp v2.0.sln".to_string()
}
fn default_configuration() -> String {
    "Debug".to_string()
}
fn default_platform() -> String {
    "AnyCPU".to_string()
}
fn default_max_parallel() -> u32 {
    2
}

impl Default for BuildConfig {
    fn default() -> Self {
        BuildConfig {
            script_path: String::new(),
            msbuild_path: String::new(),
            solution: default_solution(),
            configuration: default_configuration(),
            platform: default_platform(),
            external_dll_dir: String::new(),
            skip_external_check: false,
            skip_restore: false,
            skip_clean: false,
            default_branch: String::new(),
            max_parallel: default_max_parallel(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BuildRepo {
    pub name: String,
    pub path: String,
    pub remote: String,
    pub branch: String,
    pub branches: Vec<String>,
    pub is_submodule: bool,
    pub dirty: bool,
    pub missing: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PullResult {
    pub name: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BuildState {
    /// repo name -> last successfully built commit (diff baseline for incremental builds).
    #[serde(default)]
    pub last_built: HashMap<String, String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RunBuildOptions {
    #[serde(default)]
    pub continue_on_error: bool,
    /// Incremental include list (project paths / assemblies / file names). Empty = full build.
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub skip_external_check: bool,
    #[serde(default)]
    pub skip_restore: bool,
    #[serde(default)]
    pub skip_clean: bool,
    /// Selected git repo names (build scope). Empty = full solution.
    #[serde(default)]
    pub selected: Vec<String>,
    /// 覆盖构建输出目录（如 worktree 运行根）。为空则用项目配置 external_dll_dir / 自动探测。
    #[serde(default)]
    pub external_dll_dir: String,
}

fn validate_project_path(project_path: &str) -> Result<(), String> {
    let path = Path::new(project_path);
    if !path.is_absolute() {
        return Err("Project path must be absolute".to_string());
    }
    if !path.exists() {
        return Err("Project path does not exist".to_string());
    }
    path.canonicalize()
        .map(|_| ())
        .map_err(|e| format!("Cannot resolve project path: {e}"))
}

fn read_project_path(project_path: &str) -> Result<PathBuf, String> {
    validate_project_path(project_path)?;
    Ok(Path::new(project_path).to_path_buf())
}

fn run_git_in(dir: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("git");
    crate::subprocess::configure_background_command(&mut cmd);
    cmd.args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git failed: {e}"))
}

fn git_ok(dir: &str, args: &[&str]) -> bool {
    matches!(run_git_in(dir, args), Ok(out) if out.status.success())
}

fn is_repo(dir: &str) -> bool {
    git_ok(dir, &["rev-parse", "--git-dir"])
}

fn git_remote(dir: &str) -> String {
    if let Ok(out) = run_git_in(dir, &["remote", "get-url", "origin"]) {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        String::new()
    }
}

fn git_branch(dir: &str) -> String {
    if let Ok(out) = run_git_in(dir, &["symbolic-ref", "--short", "HEAD"]) {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        // detached HEAD — fall back to rev-parse short
        if let Ok(out) = run_git_in(dir, &["rev-parse", "--short", "HEAD"]) {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            String::new()
        }
    }
}

fn git_branches(dir: &str) -> Vec<String> {
    if let Ok(out) = run_git_in(dir, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]) {
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        Vec::new()
    }
}

fn git_dirty(dir: &str) -> bool {
    // 忽略子模块改动：子仓库常因本地改动/commit 指针不同导致主仓库误报脏。
    // 叶仓库（无子模块）此开关为 no-op，仍能反映自身真实改动。
    // 再忽略未跟踪文件（--untracked-files=no）：未跟踪/未纳入 Git 的内容不参与 `git pull --ff-only`，
    // 不能因为工作区里有本地生成物（如构建产物）就把整个仓库误判为脏并阻断拉取。
    // 只有受跟踪文件的改动/暂存改动才真正可能阻碍快进合并。
    if let Ok(out) = run_git_in(
        dir,
        &["status", "--porcelain", "--ignore-submodules=all", "--untracked-files=no"],
    ) {
        !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    } else {
        false
    }
}

fn git_head(dir: &str) -> Result<String, String> {
    let out = run_git_in(dir, &["rev-parse", "HEAD"])?;
    if !out.status.success() {
        return Err("not a commit".to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Parse `.gitmodules` for `[submodule "name"]` entries with `path` / `url`.
fn parse_gitmodules(gitmodules: &str) -> Vec<(String, String, String)> {
    let mut entries = Vec::new();
    let mut cur: Option<String> = None;
    let mut path = String::new();
    let mut url = String::new();
    for line in gitmodules.lines() {
        let t = line.trim();
        if t.starts_with("[submodule ") && t.ends_with(']') {
            if let Some(n) = cur.take() {
                if !path.trim().is_empty() {
                    entries.push((n, path.trim().to_string(), url.trim().to_string()));
                }
            }
            let inner = &t["[submodule ".len()..t.len() - 1];
            cur = Some(inner.trim_matches('"').trim().to_string());
            path = String::new();
            url = String::new();
            continue;
        }
        if let Some(v) = t.strip_prefix("path").map(|s| s.trim().trim_start_matches('=').trim()) {
            if !v.is_empty() {
                path = v.to_string();
            }
        } else if let Some(v) = t.strip_prefix("url").map(|s| s.trim().trim_start_matches('=').trim()) {
            if !v.is_empty() {
                url = v.to_string();
            }
        }
    }
    if let Some(n) = cur.take() {
        if !path.trim().is_empty() {
            entries.push((n, path.trim().to_string(), url.trim().to_string()));
        }
    }
    entries
}

#[tauri::command]
pub fn read_build_config(project_path: String) -> Result<BuildConfig, String> {
    validate_project_path(&project_path)?;
    let cfg = crate::config::read_project_config(project_path)?;
    Ok(cfg.build)
}

#[tauri::command]
pub fn write_build_config(project_path: String, build: BuildConfig) -> Result<(), String> {
    validate_project_path(&project_path)?;
    let mut cfg = crate::config::read_project_config(project_path.clone())?;
    cfg.build = build;
    crate::config::write_project_config(project_path, cfg)
}

/// 自动推导仓库清单：主仓库 + `.gitmodules` 子模块。
/// 在阻塞线程执行（涉及 git / 文件 IO）。
#[tauri::command]
pub async fn discover_build_repos(project_path: String) -> Result<Vec<BuildRepo>, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || discover_repos_blocking(&project_path))
        .await
        .map_err(|e| format!("discover_build_repos panicked: {e}"))?
}

fn discover_repos_blocking(project_path: &str) -> Result<Vec<BuildRepo>, String> {
    let root = read_project_path(project_path)?;
    let mut repos = Vec::new();

    if is_repo(project_path) {
        let name = root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "root".to_string());
        repos.push(BuildRepo {
            name,
            path: project_path.to_string(),
            remote: git_remote(project_path),
            branch: git_branch(project_path),
            branches: git_branches(project_path),
            is_submodule: false,
            dirty: git_dirty(project_path),
            missing: false,
        });
    }

    let gitmodules = root.join(".gitmodules");
    if gitmodules.exists() {
        let content = std::fs::read_to_string(&gitmodules).unwrap_or_default();
        for (name, rel, url) in parse_gitmodules(&content) {
            let full = root.join(&rel);
            let full_str = full.to_string_lossy().into_owned();
            let missing = !full.exists();
            repos.push(BuildRepo {
                name,
                path: full_str.clone(),
                remote: url,
                branch: if !missing { git_branch(&full_str) } else { String::new() },
                branches: if !missing { git_branches(&full_str) } else { Vec::new() },
                is_submodule: true,
                dirty: if !missing { git_dirty(&full_str) } else { false },
                missing,
            });
        }
    }
    Ok(repos)
}

/// 切到指定仓库的指定分支（用于在 Build 面板选择子模块/主仓库分支）。
/// 仅做 `git checkout <branch>`，不自动 pull。
#[tauri::command]
pub async fn build_checkout_branch(
    project_path: String,
    repo_path: String,
    branch: String,
) -> Result<(), String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_project_path(&repo_path)?;
        let out = run_git_in(&repo_path, &["checkout", &branch])?;
        if !out.status.success() {
            return Err(git_error_text(&out));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("build_checkout_branch panicked: {e}"))?
}

fn git_error_text(out: &std::process::Output) -> String {
    let s = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .trim()
    .to_string();
    if s.is_empty() {
        "git command failed".to_string()
    } else {
        s
    }
}

/// 对勾选的仓库执行 `git pull --ff-only`；工作区不干净则阻断（绝不 stash/reset）。
#[tauri::command]
pub async fn build_pull_repos(
    project_path: String,
    selected: Vec<String>,
) -> Result<Vec<PullResult>, String> {
    validate_project_path(&project_path)?;
    let selected = selected;
    tauri::async_runtime::spawn_blocking(move || {
        let repos = discover_repos_blocking(&project_path)?;
        let mut out = Vec::new();
        for r in repos {
            if !selected.iter().any(|s| s == &r.name) {
                continue;
            }
            if r.missing {
                out.push(PullResult {
                    name: r.name,
                    ok: false,
                    message: "仓库目录不存在（子模块未初始化？）".to_string(),
                });
                continue;
            }
            if r.dirty {
                out.push(PullResult {
                    name: r.name,
                    ok: false,
                    message: "工作区不干净，已阻断（绝不 stash/reset）。先提交或暂存后再拉取。".to_string(),
                });
                continue;
            }
            let mut res = run_git_in(&r.path, &["pull", "--ff-only", "--no-rebase"]);
            // 若失败（常见：pull.rebase 干扰 / 远端跟踪引用陈旧导致 cannot lock ref），
            // 先刷新远端跟踪引用（prune + force fetch，仅改 remote-tracking ref，不动工作区），再重试。
            if let Ok(out) = &res {
                if !out.status.success() {
                    let _ = run_git_in(&r.path, &["fetch", "--prune", "--force", "origin"]);
                    res = run_git_in(&r.path, &["pull", "--ff-only", "--no-rebase"]);
                }
            }
            match res {
                Ok(out2) if out2.status.success() => {
                    let msg = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out2.stdout),
                        String::from_utf8_lossy(&out2.stderr)
                    )
                    .trim()
                    .to_string();
                    out.push(PullResult {
                        name: r.name,
                        ok: true,
                        message: if msg.is_empty() {
                            "已更新".to_string()
                        } else {
                            msg
                        },
                    });
                }
                Ok(out2) => {
                    let msg = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out2.stdout),
                        String::from_utf8_lossy(&out2.stderr)
                    )
                    .trim()
                    .to_string();
                    out.push(PullResult {
                        name: r.name,
                        ok: false,
                        message: msg,
                    });
                }
                Err(e) => out.push(PullResult {
                    name: r.name,
                    ok: false,
                    message: e,
                }),
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("build_pull_repos panicked: {e}"))?
}

fn build_state_path(project_path: &str) -> Result<PathBuf, String> {
    Ok(Path::new(project_path).join(".nezha").join("build-state.json"))
}

#[tauri::command]
pub fn read_build_state(project_path: String) -> Result<BuildState, String> {
    validate_project_path(&project_path)?;
    let p = build_state_path(&project_path)?;
    if !p.exists() {
        return Ok(BuildState::default());
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_build_state(project_path: String, state: BuildState) -> Result<(), String> {
    validate_project_path(&project_path)?;
    let p = build_state_path(&project_path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&p, &raw)
}

/// 读取 ps1 生成的 `Log/build-plan.json`（环境检查 + 阶段计划 + 外部依赖清单）。
#[tauri::command]
pub fn read_build_plan(project_path: String) -> Result<Option<serde_json::Value>, String> {
    validate_project_path(&project_path)?;
    let plan = Path::new(&project_path).join("Log").join("build-plan.json");
    if !plan.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&plan).map_err(|e| e.to_string())?;
    // ps1 用 Out-File -Encoding utf8 会在文件头加 BOM，serde_json 不接受，先去掉
    let raw = raw.trim_start_matches('\u{feff}');
    // 空文件 / 解析失败不当作错误：前端仅少展示计划，不因此让整面板失败。
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => Ok(Some(v)),
        Err(_) => Ok(None),
    }
}

fn build_fix_status_path(project_path: &str) -> Result<PathBuf, String> {
    Ok(Path::new(project_path).join(".nezha").join("build-fix-status.json"))
}

/// 读取「已修复完成」的项目名列表（agent 修完会写入，用户可手动勾选）。
#[tauri::command]
pub fn read_build_fix_status(project_path: String) -> Result<Vec<String>, String> {
    validate_project_path(&project_path)?;
    let p = build_fix_status_path(&project_path)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    match serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}')) {
        Ok(v) => Ok(v
            .get("fixed")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()),
        Err(_) => Ok(vec![]),
    }
}

#[tauri::command]
pub fn write_build_fix_status(project_path: String, fixed: Vec<String>) -> Result<(), String> {
    validate_project_path(&project_path)?;
    let p = build_fix_status_path(&project_path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let obj = serde_json::json!({ "fixed": fixed });
    let raw = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&p, &raw)
}

/// 把错误信息文本写入项目的 Log/build-errors.txt，返回文件路径。
#[tauri::command]
pub fn export_build_errors(project_path: String, content: String) -> Result<String, String> {
    validate_project_path(&project_path)?;
    let log_dir = Path::new(&project_path).join("Log");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let path = log_dir.join("build-errors.txt");
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
pub struct BuildOutputProgress {
    pub done: u32,
    pub total: u32,
}

/// 定时读取共享输出目录：统计「本轮构建（mtime 晚于 since_ms）新产出」的 dll 数，
/// 用更细的粒度反映实时进度（dll 写到哪进度就到哪）。
#[tauri::command]
pub async fn read_build_output_progress(
    project_path: String,
    since_ms: i64,
) -> Result<BuildOutputProgress, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let plan_path = Path::new(&project_path).join("Log").join("build-plan.json");
        // 构建 ps1 可能正在重写 build-plan.json，读到空/坏文件时重试几次
        let mut v: Option<serde_json::Value> = None;
        for _ in 0..4 {
            if let Ok(raw) = std::fs::read_to_string(&plan_path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}')) {
                    v = Some(parsed);
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        let Some(v) = v else {
            return Ok(BuildOutputProgress { done: 0, total: 0 });
        };
        let ext_dir = v
            .get("ExternalDllDir")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .or_else(|| {
                crate::config::read_project_config(project_path.clone())
                    .ok()
                    .map(|c| c.build.external_dll_dir)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_default();
        if ext_dir.is_empty() {
            return Ok(BuildOutputProgress { done: 0, total: 0 });
        }
        let assemblies = v
            .get("Projects")
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|proj| proj.get("Assembly").and_then(|a| a.as_str()).map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let total = assemblies.len() as u32;
        let mut done = 0u32;
        for a in &assemblies {
            let dll = Path::new(&ext_dir).join(format!("{a}.dll"));
            if let Ok(meta) = std::fs::metadata(&dll) {
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                        if (dur.as_millis() as i64) >= since_ms {
                            done += 1;
                        }
                    }
                }
            }
        }
        Ok(BuildOutputProgress { done, total })
    })
    .await
    .map_err(|e| format!("read_build_output_progress panicked: {e}"))?
}

/// 解析 ps1 脚本路径：先配置覆盖，再 HIS 本地，再 SkillHub 克隆。
fn resolve_script_path(project_path: &str, cfg: &BuildConfig) -> Result<PathBuf, String> {
    if !cfg.script_path.is_empty() {
        let p = PathBuf::from(&cfg.script_path);
        if p.exists() {
            return Ok(p);
        }
        return Err(format!("script_path 不存在: {}", p.to_string_lossy()));
    }
    let local = Path::new(project_path)
        .join(".agents")
        .join("skills")
        .join("hsp-build-order")
        .join("scripts")
        .join("hsp-build-order.ps1");
    if local.exists() {
        return Ok(local);
    }
    if let Some(home) = crate::platform::home_dir() {
        let skill_repos = home.join(".nezha").join("skill_repos");
        if let Ok(rd) = std::fs::read_dir(&skill_repos) {
            for e in rd.flatten() {
                let cand = e
                    .path()
                    .join("hsp-build-order")
                    .join("scripts")
                    .join("hsp-build-order.ps1");
                if cand.exists() {
                    return Ok(cand);
                }
            }
        }
    }
    Err("找不到 hsp-build-order.ps1，请在构建配置里填写 script_path".to_string())
}

/// 启动构建：以流式方式跑 `hsp-build-order.ps1`，输出通过 `Channel` 直投前端。
/// 返回 build_id（前端可据此取消）；后台任务结束时在成功时更新构建基准 commit。
#[tauri::command]
pub async fn run_build(
    project_path: String,
    options: RunBuildOptions,
    on_output: Channel<String>,
) -> Result<String, String> {
    validate_project_path(&project_path)?;
    let cfg = crate::config::read_project_config(project_path.clone())?.build;
    let script = resolve_script_path(&project_path, &cfg)?;

    let mut cmd = tokio::process::Command::new("powershell.exe");
    crate::subprocess::configure_background_tokio_command(&mut cmd);
    cmd.arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg("-Root")
        .arg(&project_path)
        .arg("-PlanJson");
    if options.continue_on_error {
        cmd.arg("-Continue");
    }
    if options.skip_external_check {
        cmd.arg("-SkipExternalCheck");
    }
    if options.skip_restore {
        cmd.arg("-SkipRestore");
    }
    if options.skip_clean {
        cmd.arg("-SkipClean");
    }
    if !options.include.is_empty() {
        let inc = options.include.join(",");
        cmd.arg("-IncludeProjects").arg(inc);
    }
    if !cfg.msbuild_path.is_empty() {
        cmd.arg("-MsbuildPath").arg(&cfg.msbuild_path);
    }
    if !options.external_dll_dir.is_empty() {
        cmd.arg("-ExternalDllDir").arg(&options.external_dll_dir);
    } else if !cfg.external_dll_dir.is_empty() {
        cmd.arg("-ExternalDllDir").arg(&cfg.external_dll_dir);
    }
    if !cfg.solution.is_empty() {
        cmd.arg("-Solution").arg(&cfg.solution);
    }
    if !cfg.configuration.is_empty() {
        cmd.arg("-Configuration").arg(&cfg.configuration);
    }
    if !cfg.platform.is_empty() {
        cmd.arg("-Platform").arg(&cfg.platform);
    }
    if !options.selected.is_empty() {
        cmd.arg("-SelectedRepos").arg(options.selected.join(","));
    }
    let max_parallel = cfg.max_parallel.clamp(1, 8);
    cmd.arg("-MaxParallel").arg(max_parallel.to_string());
    cmd.current_dir(&project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn powershell failed: {e}"))?;
    let pid = child.id();
    let build_id = uuid::Uuid::new_v4().to_string();
    if let Some(pid) = pid {
        running_builds().lock().unwrap().insert(build_id.clone(), pid);
    }

    let task_id = build_id.clone();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output = on_output.clone();
    tauri::async_runtime::spawn(async move {
        let mut pump_handle = None;
        if let Some(out) = stdout {
            let ch = output.clone();
            pump_handle = Some(tauri::async_runtime::spawn(async move {
                pump_pipe(out, ch).await;
            }));
        }
        let mut pump_err = None;
        if let Some(err) = stderr {
            let ch = output.clone();
            pump_err = Some(tauri::async_runtime::spawn(async move {
                pump_pipe(err, ch).await;
            }));
        }

        let status = child.wait().await;
        if let Some(h) = pump_handle {
            let _ = h.await;
        }
        if let Some(h) = pump_err {
            let _ = h.await;
        }

        running_builds().lock().unwrap().remove(&task_id);

        let exit_code = status.as_ref().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = output.send(format!("\n@@NEZHA_BUILD_DONE@@ exit={}\n", exit_code));

        // 成功时才刷新基准 commit（下一轮增量 diff 以此为基线）。
        if matches!(status, Ok(s) if s.success()) {
            let project = project_path.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Ok(repos) = discover_repos_blocking(&project) {
                    let mut state = read_build_state_blocking(&project);
                    for r in repos {
                        if let Ok(sha) = git_head(&r.path) {
                            state.last_built.insert(r.name, sha);
                        }
                    }
                    state.updated_at = Some(now_iso());
                    let _ = write_build_state_blocking(&project, &state);
                }
            })
            .await;
        }
    });

    Ok(build_id)
}

/// 仅分析（`-DryRun -PlanJson`）：不编译，只生成 `Log/build-plan.json` 供面板可视化。
/// 返回脚本输出尾部；失败时返回错误文本。
#[tauri::command]
pub async fn analyze_build(
    project_path: String,
    options: RunBuildOptions,
) -> Result<String, String> {
    validate_project_path(&project_path)?;
    let cfg = crate::config::read_project_config(project_path.clone())?.build;
    let script = resolve_script_path(&project_path, &cfg)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("powershell.exe");
        crate::subprocess::configure_background_command(&mut cmd);
        cmd.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script)
            .arg("-Root")
            .arg(&project_path)
            .arg("-DryRun")
            .arg("-PlanJson")
            .arg("-SkipExternalCheck");
        // DryRun 分析始终跳过外部缺失阻断，只看计划与依赖。
        if options.skip_restore {
            cmd.arg("-SkipRestore");
        }
        if options.skip_clean {
            cmd.arg("-SkipClean");
        }
        if !cfg.msbuild_path.is_empty() {
            cmd.arg("-MsbuildPath").arg(&cfg.msbuild_path);
        }
        if !cfg.external_dll_dir.is_empty() {
            cmd.arg("-ExternalDllDir").arg(&cfg.external_dll_dir);
        }
        if !cfg.solution.is_empty() {
            cmd.arg("-Solution").arg(&cfg.solution);
        }
        if !cfg.configuration.is_empty() {
            cmd.arg("-Configuration").arg(&cfg.configuration);
        }
        if !cfg.platform.is_empty() {
            cmd.arg("-Platform").arg(&cfg.platform);
        }
        if !options.selected.is_empty() {
            cmd.arg("-SelectedRepos").arg(options.selected.join(","));
        }
        cmd.current_dir(&project_path);
        let out = cmd.output().map_err(|e| format!("analyze failed: {e}"))?;
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if !out.status.success() {
            return Err(combined.trim().to_string());
        }
        Ok(combined.trim().to_string())
    })
    .await
    .map_err(|e| format!("analyze_build panicked: {e}"))?
}

/// 用 headless AI 分析构建失败日志，给出可执行的修复建议。
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct IncrementalPlan {
    #[serde(default)]
    projects: Vec<IncrementalProject>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct IncrementalProject {
    path: String,
    name: String,
    #[serde(default)]
    dependents: Vec<String>,
}

/// 计算增量编译的 include 集合：以 build-state 的 last_built 为基准，
/// 对勾选仓库做 git diff → 变更文件映射到所属项目 → 按计划里的
/// 反向依赖（Dependents）求闭包。返回项目名列表（供 ps1 `-IncludeProjects`）。
#[tauri::command]
pub async fn compute_incremental_include(
    project_path: String,
    selected: Vec<String>,
) -> Result<Vec<String>, String> {
    validate_project_path(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        compute_incremental_blocking(&project_path, &selected)
    })
    .await
    .map_err(|e| format!("compute_incremental_include panicked: {e}"))?
}

fn compute_incremental_blocking(
    project_path: &str,
    selected: &[String],
) -> Result<Vec<String>, String> {
    let repos = discover_repos_blocking(project_path)?;
    let state = read_build_state_blocking(project_path);

    // 1) 汇总变更文件（绝对路径）
    let mut changed_abs: Vec<String> = Vec::new();
    for r in &repos {
        if !selected.iter().any(|s| s == &r.name) {
            continue;
        }
        if r.missing {
            continue;
        }
        let Some(base) = state.last_built.get(&r.name) else {
            continue;
        };
        if base.is_empty() {
            continue;
        }
        let range = format!("{}..HEAD", base);
        let out = run_git_in(&r.path, &["diff", &range, "--name-only"])?;
        if !out.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let rel = line.trim();
            if rel.is_empty() {
                continue;
            }
            changed_abs.push(format!("{}/{}", r.path, rel));
        }
    }
    if changed_abs.is_empty() {
        return Err(
            "无基于上次构建基准确认的变更，或不具备增量条件（可先全量构建一次）".to_string(),
        );
    }

    // 2) 读计划（含反向依赖）
    let plan_path = Path::new(project_path).join("Log").join("build-plan.json");
    if !plan_path.exists() {
        return Err("缺少 build-plan.json，请先执行「分析/计划」".to_string());
    }
    let raw = std::fs::read_to_string(&plan_path).map_err(|e| e.to_string())?;
    let plan: IncrementalPlan = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    // 3) 变更文件 → 所属项目（取最深匹配目录）
    let mut changed_projects: Vec<String> = Vec::new();
    for cp in &changed_abs {
        let mut best: Option<(usize, &IncrementalProject)> = None;
        for p in &plan.projects {
            let Some(parent) = Path::new(&p.path).parent() else {
                continue;
            };
            let dir = normalize_path(&parent.to_string_lossy());
            if path_starts_with(cp, &dir) {
                let len = dir.len();
                if best.as_ref().map(|(l, _)| len > *l).unwrap_or(true) {
                    best = Some((len, p));
                }
            }
        }
        if let Some((_, p)) = best {
            if !changed_projects.contains(&p.name) {
                changed_projects.push(p.name.clone());
            }
        }
    }
    if changed_projects.is_empty() {
        return Err("无法把变更文件映射到工程".to_string());
    }

    // 4) 反向依赖闭包
    let mut name_deps: HashMap<String, Vec<String>> = HashMap::new();
    for p in &plan.projects {
        name_deps.insert(p.name.clone(), p.dependents.clone());
    }
    let mut include: Vec<String> = changed_projects.clone();
    let mut seen: std::collections::HashSet<String> =
        changed_projects.iter().cloned().collect();
    let mut queue: Vec<String> = changed_projects.clone();
    while let Some(n) = queue.pop() {
        let deps = name_deps.get(&n).cloned().unwrap_or_default();
        for d in deps {
            if seen.insert(d.clone()) {
                include.push(d.clone());
                queue.push(d);
            }
        }
    }
    Ok(include)
}

fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
}

fn path_starts_with(child: &str, dir: &str) -> bool {
    let c = normalize_path(child);
    let d = normalize_path(dir);
    if c.eq_ignore_ascii_case(&d) {
        return true;
    }
    let lower_c = c.to_lowercase();
    let lower_d = d.to_lowercase();
    lower_c.starts_with(&format!("{}/", lower_d))
}

async fn pump_pipe<R: tokio::io::AsyncRead + Unpin>(mut r: R, sink: Channel<String>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
        if buf.len() >= 4 * 1024 {
            let s = String::from_utf8_lossy(&buf).into_owned();
            let _ = sink.send(s);
            buf.clear();
        }
    }
    if !buf.is_empty() {
        let s = String::from_utf8_lossy(&buf).into_owned();
        let _ = sink.send(s);
    }
}

fn now_iso() -> String {
    use chrono::Utc;
    Utc::now().to_rfc3339()
}

fn read_build_state_blocking(project_path: &str) -> BuildState {
    let p = build_state_path(project_path).unwrap_or_else(|_| PathBuf::from(""));
    if p.exists() {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str::<BuildState>(&raw) {
                return s;
            }
        }
    }
    BuildState::default()
}

fn write_build_state_blocking(project_path: &str, state: &BuildState) -> Result<(), String> {
    let p = build_state_path(project_path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&p, &raw)
}

/// 取消构建：Windows 用 `taskkill /T /F` 清整棵进程树（powershell + MSBuild + dotnet restore），
/// 避免孤儿进程占用共享输出目录锁。等价于 Job Object 的一次性整树清理。
#[tauri::command]
pub fn cancel_build(build_id: String) -> Result<(), String> {
    let pid = running_builds()
        .lock()
        .unwrap()
        .remove(&build_id)
        .ok_or_else(|| "build not running".to_string())?;
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("taskkill");
        crate::subprocess::configure_background_command(&mut cmd);
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let out = cmd.output().map_err(|e| format!("taskkill failed: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 非 Windows：kill 进程组（构建脚本为 powershell，其子进程默认同组）。
        let mut cmd = std::process::Command::new("kill");
        cmd.args(["-9", &pid.to_string()]);
        let _ = cmd.output();
    }
    Ok(())
}

/// 当前正在运行的构建 id 列表（供面板恢复状态）。
#[tauri::command]
pub fn get_running_builds() -> Result<Vec<String>, String> {
    Ok(running_builds().lock().unwrap().keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::Command;

    use super::git_dirty;

    struct TempRepo {
        path: PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("nezha-build-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            let out = Command::new("git").arg("init").arg(&path).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            for (k, v) in [("user.email", "test@test.test"), ("user.name", "test")] {
                let o = Command::new("git")
                    .arg("-C")
                    .arg(&path)
                    .args(["config", k, v])
                    .output()
                    .unwrap();
                assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            }
            Self { path }
        }

        fn dir(&self) -> &str {
            self.path.to_str().unwrap()
        }

        fn git(&self, args: &[&str]) {
            let o = Command::new("git")
                .arg("-C")
                .arg(&self.path)
                .args(args)
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // 未跟踪（未纳入 Git）的内容不应当把仓库判脏：`git pull --ff-only` 不会被它们阻断。
    #[test]
    fn git_dirty_ignores_untracked_files() {
        let repo = TempRepo::new();
        std::fs::write(repo.path.join("tracked.txt"), "hello").unwrap();
        repo.git(&["add", "tracked.txt"]);
        repo.git(&["commit", "-m", "init"]);

        // 只加一个未跟踪文件（本地生成物，不在 Git 上）
        std::fs::write(repo.path.join("local-only.txt"), "not on git").unwrap();

        assert!(!git_dirty(repo.dir()));
    }

    // 受跟踪文件的改动/暂存改动仍会判脏——这些才可能真正阻碍快进合并。
    #[test]
    fn git_dirty_still_detects_tracked_changes() {
        let repo = TempRepo::new();
        std::fs::write(repo.path.join("tracked.txt"), "hello").unwrap();
        repo.git(&["add", "tracked.txt"]);
        repo.git(&["commit", "-m", "init"]);

        // 修改受跟踪文件
        std::fs::write(repo.path.join("tracked.txt"), "changed").unwrap();
        assert!(git_dirty(repo.dir()));

        // 暂存后仍为脏
        repo.git(&["add", "tracked.txt"]);
        assert!(git_dirty(repo.dir()));
    }
}
