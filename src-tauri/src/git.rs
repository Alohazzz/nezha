use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

/// Validate that project_path is absolute and looks like a real project directory.
fn validate_project_path(project_path: &str) -> Result<(), String> {
    let path = Path::new(project_path);
    if !path.is_absolute() {
        return Err("Project path must be absolute".to_string());
    }
    if !path.exists() {
        return Err("Project path does not exist".to_string());
    }
    // Resolve symlinks / .. and ensure the path didn't escape
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project path: {}", e))?;
    if canonical != path {
        // Allow symlinks that resolve to a valid directory, but block obvious traversal
        if !canonical.is_dir() {
            return Err("Project path is not a directory".to_string());
        }
    }
    Ok(())
}

/// 执行 git 命令并返回原始 Output。
/// 泛型 S 允许同时接受 `&[&str]` 和 `&[String]`。
pub(crate) fn run_git<S: AsRef<std::ffi::OsStr>>(
    project_path: &str,
    args: &[S],
) -> Result<std::process::Output, String> {
    validate_project_path(project_path)?;

    let mut cmd = std::process::Command::new("git");
    crate::subprocess::configure_background_command(&mut cmd);
    cmd.args(args)
        .current_dir(project_path)
        .output()
        .map_err(|e| e.to_string())
}

async fn read_pipe_to_end<R: AsyncRead + Unpin>(
    mut pipe: R,
    stream_name: &str,
) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    pipe.read_to_end(&mut data)
        .await
        .map_err(|e| format!("Failed to read git {}: {}", stream_name, e))?;
    Ok(data)
}

/// 带超时的 git 命令执行。
/// 超时后会终止底层 git 子进程，避免后台进程和阻塞线程持续积压。
pub(crate) async fn run_git_with_timeout(
    project_path: String,
    args: Vec<String>,
    timeout: Duration,
) -> Result<Output, String> {
    validate_project_path(&project_path)?;

    let mut cmd = tokio::process::Command::new("git");
    crate::subprocess::configure_background_tokio_command(&mut cmd);
    let mut child = cmd
        .args(&args)
        .current_dir(&project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture git stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture git stderr".to_string())?;

    let stdout_task = tokio::spawn(read_pipe_to_end(stdout, "stdout"));
    let stderr_task = tokio::spawn(read_pipe_to_end(stderr, "stderr"));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(|e| e.to_string())?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("Git 命令执行超时（{}秒）", timeout.as_secs()));
        }
    };

    let stdout = stdout_task
        .await
        .map_err(|e| format!("Git stdout task failed: {}", e))??;
    let stderr = stderr_task
        .await
        .map_err(|e| format!("Git stderr task failed: {}", e))??;

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// 执行 git 命令，若退出码非零则将 stderr 作为错误返回。
fn run_git_check<S: AsRef<std::ffi::OsStr>>(project_path: &str, args: &[S]) -> Result<(), String> {
    let output = run_git(project_path, args)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

fn git_command_error(output: &Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = format!("{}{}", stderr, stdout).trim().to_string();
    if message.is_empty() {
        fallback.to_string()
    } else {
        message
    }
}

fn validate_git_relative_path(relative_path: &str) -> Result<(), String> {
    if relative_path.is_empty() {
        return Err("File path must not be empty".to_string());
    }

    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("File path must be relative".to_string());
    }

    for component in path.components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err("File path must stay inside the git worktree".to_string());
            }
            _ => {}
        }
    }

    Ok(())
}

fn unique_git_file_paths(file_paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();

    for file_path in file_paths {
        validate_git_relative_path(&file_path)?;
        if seen.insert(file_path.clone()) {
            paths.push(file_path);
        }
    }

    Ok(paths)
}

fn git_path_args(base_args: &[&str], file_paths: Vec<String>) -> Result<Vec<String>, String> {
    let paths = unique_git_file_paths(file_paths)?;
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let mut args: Vec<String> = base_args.iter().map(|arg| (*arg).to_string()).collect();
    args.push("--".to_string());
    args.extend(paths);
    Ok(args)
}

/// Resolve the actual working directory for a git command.
///
/// `project_path` is always the project root (Project.path). `repo_path` is an optional sub-repo
/// or worktree path that must live inside the project. When omitted, falls back to project_path
/// (single-repo project, legacy behavior).
fn resolve_repo_path_blocking(
    project_path: &str,
    repo_path: Option<&str>,
) -> Result<String, String> {
    validate_project_path(project_path)?;
    let project = Path::new(project_path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project path: {}", e))?;

    let Some(repo) = repo_path.map(str::trim).filter(|repo| !repo.is_empty()) else {
        return path_to_string(&project);
    };
    validate_project_path(repo)?;

    let repo_canonical = Path::new(repo)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve repo path: {}", e))?;
    if !repo_canonical.starts_with(&project) {
        return Err("Repo path is outside the project directory".to_string());
    }
    path_to_string(&repo_canonical)
}

pub(crate) async fn resolve_repo_path(
    project_path: &str,
    repo_path: Option<&str>,
) -> Result<String, String> {
    let project_path = project_path.to_string();
    let repo_path = repo_path.map(str::to_string);
    tauri::async_runtime::spawn_blocking(move || {
        resolve_repo_path_blocking(&project_path, repo_path.as_deref())
    })
    .await
    .map_err(|e| format!("resolve_repo_path task panicked: {}", e))?
}

fn git_worktree_root(project_path: &str) -> Result<PathBuf, String> {
    let output = run_git(project_path, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("Cannot resolve git worktree root".to_string());
    }

    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve git worktree root: {}", e))?;
    let project = Path::new(project_path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project path: {}", e))?;

    if !project.starts_with(&root) {
        return Err("Git worktree root does not contain project path".to_string());
    }

    Ok(root)
}

pub(crate) fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|path| path.to_string())
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())
}

fn git_has_head(worktree_root: &str) -> Result<bool, String> {
    let output = run_git(worktree_root, &["rev-parse", "--verify", "HEAD"])?;
    Ok(output.status.success())
}

const PROTECTED_FIRST_SEGMENTS: &[&str] = &[".git", ".nezha"];

fn is_protected_project_relative_path(relative_path: &str) -> bool {
    Path::new(relative_path)
        .components()
        .find_map(|component| match component {
            std::path::Component::Normal(name) => name.to_str().map(|name| {
                PROTECTED_FIRST_SEGMENTS
                    .iter()
                    .any(|protected| name.eq_ignore_ascii_case(protected))
            }),
            _ => None,
        })
        .unwrap_or(false)
}

fn apply_login_shell_env(cmd: &mut Command) {
    for (key, value) in crate::app_settings::get_login_shell_env() {
        cmd.env(key, value);
    }
}

/// 拼装 commit message headless 调用的 agent 参数（claude -p / codex exec）。
/// 轻量模型与思考深度来自应用级设置：None 时不传对应旗标，跟随 CLI 默认。
fn build_commit_message_agent_args(
    agent: &str,
    prompt: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    if agent == "codex" {
        args.push("exec".into());
        if let Some(model) = model {
            args.push("--model".into());
            args.push(model.into());
        }
        if let Some(effort) = reasoning_effort {
            args.push("-c".into());
            args.push(
                format!(
                    "model_reasoning_effort={}",
                    toml::Value::String(effort.to_string())
                )
                .into(),
            );
        }
        args.push(prompt.into());
    } else {
        args.extend(["-p", prompt, "--output-format", "text"].map(std::ffi::OsString::from));
        if let Some(model) = model {
            args.push("--model".into());
            args.push(model.into());
        }
        if let Some(effort) = reasoning_effort {
            args.push("--effort".into());
            args.push(effort.into());
        }
    }
    args
}

fn run_agent_commit_message_command(
    agent: &str,
    project_path: &str,
    prompt: &str,
) -> Result<Output, String> {
    let (launch, light) = crate::app_settings::get_agent_launch_and_light_model(agent);
    let mut cmd = Command::new(&launch.program);
    crate::subprocess::configure_background_command(&mut cmd);
    cmd.args(build_commit_message_agent_args(
        agent,
        prompt,
        light.model.as_deref(),
        light.reasoning_effort.as_deref(),
    ));
    cmd.current_dir(project_path);
    cmd.stdin(Stdio::null());
    apply_login_shell_env(&mut cmd);
    for (key, value) in &launch.extra_env {
        cmd.env(key, value);
    }
    cmd.output()
        .map_err(|e| format!("Failed to run {agent}: {e}"))
}

fn create_empty_temp_file() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("nezha-empty-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::File::create(&path)
        .map_err(|e| format!("Failed to create temporary file for git diff: {e}"))?;
    Ok(path)
}

// ── Tauri 命令 ───────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub(crate) struct GitRoot {
    /// 绝对路径（与 Project.path 相同含义）
    path: String,
    /// 用于 UI 切换器显示的名字：单仓库项目时为 "."，多仓库时为子目录名
    name: String,
    /// 是否就是 project_path 自身
    #[serde(rename = "isRoot")]
    is_root: bool,
}

fn dir_is_git_repo(path: &Path) -> bool {
    // `.git` 可能是普通目录（regular checkout）或文件（worktree 的 gitdir 文件 / submodule）
    path.join(".git").exists()
}

/// 发现给定 project_path 下所有 git 工作目录。
/// - 如果 project_path 自身是 git → 返回单元素 vec（单仓库路径）
/// - 否则扫描第一层子目录中含 `.git` 的，按名字排序后返回
/// - 都不是 → 返回空 vec（前端识别为非 git 项目）
fn discover_git_roots_blocking(project_path: &str) -> Result<Vec<GitRoot>, String> {
    validate_project_path(&project_path)?;
    let root = Path::new(project_path);
    let project_canonical = root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project path: {}", e))?;
    if dir_is_git_repo(root) {
        return Ok(vec![GitRoot {
            path: project_path.to_string(),
            name: ".".to_string(),
            is_root: true,
        }]);
    }

    let mut found: Vec<GitRoot> = Vec::new();
    let entries =
        std::fs::read_dir(root).map_err(|e| format!("Cannot read project directory: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        // Do not surface a first-level symlink that points to a repository outside the workspace.
        if !canonical.starts_with(&project_canonical) {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            // 跳过隐藏目录和 nezha 自身的目录
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            if dir_is_git_repo(&path) {
                if let Some(path_str) = path.to_str() {
                    found.push(GitRoot {
                        path: path_str.to_string(),
                        name: name.to_string(),
                        is_root: false,
                    });
                }
            }
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

#[tauri::command]
pub async fn discover_git_roots(project_path: String) -> Result<Vec<GitRoot>, String> {
    tauri::async_runtime::spawn_blocking(move || discover_git_roots_blocking(&project_path))
        .await
        .map_err(|e| format!("discover_git_roots task panicked: {}", e))?
}

#[tauri::command]
pub async fn generate_commit_message(
    project_path: String,
    repo_path: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    // 1. Get staged diff
    let diff_output = run_git(&cwd, &["diff", "--staged"])?;
    let diff = String::from_utf8_lossy(&diff_output.stdout).into_owned();
    if diff.trim().is_empty() {
        return Err("No staged changes to generate a commit message for.".to_string());
    }

    // Truncate diff if too large to avoid CLI arg limits
    let diff = if diff.len() > 50_000 {
        format!("{}...(diff truncated)", &diff[..50_000])
    } else {
        diff
    };

    // 2. Read project config for prompt and default agent（配置始终在项目根）
    let config = crate::config::read_project_config(project_path.clone())?;
    let commit_prompt = config.git.commit_prompt;
    let timeout_secs = config.git.commit_message_timeout_secs.clamp(1, 120);
    let agent = config.agent.default;

    // 3. Build full prompt
    let full_prompt = format!(
        "{}\n\nGit diff:\n```diff\n{}\n```\n\nOutput only the commit message, nothing else.",
        commit_prompt, diff
    );

    // 4. Run agent in non-interactive exec mode with configurable timeout
    let output = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        tokio::task::spawn_blocking(move || {
            run_agent_commit_message_command(&agent, &cwd, &full_prompt)
        }),
    )
    .await
    .map_err(|_| format!("生成提交信息超时（{}秒）", timeout_secs))?
    .map_err(|e| format!("生成提交信息线程错误: {}", e))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Agent failed: {}{}", stderr, stdout));
    }

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if result.is_empty() {
        return Err("Agent returned empty response.".to_string());
    }
    Ok(result)
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct GitFileChange {
    path: String,
    status: String,
    staged: bool,
}

fn parse_porcelain_z_status(stdout: &[u8]) -> Vec<GitFileChange> {
    let mut changes = Vec::new();
    let mut entries = stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty());

    while let Some(entry) = entries.next() {
        if entry.len() < 4 || entry[2] != b' ' {
            continue;
        }

        let x = entry[0] as char;
        let y = entry[1] as char;
        let display_path = String::from_utf8_lossy(&entry[3..]).into_owned();

        if x == 'R' || x == 'C' {
            let _ = entries.next();
        }

        if x == '?' && y == '?' {
            changes.push(GitFileChange {
                path: display_path,
                status: "?".to_string(),
                staged: false,
            });
        } else {
            if x != ' ' && x != '?' {
                changes.push(GitFileChange {
                    path: display_path.clone(),
                    status: x.to_string(),
                    staged: true,
                });
            }
            if y != ' ' && y != '?' {
                changes.push(GitFileChange {
                    path: display_path,
                    status: y.to_string(),
                    staged: false,
                });
            }
        }
    }

    changes
}

#[tauri::command]
pub async fn git_status(
    project_path: String,
    repo_path: Option<String>,
) -> Result<Vec<GitFileChange>, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let args = vec![
        "-c".to_string(),
        "core.quotePath=false".to_string(),
        "status".to_string(),
        "--porcelain=v1".to_string(),
        "-z".to_string(),
        "--untracked-files=all".to_string(),
    ];

    let output = run_git_with_timeout(cwd, args, Duration::from_secs(5)).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = format!("{}{}", stderr, stdout).trim().to_string();

        return Err(if message.is_empty() {
            "Failed to get git status".to_string()
        } else {
            message
        });
    }

    Ok(parse_porcelain_z_status(&output.stdout))
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct GitCommit {
    hash: String,
    short_hash: String,
    author: String,
    date: String,
    message: String,
    refs: Vec<String>,
}

#[derive(serde::Serialize)]
pub(crate) struct GitBranchInfo {
    name: String,
    current: bool,
    remote: Option<String>,
}

#[tauri::command]
pub async fn git_list_branches(
    project_path: String,
    repo_path: Option<String>,
) -> Result<Vec<GitBranchInfo>, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let output = run_git_with_timeout(
        cwd,
        vec!["branch".to_string(), "-a".to_string()],
        Duration::from_secs(5),
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut branches = Vec::new();
    for line in stdout.lines() {
        if line.len() < 2 {
            continue;
        }
        let current = line.starts_with("* ");
        let raw = line[2..].trim();
        // Skip HEAD pointer lines like "remotes/origin/HEAD -> origin/main"
        if raw.contains(" -> ") {
            continue;
        }
        if let Some(without_remotes) = raw.strip_prefix("remotes/") {
            // "origin/main" -> remote = "origin", name = "origin/main"
            let name = without_remotes.to_string();
            let remote = name.split('/').next().map(|s| s.to_string());
            branches.push(GitBranchInfo {
                name,
                current,
                remote,
            });
        } else if !raw.is_empty() {
            branches.push(GitBranchInfo {
                name: raw.to_string(),
                current,
                remote: None,
            });
        }
    }
    Ok(branches)
}

#[tauri::command]
pub async fn git_checkout_branch(
    project_path: String,
    repo_path: Option<String>,
    branch_name: String,
    is_remote: bool,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let args: Vec<String> = if is_remote {
        // "origin/main" -> local name "main", track remote
        let local_name = branch_name
            .split_once('/')
            .map(|(_, n)| n.to_string())
            .unwrap_or_else(|| branch_name.clone());
        vec![
            "checkout".into(),
            "-b".into(),
            local_name,
            "--track".into(),
            format!("remotes/{}", branch_name),
        ]
    } else {
        vec!["checkout".into(), branch_name.clone()]
    };
    run_git_check(&cwd, &args)
}

#[tauri::command]
pub async fn git_create_branch(
    project_path: String,
    repo_path: Option<String>,
    branch_name: String,
    from_branch: String,
    checkout: bool,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let args: &[&str] = if checkout {
        &["checkout", "-b", &branch_name, &from_branch]
    } else {
        &["branch", &branch_name, &from_branch]
    };
    run_git_check(&cwd, args)
}

#[tauri::command]
pub async fn git_log(
    project_path: String,
    repo_path: Option<String>,
    limit: u32,
    search: Option<String>,
    branch: Option<String>,
) -> Result<Vec<GitCommit>, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let limit_str = limit.to_string();
    let format = "COMMIT:%H%nSHORT:%h%nAUTHOR:%an%nDATE:%ar%nSUBJECT:%s%nREFS:%D%nEND_RECORD";
    let mut args: Vec<String> = vec![
        "log".into(),
        format!("--format={}", format),
        "-n".into(),
        limit_str,
    ];
    if let Some(ref s) = search {
        if !s.is_empty() {
            args.push(format!("--grep={}", s));
        }
    }
    if let Some(ref b) = branch {
        if !b.is_empty() {
            args.push(b.clone());
        }
    }

    let output = run_git_with_timeout(cwd, args, Duration::from_secs(10)).await?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut commits = Vec::new();
    let mut hash = String::new();
    let mut short_hash = String::new();
    let mut author = String::new();
    let mut date = String::new();
    let mut message = String::new();
    let mut refs: Vec<String> = Vec::new();

    for line in stdout.lines() {
        if let Some(v) = line.strip_prefix("COMMIT:") {
            hash = v.to_string();
        } else if let Some(v) = line.strip_prefix("SHORT:") {
            short_hash = v.to_string();
        } else if let Some(v) = line.strip_prefix("AUTHOR:") {
            author = v.to_string();
        } else if let Some(v) = line.strip_prefix("DATE:") {
            date = v.to_string();
        } else if let Some(v) = line.strip_prefix("SUBJECT:") {
            message = v.to_string();
        } else if let Some(v) = line.strip_prefix("REFS:") {
            refs = v
                .split(", ")
                .filter(|s| !s.is_empty())
                .map(|s| s.trim().to_string())
                .collect();
        } else if line == "END_RECORD" && !hash.is_empty() {
            commits.push(GitCommit {
                hash: hash.clone(),
                short_hash: short_hash.clone(),
                author: author.clone(),
                date: date.clone(),
                message: message.clone(),
                refs: refs.clone(),
            });
            hash.clear();
            short_hash.clear();
            author.clear();
            date.clear();
            message.clear();
            refs.clear();
        }
    }
    Ok(commits)
}

#[derive(serde::Serialize)]
pub(crate) struct GitCommitFile {
    path: String,
    status: String,
    additions: i32,
    deletions: i32,
}

#[derive(serde::Serialize)]
pub(crate) struct GitCommitDetail {
    hash: String,
    short_hash: String,
    author: String,
    date: String,
    message: String,
    files: Vec<GitCommitFile>,
    total_additions: i32,
    total_deletions: i32,
}

#[tauri::command]
pub async fn git_commit_detail(
    project_path: String,
    repo_path: Option<String>,
    commit_hash: String,
) -> Result<GitCommitDetail, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let info_out = run_git(
        &cwd,
        &[
            "show",
            "--no-patch",
            "--format=HASH:%H%nSHORT:%h%nAUTHOR:%an%nDATE:%ar%nSUBJECT:%s",
            &commit_hash,
        ],
    )?;

    let info_str = String::from_utf8_lossy(&info_out.stdout).into_owned();
    let mut hash = String::new();
    let mut short_hash = String::new();
    let mut author = String::new();
    let mut date = String::new();
    let mut message = String::new();
    for line in info_str.lines() {
        if let Some(v) = line.strip_prefix("HASH:") {
            hash = v.to_string();
        } else if let Some(v) = line.strip_prefix("SHORT:") {
            short_hash = v.to_string();
        } else if let Some(v) = line.strip_prefix("AUTHOR:") {
            author = v.to_string();
        } else if let Some(v) = line.strip_prefix("DATE:") {
            date = v.to_string();
        } else if let Some(v) = line.strip_prefix("SUBJECT:") {
            message = v.to_string();
        }
    }

    let ns_out = run_git(
        &cwd,
        &[
            "diff-tree",
            "--no-commit-id",
            "-r",
            "--name-status",
            &commit_hash,
        ],
    )?;

    let mut file_statuses: HashMap<String, String> = HashMap::new();
    for line in String::from_utf8_lossy(&ns_out.stdout).lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        match parts.as_slice() {
            [st, path] => {
                file_statuses.insert(
                    path.to_string(),
                    if st.starts_with('R') {
                        "R".to_string()
                    } else {
                        st.to_string()
                    },
                );
            }
            [st, _old, new_path] => {
                file_statuses.insert(
                    new_path.to_string(),
                    if st.starts_with('R') {
                        "R".to_string()
                    } else {
                        st.to_string()
                    },
                );
            }
            _ => {}
        }
    }

    let num_out = run_git(
        &cwd,
        &[
            "diff-tree",
            "--no-commit-id",
            "-r",
            "--numstat",
            &commit_hash,
        ],
    )?;

    let mut files = Vec::new();
    let mut total_additions = 0i32;
    let mut total_deletions = 0i32;

    for line in String::from_utf8_lossy(&num_out.stdout).lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() == 3 {
            let additions: i32 = parts[0].parse().unwrap_or(0);
            let deletions: i32 = parts[1].parse().unwrap_or(0);
            let path = parts[2].to_string();
            total_additions += additions;
            total_deletions += deletions;
            let status = file_statuses
                .get(&path)
                .cloned()
                .unwrap_or_else(|| "M".to_string());
            files.push(GitCommitFile {
                path,
                status,
                additions,
                deletions,
            });
        }
    }

    Ok(GitCommitDetail {
        hash,
        short_hash,
        author,
        date,
        message,
        files,
        total_additions,
        total_deletions,
    })
}

#[tauri::command]
pub async fn git_show_diff(
    project_path: String,
    repo_path: Option<String>,
    commit_hash: String,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let args = vec!["show".to_string(), "--format=".to_string(), commit_hash];
    let output = run_git_with_timeout(cwd, args, Duration::from_secs(10)).await?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let raw = output.stdout;
    let limit = 500 * 1024;
    Ok(String::from_utf8_lossy(if raw.len() > limit {
        &raw[..limit]
    } else {
        &raw
    })
    .into_owned())
}

#[tauri::command]
pub async fn git_file_diff(
    project_path: String,
    repo_path: Option<String>,
    file_path: String,
    staged: bool,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let mut args = vec!["diff".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    args.push("--".to_string());
    args.push(file_path.clone());

    let output = run_git_with_timeout(cwd.clone(), args, Duration::from_secs(10)).await?;
    let raw = output.stdout;

    // For untracked files, git diff returns nothing — fall back to --no-index diff
    if raw.is_empty() && !staged {
        let abs_path = std::path::Path::new(&cwd).join(&file_path);
        let abs_path_str = abs_path.to_string_lossy().into_owned();
        let empty_file = create_empty_temp_file()?;
        let fallback_args = vec![
            "diff".to_string(),
            "--no-index".to_string(),
            empty_file.to_string_lossy().into_owned(),
            abs_path_str,
        ];
        let fallback = run_git_with_timeout(cwd, fallback_args, Duration::from_secs(10)).await;
        let _ = std::fs::remove_file(&empty_file);
        let fallback = fallback?;
        let fallback_raw = fallback.stdout;
        let limit = 200 * 1024;
        return Ok(String::from_utf8_lossy(if fallback_raw.len() > limit {
            &fallback_raw[..limit]
        } else {
            &fallback_raw
        })
        .into_owned());
    }

    let limit = 200 * 1024;
    Ok(String::from_utf8_lossy(if raw.len() > limit {
        &raw[..limit]
    } else {
        &raw
    })
    .into_owned())
}

#[tauri::command]
pub async fn git_stage(
    project_path: String,
    repo_path: Option<String>,
    file_path: String,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    run_git_check(&cwd, &["add", "--", &file_path])
}

#[tauri::command]
pub async fn git_unstage(
    project_path: String,
    repo_path: Option<String>,
    file_path: String,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    if git_has_head(&cwd)? {
        run_git_check(&cwd, &["restore", "--staged", "--", &file_path])
    } else {
        // 首次提交前无 HEAD，改用 `git reset` 将暂存项退回。
        run_git_check(&cwd, &["reset", "--", &file_path])
    }
}

#[tauri::command]
pub async fn git_stage_files(
    project_path: String,
    repo_path: Option<String>,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let args = git_path_args(&["add"], file_paths)?;
    if args.is_empty() {
        return Ok(());
    }

    let output = run_git_with_timeout(cwd, args, Duration::from_secs(10)).await?;
    if !output.status.success() {
        return Err(git_command_error(&output, "Failed to stage files"));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_unstage_files(
    project_path: String,
    repo_path: Option<String>,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    // 首次提交前无 HEAD，`git restore --staged` 会失败，退回到不依赖 HEAD 的 `git reset`。
    // 此处用异步 run_git_with_timeout（而非同步 git_has_head）做检测，避免阻塞 Tokio 运行时。
    let head_check = run_git_with_timeout(
        cwd.clone(),
        vec![
            "rev-parse".to_string(),
            "--verify".to_string(),
            "HEAD".to_string(),
        ],
        Duration::from_secs(5),
    )
    .await?;
    let base: &[&str] = if head_check.status.success() {
        &["restore", "--staged"]
    } else {
        &["reset"]
    };

    let args = git_path_args(base, file_paths)?;
    if args.is_empty() {
        return Ok(());
    }

    let output = run_git_with_timeout(cwd, args, Duration::from_secs(10)).await?;
    if !output.status.success() {
        return Err(git_command_error(&output, "Failed to unstage files"));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stage_all(project_path: String, repo_path: Option<String>) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    run_git_check(&cwd, &["add", "-A"])
}

#[tauri::command]
pub async fn git_unstage_all(
    project_path: String,
    repo_path: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    run_git_check(&cwd, &["restore", "--staged", "."])
}

#[tauri::command]
pub async fn git_commit(
    project_path: String,
    repo_path: Option<String>,
    message: String,
    issue_tag: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let mut message = message;
    if let Some(tag) = issue_tag
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        if !message.contains(tag) {
            message = format!("{}\n\n{}", message.trim_end(), tag);
        }
    }
    run_git_check(&cwd, &["commit", "-m", &message])
}

/// 校验 base..branch 范围内所有提交信息包含关联议题 tag（如 `#QHDK-29312`），
/// 缺失时阻断并列出违规提交，保证云效能按提交信息关联代码。
fn validate_commits_contain_tag(
    cwd: &str,
    base_branch: &str,
    branch: &str,
    tag: &str,
) -> Result<(), String> {
    let range = format!("{base_branch}..{branch}");
    let out = run_git(cwd, &["log", "--format=%h%x09%s", &range])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut missing: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (hash, subject) = match line.split_once('\t') {
            Some((h, s)) => (h, s),
            None => (line, line),
        };
        if !subject.contains(tag) {
            missing.push(format!("{hash} {subject}"));
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let shown = missing
        .iter()
        .take(10)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let more = if missing.len() > 10 {
        format!("\n… 另有 {} 条提交", missing.len() - 10)
    } else {
        String::new()
    };
    Err(format!(
        "合并前校验失败：以下提交信息未包含关联议题 {tag}（云效按提交信息中的 #编号 关联代码）：\n{shown}{more}\n请为这些提交补充议题编号（如 git commit --amend 或新增一条含 {tag} 的提交）后再合并。"
    ))
}

fn untracked_files_under_directory<'a>(
    directory_path: &str,
    untracked_files: &'a [String],
) -> Vec<&'a str> {
    let directory = Path::new(directory_path);
    untracked_files
        .iter()
        .map(String::as_str)
        .filter(|path| {
            let path = Path::new(path);
            path != directory && path.starts_with(directory)
        })
        .collect()
}

fn is_listed_untracked_file(relative_path: &str, untracked_files: &[String]) -> bool {
    let relative_path = Path::new(relative_path);
    untracked_files
        .iter()
        .any(|path| Path::new(path) == relative_path)
}

fn is_protected_worktree_relative_path(
    worktree_root: &Path,
    project_path: &str,
    relative_path: &str,
) -> bool {
    if is_protected_project_relative_path(relative_path) {
        return true;
    }

    let rel = Path::new(relative_path);
    if rel.is_absolute() {
        return false;
    }

    let canonical_project = match Path::new(project_path).canonicalize() {
        Ok(path) => path,
        Err(_) => return false,
    };
    let target = worktree_root.join(rel);
    let Some(file_name) = target.file_name() else {
        return false;
    };
    let Some(parent) = target.parent() else {
        return false;
    };
    let Ok(canonical_parent) = parent.canonicalize() else {
        return false;
    };
    let resolved = canonical_parent.join(file_name);

    resolved
        .strip_prefix(&canonical_project)
        .ok()
        .map(|rel_from_project| {
            is_protected_project_relative_path(&rel_from_project.to_string_lossy())
        })
        .unwrap_or(false)
}

/// Move a worktree-relative path to the system trash. Canonicalize only the parent directory so
/// symlinks at the leaf are deleted as themselves rather than followed to their target. Reject
/// absolute or `..`-escaping relative paths defensively even though `git status` should never emit them.
fn trash_worktree_relative_path(
    worktree_root: &Path,
    project_path: &str,
    relative_path: &str,
) -> Result<(), String> {
    let rel = Path::new(relative_path);
    if rel.is_absolute() {
        return Err("Untracked path must be relative".to_string());
    }

    let target = worktree_root.join(rel);
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?
        .to_string();
    let parent = target
        .parent()
        .ok_or_else(|| "Cannot resolve parent directory".to_string())?;

    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Cannot resolve parent directory: {}", e))?;
    let canonical_root = worktree_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve git worktree root: {}", e))?;
    let canonical_project = Path::new(project_path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project path: {}", e))?;

    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Path is outside the git worktree".to_string());
    }

    let resolved = canonical_parent.join(&file_name);
    if resolved == canonical_root {
        return Err("Refusing to delete project root".to_string());
    }
    if resolved.symlink_metadata().is_err() {
        return Err("Path does not exist".to_string());
    }
    if is_protected_project_relative_path(relative_path) {
        return Err("Refusing to delete protected project metadata".to_string());
    }
    if let Ok(rel_from_project) = resolved.strip_prefix(&canonical_project) {
        let rel_from_project = rel_from_project.to_string_lossy();
        if is_protected_project_relative_path(&rel_from_project) {
            return Err("Refusing to delete protected project metadata".to_string());
        }
    }

    trash::delete(&resolved).map_err(|e| e.to_string())
}

fn discard_untracked_path(
    project_path: &str,
    worktree_root: &Path,
    relative_path: &str,
    untracked_files: &[String],
) -> Result<(), String> {
    let rel = Path::new(relative_path);
    if rel.is_absolute() {
        return Err("Untracked path must be relative".to_string());
    }
    if is_protected_worktree_relative_path(worktree_root, project_path, relative_path) {
        return Err("Refusing to delete protected project metadata".to_string());
    }

    let target = worktree_root.join(rel);
    let metadata = target
        .symlink_metadata()
        .map_err(|_| "Path does not exist".to_string())?;

    if metadata.file_type().is_dir() {
        for rel in untracked_files_under_directory(relative_path, untracked_files) {
            if is_protected_worktree_relative_path(worktree_root, project_path, rel) {
                continue;
            }
            trash_worktree_relative_path(worktree_root, project_path, rel)?;
        }
        return Ok(());
    }

    if !is_listed_untracked_file(relative_path, untracked_files) {
        return Err("Path is not an untracked file".to_string());
    }

    trash_worktree_relative_path(worktree_root, project_path, relative_path)
}

fn discard_untracked_file(
    project_path: &str,
    worktree_root: &Path,
    relative_path: &str,
) -> Result<(), String> {
    let worktree_root = worktree_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve git worktree root: {}", e))?;
    let worktree_root_string = path_to_string(&worktree_root)?;
    let untracked_files = list_untracked_files(&worktree_root_string)?;

    discard_untracked_path(
        project_path,
        &worktree_root,
        relative_path,
        &untracked_files,
    )
}

fn list_untracked_files(project_path: &str) -> Result<Vec<String>, String> {
    let output = run_git(
        project_path,
        &[
            "-c",
            "core.quotePath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output
        .stdout
        .split(|b| *b == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).into_owned())
        .collect())
}

/// Discard a single file's pending changes.
///
/// - Untracked files: moved to the system trash.
/// - Tracked unstaged changes: `git restore -- <file>` resets the worktree to the index, leaving
///   any staged half intact (so MM files don't lose their staged portion).
///
/// We deliberately don't expose a "discard staged" path here — staged-only files have no per-row
/// discard button in the UI (matching VSCode), and "Discard All" handles the staged side via
/// `git_discard_all` which correctly undoes renames too.
#[tauri::command]
pub async fn git_discard_file(
    project_path: String,
    repo_path: Option<String>,
    file_path: String,
    untracked: bool,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let worktree_root = git_worktree_root(&cwd)?;
        let worktree_root_string = path_to_string(&worktree_root)?;
        if untracked {
            discard_untracked_file(&cwd, &worktree_root, &file_path)
        } else {
            run_git_check(&worktree_root_string, &["restore", "--", &file_path])
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_discard_files(
    project_path: String,
    repo_path: Option<String>,
    file_paths: Vec<String>,
    untracked: bool,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let file_paths = unique_git_file_paths(file_paths)?;
        if file_paths.is_empty() {
            return Ok(());
        }

        let worktree_root = git_worktree_root(&cwd)?;
        let worktree_root_string = path_to_string(&worktree_root)?;
        if untracked {
            let untracked_files = list_untracked_files(&worktree_root_string)?;
            for file_path in file_paths {
                discard_untracked_path(&cwd, &worktree_root, &file_path, &untracked_files)?;
            }
            return Ok(());
        }

        let mut args = vec!["restore".to_string(), "--".to_string()];
        args.extend(file_paths);
        run_git_check(&worktree_root_string, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_discard_all(
    project_path: String,
    repo_path: Option<String>,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let worktree_root = git_worktree_root(&cwd)?;
        let worktree_root_string = path_to_string(&worktree_root)?;
        // Reset every tracked file (staged + worktree) back to HEAD.
        // Staged-only adds become untracked after this; they are cleaned in the second pass.
        if git_has_head(&worktree_root_string)? {
            run_git_check(
                &worktree_root_string,
                &["restore", "--source=HEAD", "--staged", "--worktree", "."],
            )?;
        } else {
            run_git_check(
                &worktree_root_string,
                &["rm", "-r", "--cached", "--ignore-unmatch", "--", "."],
            )?;
        }

        for rel in list_untracked_files(&worktree_root_string)? {
            if is_protected_worktree_relative_path(&worktree_root, &cwd, &rel) {
                continue;
            }
            trash_worktree_relative_path(&worktree_root, &cwd, &rel)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_show_file_diff(
    project_path: String,
    repo_path: Option<String>,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let output = run_git(&cwd, &["show", "--format=", &commit_hash, "--", &file_path])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let raw = output.stdout;
    let limit = 500 * 1024;
    Ok(String::from_utf8_lossy(if raw.len() > limit {
        &raw[..limit]
    } else {
        &raw
    })
    .into_owned())
}

#[tauri::command]
pub async fn git_push(
    project_path: String,
    repo_path: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let mut args = vec!["push".to_string()];
    if let Some(ref b) = branch.filter(|s| !s.is_empty()) {
        args.push("origin".to_string());
        args.push(b.clone());
    }
    let output = run_git(&cwd, &args)?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(combined);
    }
    Ok(combined.trim().to_string())
}

#[tauri::command]
pub async fn git_pull(project_path: String, repo_path: Option<String>) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let output = run_git(&cwd, &["pull"])?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(combined);
    }
    Ok(combined.trim().to_string())
}

#[derive(serde::Serialize)]
pub(crate) struct GitRemoteCounts {
    ahead: i32,
    behind: i32,
    branch: String,
}

#[tauri::command]
pub async fn git_remote_counts(
    project_path: String,
    repo_path: Option<String>,
    branch: Option<String>,
) -> Result<GitRemoteCounts, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let branch = if let Some(b) = branch.filter(|s| !s.is_empty()) {
        b
    } else {
        let branch_out = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        String::from_utf8_lossy(&branch_out.stdout)
            .trim()
            .to_string()
    };

    let rev_str = format!("{}...@{{u}}", branch);
    let rev_out = run_git(&cwd, &["rev-list", "--count", "--left-right", &rev_str]);

    let (ahead, behind) = match rev_out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let parts: Vec<&str> = s.split_whitespace().collect();
            if parts.len() == 2 {
                (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
            } else {
                (0, 0)
            }
        }
        _ => (0, 0),
    };

    Ok(GitRemoteCounts {
        ahead,
        behind,
        branch,
    })
}

// ── Task worktree management ─────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub(crate) struct WorktreeCreated {
    #[serde(rename = "worktreePath")]
    worktree_path: String,
    #[serde(rename = "worktreeBranch")]
    worktree_branch: String,
    #[serde(rename = "baseBranch")]
    base_branch: String,
}

fn task_worktree_branch_name(task_id: &str) -> String {
    let short = if task_id.len() > 6 {
        &task_id[task_id.len() - 6..]
    } else {
        task_id
    };
    format!("nezha/task-{}", short)
}

/// 默认 worktree 基路径：若项目父目录存在「可执行程序」（共享 hub 模式），自动用父目录作为
/// 基路径（worktree 落成 `<父目录>/<task_id>`，使相对 HintPath 能解析到共享 hub）；
/// 否则回退到 `<项目根>/.nezha/worktrees`（向后兼容）。
fn default_worktree_base(repo_root: &str) -> PathBuf {
    let root = Path::new(repo_root);
    if let Some(parent) = root.parent() {
        if parent.join("可执行程序").is_dir() {
            return parent.to_path_buf();
        }
    }
    root.join(".nezha").join("worktrees")
}

/// 计算 worktree 落盘基路径：项目配置优先，否则自动探测共享 hub / 项目内 .nezha/worktrees。
/// 配置永远从项目根读取（多 sub-repo 时配置在项目根 `.nezha/config.toml`）。
pub(crate) fn worktree_base_dir(project_path: &str, repo_root: &str) -> PathBuf {
    let cfg = crate::config::read_project_config(project_path.to_string())
        .unwrap_or_else(|_| crate::config::ProjectConfig::default());
    if !cfg.worktree.base_path.trim().is_empty() {
        PathBuf::from(cfg.worktree.base_path.trim())
    } else {
        default_worktree_base(repo_root)
    }
}

/// 校验 worktree 路径必须落在配置/自动规则解析出的 worktree 根目录之下，
/// 防止 delete/open 命令被传入任意路径。
pub(crate) fn ensure_path_under_worktrees_root(
    project_path: &str,
    repo_root: &str,
    worktree_path: &str,
) -> Result<(), String> {
    let expected_root = worktree_base_dir(project_path, repo_root);
    let target = Path::new(worktree_path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve worktree path: {}", e))?;
    if !target.starts_with(&expected_root) {
        return Err("Worktree path is outside the configured worktree root".to_string());
    }
    Ok(())
}

/// 返回 worktree 是否含“非 `_run` 生成件”的未提交/未跟踪内容。
/// 仅根目录下未跟踪的 `_run`（或 `_run/**`）视为生成运行根，不 block；其余全部 block。
pub(crate) fn worktree_dirty_reason(worktree_path: &str) -> Result<Option<String>, String> {
    let output = run_git(
        worktree_path,
        &[
            "-c",
            "core.quotePath=false",
            "status",
            "--porcelain",
            "--untracked-files=all",
        ],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.len() < 4 || line.as_bytes().get(2) != Some(&b' ') {
            continue;
        }
        let status = &line[..2];
        let path = &line[3..];
        if status == "??" {
            let trimmed = path.trim_matches('"');
            if trimmed == "_run" || trimmed.starts_with("_run/") {
                continue;
            }
        }
        return Ok(Some(line.to_string()));
    }
    Ok(None)
}

/// 远端是否存在某个分支（live `git ls-remote`，不用本地 stale remote-tracking ref）。
pub(crate) async fn remote_branch_exists(
    project_path: String,
    repo_path: Option<String>,
    branch: String,
) -> Result<bool, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    tokio::task::spawn_blocking(move || {
        let output = run_git(
            &cwd,
            &[
                "ls-remote",
                "--heads",
                "origin",
                &format!("refs/heads/{branch}"),
            ],
        )?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(!stdout.trim().is_empty())
    })
    .await
    .map_err(|e| format!("Remote branch check task panicked: {}", e))?
}

/// 本地是否存在某个分支。
pub(crate) async fn local_branch_exists(
    project_path: String,
    repo_path: Option<String>,
    branch: String,
) -> Result<bool, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    tokio::task::spawn_blocking(move || {
        let output = run_git(
            &cwd,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )?;
        Ok(output.status.success())
    })
    .await
    .map_err(|e| format!("Local branch check task panicked: {}", e))?
}

/// 统计源分支相对远端目标分支未合并的提交数（先 fetch，保证以远端为准）。
pub(crate) async fn branch_unmerged_count(
    cwd: String,
    target_branch: String,
    source_branch: String,
) -> Result<u64, String> {
    let target = target_branch.clone();
    let source = source_branch.clone();
    tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let fetch_target = run_git(&cwd, &["fetch", "origin", &target])?;
        if !fetch_target.status.success() {
            return Err(String::from_utf8_lossy(&fetch_target.stderr)
                .trim()
                .to_string());
        }
        // 源分支可能尚未推送到远端：允许 fetch 失败（忽略“couldn't find remote ref”）。
        if let Ok(fetch_source) = run_git(&cwd, &["fetch", "origin", &source]) {
            if !fetch_source.status.success() {
                let stderr = String::from_utf8_lossy(&fetch_source.stderr)
                    .trim()
                    .to_string();
                if !stderr.to_lowercase().contains("find remote ref") {
                    return Err(stderr);
                }
            }
        }
        let rev = format!("origin/{target}..{source}");
        let out = run_git(&cwd, &["rev-list", "--count", &rev])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let count = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u64>()
            .unwrap_or(0);
        Ok(count)
    })
    .await
    .map_err(|e| format!("Unmerged commit check task panicked: {}", e))?
}

/// 统计远端源分支相对远端目标分支未合并的提交数；本地分支缺失时仍用于安全清理校验。
pub(crate) async fn remote_branch_unmerged_count(
    cwd: String,
    target_branch: String,
    source_branch: String,
) -> Result<u64, String> {
    let target = target_branch.clone();
    let source = source_branch.clone();
    tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let fetch_target = run_git(&cwd, &["fetch", "origin", &target])?;
        if !fetch_target.status.success() {
            return Err(String::from_utf8_lossy(&fetch_target.stderr)
                .trim()
                .to_string());
        }
        let fetch_source = run_git(&cwd, &["fetch", "origin", &source])?;
        if !fetch_source.status.success() {
            return Err(String::from_utf8_lossy(&fetch_source.stderr)
                .trim()
                .to_string());
        }

        let rev = format!("origin/{target}..origin/{source}");
        let out = run_git(&cwd, &["rev-list", "--count", &rev])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u64>()
            .map_err(|e| format!("解析未合并提交数量失败: {e}"))
    })
    .await
    .map_err(|e| format!("Remote branch unmerged count task panicked: {e}"))?
}

#[tauri::command]
pub async fn create_task_worktree(
    project_path: String,
    repo_path: Option<String>,
    task_id: String,
    base_branch: String,
) -> Result<WorktreeCreated, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    if task_id.trim().is_empty() {
        return Err("Task id is required".to_string());
    }
    if base_branch.trim().is_empty() {
        return Err("Base branch is required".to_string());
    }

    tokio::task::spawn_blocking(move || -> Result<WorktreeCreated, String> {
        let worktrees_dir = worktree_base_dir(&project_path, &cwd);
        std::fs::create_dir_all(&worktrees_dir)
            .map_err(|e| format!("Failed to create worktrees dir: {}", e))?;

        let worktree_path = worktrees_dir.join(&task_id);
        if worktree_path.exists() {
            return Err(format!(
                "Worktree path already exists: {}",
                worktree_path.display()
            ));
        }

        let wt_path_str = path_to_string(&worktree_path)?;
        let branch = task_worktree_branch_name(&task_id);

        let output = run_git(
            &cwd,
            &["worktree", "add", &wt_path_str, "-b", &branch, &base_branch],
        )?;
        if !output.status.success() {
            // 回滚：worktree add 失败可能已创建分支 ref 或半成品目录。
            let _ = run_git(&cwd, &["branch", "-D", &branch]);
            let _ = run_git(&cwd, &["worktree", "prune"]);
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        Ok(WorktreeCreated {
            worktree_path: wt_path_str,
            worktree_branch: branch,
            base_branch,
        })
    })
    .await
    .map_err(|e| format!("Worktree task panicked: {}", e))?
}

#[tauri::command]
pub async fn merge_task_worktree(
    project_path: String,
    repo_path: Option<String>,
    _worktree_path: String,
    branch: String,
    base_branch: String,
    expected_issue_tag: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    if branch.trim().is_empty() || base_branch.trim().is_empty() {
        return Err("Branch and base branch are required".to_string());
    }

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        // 用任务分支建一次性的 detached worktree（干净），保证校验/合并不依赖长期
        // 开发 worktree（含 `_run`、prepare 等未提交内容，也因此不再卡住合并）。
        let temp_dir = std::path::Path::new(&cwd).join(".nezha").join("worktrees");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("创建临时 worktree 目录失败: {e}"))?;
        let temp = temp_dir.join(format!("merge-prep-{}", branch.replace('/', "-")));
        let temp_str = path_to_string(&temp)?;
        // 清掉可能残留的同名临时 worktree。
        let _ = run_git(&cwd, &["worktree", "remove", "--force", &temp_str]);
        let add = run_git(&cwd, &["worktree", "add", "--detach", &temp_str, &branch])?;
        if !add.status.success() {
            return Err(format!(
                "创建临时 merge worktree 失败: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            ));
        }

        let outcome = (|| -> Result<String, String> {
            // 云效任务：合并前校验分支内全部提交都带 #议题编号。
            if let Some(tag) = expected_issue_tag
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                validate_commits_contain_tag(&cwd, &base_branch, &branch, tag)?;
            }
            let head_out = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
            if !head_out.status.success() {
                return Err(String::from_utf8_lossy(&head_out.stderr).trim().to_string());
            }
            let original_branch = String::from_utf8_lossy(&head_out.stdout).trim().to_string();
            if original_branch == base_branch {
                // 主仓正在 base 上，直接合并（保留 merge commit 让历史可追溯）。
                let merge_out = run_git(&cwd, &["merge", "--no-ff", &branch])?;
                let combined = format!(
                    "{}{}",
                    String::from_utf8_lossy(&merge_out.stdout),
                    String::from_utf8_lossy(&merge_out.stderr)
                );
                if !merge_out.status.success() {
                    return Err(format!(
                        "Merge failed (main repo on '{}'; please resolve manually): {}",
                        base_branch, combined
                    ));
                }
                return Ok(combined.trim().to_string());
            }
            // 主仓不在 base：用 `git fetch . <src>:<dst>` 把任务分支 ff 到 base ref，不动主仓 HEAD。
            let refspec = format!("{}:{}", branch, base_branch);
            let ff_out = run_git(&cwd, &["fetch", ".", &refspec])?;
            if !ff_out.status.success() {
                let err = String::from_utf8_lossy(&ff_out.stderr);
                return Err(format!(
                    "Cannot fast-forward '{}' (task branch may have diverged from base). \
                     Pull base into the task branch and retry, or merge manually. Detail: {}",
                    base_branch,
                    err.trim()
                ));
            }
            Ok(format!("Fast-forwarded '{}' to '{}'", base_branch, branch))
        })();

        // 无论成功与否都清理临时 worktree。
        let _ = run_git(&cwd, &["worktree", "remove", "--force", &temp_str]);
        outcome
    })
    .await
    .map_err(|e| format!("Merge task panicked: {}", e))?
}

#[tauri::command]
pub async fn remove_task_worktree(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let project = project_path.clone();
    let current = cwd.clone();
    ensure_path_under_worktrees_root(&project, &current, &worktree_path)?;

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // worktree remove --force 既可移除有未提交修改的工作树，也会清理元数据。
        let remove_out = run_git(&cwd, &["worktree", "remove", "--force", &worktree_path])?;
        if !remove_out.status.success() {
            return Err(String::from_utf8_lossy(&remove_out.stderr)
                .trim()
                .to_string());
        }

        if !branch.trim().is_empty() {
            // -D 允许删除未合并分支（丢弃语义）。已合并分支也能成功。
            let branch_out = run_git(&cwd, &["branch", "-D", &branch])?;
            if !branch_out.status.success() {
                return Err(String::from_utf8_lossy(&branch_out.stderr)
                    .trim()
                    .to_string());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Remove worktree task panicked: {}", e))?
}

#[derive(serde::Serialize)]
pub(crate) struct WorktreeDiffStats {
    pub additions: i32,
    pub deletions: i32,
}

/// 计算 worktree 工作树（含未提交改动 + 未跟踪文件）相对于 `base_branch` 与 HEAD 的 merge-base 的 +/− 行数。
/// 用 merge-base 而非 base_branch 本身，避免主仓 base 推进后把别人提交的改动算到本任务头上。
#[tauri::command]
pub async fn worktree_diff_stats(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
    base_branch: String,
) -> Result<WorktreeDiffStats, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    if base_branch.trim().is_empty() {
        return Err("Base branch is required".to_string());
    }

    tokio::task::spawn_blocking(move || -> Result<WorktreeDiffStats, String> {
        // 路径校验包含同步 canonicalize，必须留在 spawn_blocking 内，避免阻塞 Tokio 运行时。
        ensure_path_under_worktrees_root(&project_path, &cwd, &worktree_path)?;

        // 1) 已跟踪改动（含已 stage / 未 stage）：working tree vs merge-base
        let mb_out = run_git(&worktree_path, &["merge-base", &base_branch, "HEAD"])?;
        if !mb_out.status.success() {
            return Err(String::from_utf8_lossy(&mb_out.stderr).trim().to_string());
        }
        let merge_base = String::from_utf8_lossy(&mb_out.stdout).trim().to_string();

        let mut additions = 0i32;
        let mut deletions = 0i32;

        if !merge_base.is_empty() {
            let num_out = run_git(&worktree_path, &["diff", "--numstat", &merge_base])?;
            if !num_out.status.success() {
                return Err(String::from_utf8_lossy(&num_out.stderr).trim().to_string());
            }
            accumulate_numstat(&num_out.stdout, &mut additions, &mut deletions);
        }

        // 2) 未跟踪文件：git diff 不会列出，需要逐个用 --no-index 与空文件比对
        let untracked = list_untracked_files(&worktree_path)?;
        if !untracked.is_empty() {
            let empty_file = create_empty_temp_file()?;
            let empty_path = empty_file.to_string_lossy().into_owned();
            for rel in &untracked {
                let abs = Path::new(&worktree_path).join(rel);
                let abs_str = abs.to_string_lossy().into_owned();
                // git diff --no-index 在文件不同时返回退出码 1，故不能用 status 判断成败
                let no_index = run_git(
                    &worktree_path,
                    &["diff", "--no-index", "--numstat", &empty_path, &abs_str],
                )?;
                accumulate_numstat(&no_index.stdout, &mut additions, &mut deletions);
            }
            let _ = std::fs::remove_file(&empty_file);
        }

        Ok(WorktreeDiffStats {
            additions,
            deletions,
        })
    })
    .await
    .map_err(|e| format!("Diff stats task panicked: {}", e))?
}

/// 解析 `git diff --numstat` 输出累加 +/− 行数。
/// numstat 对二进制文件输出 `-\t-\t<path>`，parse 失败时按 0 跳过。
fn accumulate_numstat(stdout: &[u8], additions: &mut i32, deletions: &mut i32) {
    for line in String::from_utf8_lossy(stdout).lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() != 3 {
            continue;
        }
        *additions += parts[0].parse::<i32>().unwrap_or(0);
        *deletions += parts[1].parse::<i32>().unwrap_or(0);
    }
}

/// 分支间 diff（base...branch）的单文件增减行数（供合并 Diff 文件列表）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DiffFileStat {
    pub path: String,
    pub additions: i32,
    pub deletions: i32,
}

fn parse_diff_numstat(stdout: &[u8]) -> Vec<DiffFileStat> {
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() != 3 {
            continue;
        }
        files.push(DiffFileStat {
            path: parts[2].to_string(),
            additions: parts[0].parse::<i32>().unwrap_or(0),
            deletions: parts[1].parse::<i32>().unwrap_or(0),
        });
    }
    files
}

fn ensure_relative_file_path(file_path: &str) -> Result<(), String> {
    if file_path.trim().is_empty() {
        return Err("File path is required".to_string());
    }
    let path = Path::new(file_path);
    if path.is_absolute() || file_path.split('/').any(|seg| seg == "..") {
        return Err("Invalid file path".to_string());
    }
    Ok(())
}

/// 计算 base 与任意分支之间的 diff（base...branch 三点 diff，等价于相对 merge-base）。
fn git_branch_diff_stats_blocking(
    cwd: &str,
    base_branch: &str,
    branch: &str,
) -> Result<Vec<DiffFileStat>, String> {
    let spec = format!("{}...{}", base_branch.trim(), branch.trim());
    let output = run_git(cwd, &["diff", "--numstat", &spec])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(parse_diff_numstat(&output.stdout))
}

#[tauri::command]
pub async fn git_branch_diff_stats(
    project_path: String,
    repo_path: Option<String>,
    base_branch: String,
    branch: String,
) -> Result<Vec<DiffFileStat>, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    if base_branch.trim().is_empty() || branch.trim().is_empty() {
        return Err("baseBranch and branch are required".to_string());
    }
    tokio::task::spawn_blocking(move || git_branch_diff_stats_blocking(&cwd, &base_branch, &branch))
        .await
        .map_err(|e| format!("Diff stats task panicked: {}", e))?
}

/// 获取 base 与任意分支之间某个文件的统一 diff 文本。
#[tauri::command]
pub async fn git_branch_diff_file(
    project_path: String,
    repo_path: Option<String>,
    base_branch: String,
    branch: String,
    file_path: String,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    if base_branch.trim().is_empty() || branch.trim().is_empty() {
        return Err("baseBranch and branch are required".to_string());
    }
    ensure_relative_file_path(&file_path)?;
    tokio::task::spawn_blocking(move || {
        let spec = format!("{}...{}", base_branch.trim(), branch.trim());
        let output = run_git(&cwd, &["diff", &spec, "--", &file_path])?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let raw = String::from_utf8_lossy(&output.stdout).into_owned();
        let limit = 500 * 1024;
        if raw.len() > limit {
            Ok(raw.chars().take(limit).collect())
        } else {
            Ok(raw)
        }
    })
    .await
    .map_err(|e| format!("Diff file task panicked: {}", e))?
}

/// 补丁挑拣依赖预检的规划结果：requested commit 及其尚未在目标分支上的前置 commit（含自身）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PatchPickPlan {
    pub commit: String,
    pub already_on_target: bool,
    pub needed: Vec<String>,
}

/// 对每个请求的 commit，用 `git rev-list <commit> --not HEAD --reverse` 计算需要挑拣的
/// 依赖序（最旧在前）；已存在于目标分支（HEAD 祖先）则标记 already_on_target 且 needed 为空。
fn patch_pick_plan_blocking(
    cwd: &str,
    commit_hashes: &[String],
) -> Result<Vec<PatchPickPlan>, String> {
    let mut plans = Vec::new();
    for hash in commit_hashes {
        let h = hash.trim();
        if h.is_empty() {
            continue;
        }
        let output = run_git(cwd, &["rev-list", h, "--not", "HEAD", "--reverse"])?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let needed: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        plans.push(PatchPickPlan {
            commit: h.to_string(),
            already_on_target: needed.is_empty(),
            needed,
        });
    }
    Ok(plans)
}

/// 挑拣前依赖预检：返回每个请求 commit 的“是否已在目标 + 需要的依赖序”，供前端提示“连带挑前置”。
#[tauri::command]
pub async fn git_patch_dependency_check(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
    commit_hashes: Vec<String>,
) -> Result<Vec<PatchPickPlan>, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    ensure_path_under_worktrees_root(&project_path, &cwd, &worktree_path)?;
    tokio::task::spawn_blocking(move || patch_pick_plan_blocking(&worktree_path, &commit_hashes))
        .await
        .map_err(|e| format!("Patch check task panicked: {}", e))?
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CherryPickConflict {
    pub commit: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CherryPickResult {
    pub picked: Vec<String>,
    pub skipped: Vec<String>,
    pub conflicted: Option<CherryPickConflict>,
}

/// 把若干 commit 按依赖顺序 `git cherry-pick -x` 到补丁（当前）工作区。
/// 挑到冲突时停止并返回冲突，让前端可交给「用 Agent 解决冲突」入口。
#[tauri::command]
pub async fn cherry_pick_to_patch(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
    commit_hashes: Vec<String>,
) -> Result<CherryPickResult, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    ensure_path_under_worktrees_root(&project_path, &cwd, &worktree_path)?;
    tokio::task::spawn_blocking(move || {
        let plans = patch_pick_plan_blocking(&worktree_path, &commit_hashes)?;
        let skipped = plans
            .iter()
            .filter(|p| p.already_on_target)
            .map(|p| p.commit.clone())
            .collect::<Vec<_>>();
        // 按依赖序（最旧在前）去重合并所有需要的 commit。
        let mut order: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for plan in &plans {
            for commit in &plan.needed {
                if seen.insert(commit.clone()) {
                    order.push(commit.clone());
                }
            }
        }
        let mut picked = Vec::new();
        for commit in &order {
            let output = run_git(&worktree_path, &["cherry-pick", "-x", commit])?;
            if !output.status.success() {
                return Ok(CherryPickResult {
                    picked,
                    skipped,
                    conflicted: Some(CherryPickConflict {
                        commit: commit.clone(),
                        message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                    }),
                });
            }
            picked.push(commit.clone());
        }
        Ok(CherryPickResult {
            picked,
            skipped,
            conflicted: None,
        })
    })
    .await
    .map_err(|e| format!("Cherry pick task panicked: {}", e))?
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PatchPickEntry {
    pub source_commit: String,
    pub picked_commit: String,
    pub message: String,
    pub target_branch: String,
}

/// 解析 `git log` 输出（format: %H%x00%s%x00%b%x1e），抽取带 `cherry-pick -x` 来源的提交。
fn parse_patch_pick_entries(stdout: &[u8], target_branch: &str) -> Vec<PatchPickEntry> {
    let mut entries = Vec::new();
    for record in String::from_utf8_lossy(stdout).split('\u{1e}') {
        if record.trim().is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, '\u{0}');
        let hash = parts.next().unwrap_or("").trim().to_string();
        let subject = parts.next().unwrap_or("").to_string();
        let body = parts.next().unwrap_or("").to_string();
        if hash.is_empty() {
            continue;
        }
        // `cherry-pick -x` 会在 commit 体追加 `(cherry picked from commit <sha>)`。
        let marker = "(cherry picked from commit ";
        if let Some(pos) = body.rfind(marker) {
            let tail = &body[pos + marker.len()..];
            let source: String = tail
                .chars()
                .take_while(|c| c.is_ascii_hexdigit() || *c == '\n' || *c == ')')
                .filter(|c| *c != '\n' && *c != ')')
                .take(40)
                .collect();
            if source.len() == 40 {
                entries.push(PatchPickEntry {
                    source_commit: source,
                    picked_commit: hash,
                    message: subject,
                    target_branch: target_branch.to_string(),
                });
            }
        }
    }
    entries
}

fn list_patch_picks_blocking(cwd: &str) -> Result<Vec<PatchPickEntry>, String> {
    let branch_out = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !branch_out.status.success() {
        return Err(String::from_utf8_lossy(&branch_out.stderr)
            .trim()
            .to_string());
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    let out = run_git(cwd, &["log", "--reverse", "--format=%H%x00%s%x00%b%x1e"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(parse_patch_pick_entries(&out.stdout, &branch))
}

/// 列出当前补丁分支上所有 `cherry-pick -x` 的来源（commit ↔ 版本矩阵的依据）。
#[tauri::command]
pub async fn list_patch_picks(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
) -> Result<Vec<PatchPickEntry>, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    ensure_path_under_worktrees_root(&project_path, &cwd, &worktree_path)?;
    tokio::task::spawn_blocking(move || list_patch_picks_blocking(&worktree_path))
        .await
        .map_err(|e| format!("List patch picks task panicked: {}", e))?
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConflictContext {
    pub conflicted_files: Vec<String>,
    pub prompt: String,
}

/// 从 `git status --porcelain` 输出中提取处于合并冲突状态的文件（XY 含 'U' 或 AA/DD）。
pub(crate) fn parse_conflicted_files(stdout: &[u8]) -> Vec<String> {
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        if line.len() < 4 || line.as_bytes()[2] != b' ' {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        let path = &line[3..];
        let conflicted = (x == 'U' || y == 'U') || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
        if conflicted {
            files.push(path.trim().to_string());
        }
    }
    files
}

const CONFLICT_RESOLUTION_INSTRUCTIONS: &str = r#"你是合并冲突解决助手。请读取以下合并冲突上下文，产出解决方案。

约束：
1. 只解决冲突，不要改动无关代码。
2. 判定哪份是权威（结合两侧分支的意图与 #议题 提交说明）；无法判定时列出两种方案及建议。
3. 解决流程：修改冲突文件 → git add → 保留 git 冲突标记已清除。
4. 输出：简明说明每处冲突如何解决 + 改动的文件清单。不要在此提交。"#;

/// 获取补丁（当前）工作区的合并冲突上下文，供「用 Agent 解决冲突」入口组装 prompt。
#[tauri::command]
pub async fn get_conflict_context(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
) -> Result<ConflictContext, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    ensure_path_under_worktrees_root(&project_path, &cwd, &worktree_path)?;
    tokio::task::spawn_blocking(move || {
        let status = run_git(&worktree_path, &["status", "--porcelain"])?;
        if !status.status.success() {
            return Err(String::from_utf8_lossy(&status.stderr).trim().to_string());
        }
        let files = parse_conflicted_files(&status.stdout);
        let files_list = files.join(", ");
        let prompt = format!(
            "{}\n──── 冲突文件 ────\n{}\n──── 冲突状态 ────\n{}",
            CONFLICT_RESOLUTION_INSTRUCTIONS,
            files_list,
            String::from_utf8_lossy(&status.stdout).trim()
        );
        Ok(ConflictContext {
            conflicted_files: files,
            prompt,
        })
    })
    .await
    .map_err(|e| format!("Conflict context task panicked: {}", e))?
}

/// 在 Agent 解决冲突后，暂存全部改动并提交（带可选的 #议题 tag）。
#[tauri::command]
pub async fn commit_conflict_resolution(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
    message: String,
    expected_issue_tag: Option<String>,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    ensure_path_under_worktrees_root(&project_path, &cwd, &worktree_path)?;
    if message.trim().is_empty() {
        return Err("Commit message is required".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let add = run_git(&worktree_path, &["add", "-A"])?;
        if !add.status.success() {
            return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
        }
        let mut msg = message.trim().to_string();
        if let Some(tag) = expected_issue_tag
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            msg = format!("{msg} {tag}");
        }
        let commit = run_git(&worktree_path, &["commit", "-m", &msg])?;
        if !commit.status.success() {
            return Err(String::from_utf8_lossy(&commit.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&commit.stdout).trim().to_string())
    })
    .await
    .map_err(|e| format!("Commit conflict task panicked: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::{
        build_commit_message_agent_args, dir_is_git_repo, discover_git_roots_blocking,
        git_has_head, git_worktree_root, is_protected_project_relative_path, list_untracked_files,
        parse_porcelain_z_status, path_to_string, resolve_repo_path_blocking, run_git_check,
        untracked_files_under_directory, GitFileChange,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
    };

    struct TempRepo {
        path: PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("nezha-git-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            let output = Command::new("git").arg("init").arg(&path).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            Self { path }
        }

        fn path_string(&self) -> String {
            path_to_string(&self.path.canonicalize().unwrap()).unwrap()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn parses_untracked_path_with_spaces_without_quotes() {
        let changes = parse_porcelain_z_status(b"?? te st2.txt\0");

        assert_eq!(
            changes,
            vec![GitFileChange {
                path: "te st2.txt".to_string(),
                status: "?".to_string(),
                staged: false,
            }]
        );
    }

    #[test]
    fn parses_staged_and_unstaged_changes_for_same_path() {
        let changes = parse_porcelain_z_status(b"MM src/file name.ts\0");

        assert_eq!(
            changes,
            vec![
                GitFileChange {
                    path: "src/file name.ts".to_string(),
                    status: "M".to_string(),
                    staged: true,
                },
                GitFileChange {
                    path: "src/file name.ts".to_string(),
                    status: "M".to_string(),
                    staged: false,
                },
            ]
        );
    }

    #[test]
    fn parses_rename_destination_and_skips_source_path() {
        let changes = parse_porcelain_z_status(b"R  new name.txt\0old name.txt\0");

        assert_eq!(
            changes,
            vec![GitFileChange {
                path: "new name.txt".to_string(),
                status: "R".to_string(),
                staged: true,
            }]
        );
    }

    #[test]
    fn detects_protected_project_metadata_paths() {
        assert!(is_protected_project_relative_path(".nezha/config.toml"));
        assert!(is_protected_project_relative_path("./.git/index"));
        assert!(is_protected_project_relative_path(
            ".Nezha/attachments/file.png"
        ));
        assert!(!is_protected_project_relative_path(
            "src/.nezha/config.toml"
        ));
        assert!(!is_protected_project_relative_path(".gitignore"));
        assert!(!is_protected_project_relative_path("src/git.rs"));
    }

    #[test]
    fn lists_only_untracked_files_under_requested_directory() {
        let untracked_files = vec![
            "dir/file.txt".to_string(),
            "dir/nested/other.txt".to_string(),
            "dir2/file.txt".to_string(),
            "other.txt".to_string(),
        ];

        assert_eq!(
            untracked_files_under_directory("dir/", &untracked_files),
            vec!["dir/file.txt", "dir/nested/other.txt"]
        );
    }

    #[test]
    fn resolves_worktree_root_for_nested_project_paths() {
        let repo = TempRepo::new();
        let nested_project = repo.path.join("nested/project");
        fs::create_dir_all(&nested_project).unwrap();

        let resolved = git_worktree_root(nested_project.to_str().unwrap()).unwrap();

        assert_eq!(resolved, repo.path.canonicalize().unwrap());
    }

    #[test]
    fn resolve_repo_path_falls_back_to_project_when_omitted() {
        let repo = TempRepo::new();
        let project_path = repo.path_string();
        let resolved = resolve_repo_path_blocking(&project_path, None).unwrap();
        assert_eq!(resolved, project_path);

        // Empty string treated as None (前端传 "" 时不应当作真有效路径).
        let resolved_empty = resolve_repo_path_blocking(&project_path, Some("")).unwrap();
        assert_eq!(resolved_empty, project_path);
    }

    #[test]
    fn resolve_repo_path_accepts_sub_path_inside_project() {
        let project_dir =
            std::env::temp_dir().join(format!("nezha-resolve-test-{}", uuid::Uuid::new_v4()));
        let sub_dir = project_dir.join("sub-repo");
        fs::create_dir_all(&sub_dir).unwrap();
        let project_str = path_to_string(&project_dir.canonicalize().unwrap()).unwrap();
        let sub_str = path_to_string(&sub_dir.canonicalize().unwrap()).unwrap();

        let resolved = resolve_repo_path_blocking(&project_str, Some(&sub_str)).unwrap();
        assert_eq!(resolved, sub_str);

        let _ = fs::remove_dir_all(&project_dir);
    }

    #[test]
    fn resolve_repo_path_rejects_path_outside_project() {
        let project_dir =
            std::env::temp_dir().join(format!("nezha-resolve-test-{}", uuid::Uuid::new_v4()));
        let outside_dir =
            std::env::temp_dir().join(format!("nezha-outside-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&project_dir).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();
        let project_str = path_to_string(&project_dir.canonicalize().unwrap()).unwrap();
        let outside_str = path_to_string(&outside_dir.canonicalize().unwrap()).unwrap();

        let result = resolve_repo_path_blocking(&project_str, Some(&outside_str));
        assert!(
            result.is_err(),
            "outside-project repo path should be rejected"
        );

        let _ = fs::remove_dir_all(&project_dir);
        let _ = fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn discovers_a_git_project_as_the_root_repository() {
        let repo = TempRepo::new();
        let project_path = repo.path_string();

        let roots = discover_git_roots_blocking(&project_path).unwrap();

        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].path, project_path);
        assert_eq!(roots[0].name, ".");
        assert!(roots[0].is_root);
    }

    #[test]
    fn discovers_only_visible_first_level_repositories_in_name_order() {
        let project_dir =
            std::env::temp_dir().join(format!("nezha-discover-test-{}", uuid::Uuid::new_v4()));
        for relative in [
            "zeta/.git",
            "alpha/.git",
            ".hidden/.git",
            "node_modules/pkg/.git",
        ] {
            fs::create_dir_all(project_dir.join(relative)).unwrap();
        }
        fs::create_dir_all(project_dir.join("plain-directory")).unwrap();
        let project_path = path_to_string(&project_dir.canonicalize().unwrap()).unwrap();

        let roots = discover_git_roots_blocking(&project_path).unwrap();

        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].name, "alpha");
        assert_eq!(
            roots[0].path,
            Path::new(&project_path).join("alpha").to_str().unwrap()
        );
        assert!(!roots[0].is_root);
        assert_eq!(roots[1].name, "zeta");
        assert_eq!(
            roots[1].path,
            Path::new(&project_path).join("zeta").to_str().unwrap()
        );
        assert!(!roots[1].is_root);

        let _ = fs::remove_dir_all(&project_dir);
    }

    #[cfg(unix)]
    #[test]
    fn discover_git_roots_skips_repositories_reached_through_external_symlinks() {
        use std::os::unix::fs::symlink;

        let project_dir =
            std::env::temp_dir().join(format!("nezha-discover-project-{}", uuid::Uuid::new_v4()));
        let outside_repo =
            std::env::temp_dir().join(format!("nezha-discover-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&project_dir).unwrap();
        fs::create_dir_all(outside_repo.join(".git")).unwrap();
        symlink(&outside_repo, project_dir.join("external-repo")).unwrap();
        let project_path = path_to_string(&project_dir.canonicalize().unwrap()).unwrap();

        let roots = discover_git_roots_blocking(&project_path).unwrap();

        assert!(roots.is_empty());

        let _ = fs::remove_dir_all(&project_dir);
        let _ = fs::remove_dir_all(&outside_repo);
    }

    #[test]
    fn dir_is_git_repo_detects_both_dot_git_dir_and_file() {
        let repo = TempRepo::new();
        assert!(dir_is_git_repo(&repo.path));

        // Worktree case: .git is a file rather than directory.
        let worktree_like =
            std::env::temp_dir().join(format!("nezha-worktree-dir-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&worktree_like).unwrap();
        fs::write(worktree_like.join(".git"), "gitdir: /tmp/elsewhere\n").unwrap();
        assert!(dir_is_git_repo(&worktree_like));

        let plain =
            std::env::temp_dir().join(format!("nezha-non-git-dir-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&plain).unwrap();
        assert!(!dir_is_git_repo(&plain));

        let _ = fs::remove_dir_all(&worktree_like);
        let _ = fs::remove_dir_all(&plain);
    }

    #[test]
    fn unborn_repository_can_prepare_staged_files_for_untracked_cleanup() {
        let repo = TempRepo::new();
        let repo_path = repo.path_string();
        fs::write(repo.path.join("new-file.txt"), "content").unwrap();

        assert!(!git_has_head(&repo_path).unwrap());
        run_git_check(&repo_path, &["add", "new-file.txt"]).unwrap();
        run_git_check(
            &repo_path,
            &["rm", "-r", "--cached", "--ignore-unmatch", "--", "."],
        )
        .unwrap();

        assert_eq!(
            list_untracked_files(&repo_path).unwrap(),
            vec!["new-file.txt".to_string()]
        );
    }

    #[test]
    fn commit_message_args_include_light_model_and_effort() {
        let args =
            build_commit_message_agent_args("claude", "msg", Some("fast-model"), Some("low"));
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(args.windows(2).any(|w| w == ["--model", "fast-model"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "low"]));

        let args =
            build_commit_message_agent_args("codex", "msg", Some("fast-model"), Some("high"));
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(args.windows(2).any(|w| w == ["--model", "fast-model"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["-c", "model_reasoning_effort=\"high\""]));
        assert_eq!(args.last(), Some(&"msg"));
    }

    #[test]
    fn commit_message_args_without_light_config_match_previous_flags() {
        let args = build_commit_message_agent_args("claude", "msg", None, None);
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(args, vec!["-p", "msg", "--output-format", "text"]);

        let args = build_commit_message_agent_args("codex", "msg", None, None);
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(args, vec!["exec", "msg"]);
    }

    #[test]
    fn branch_diff_stats_counts_additions_and_deletions() {
        let dir = std::env::temp_dir().join(format!("nezha-branch-diff-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.to_string_lossy().into_owned();
        let run = |args: &[&str]| {
            let mut cmd = Command::new("git");
            cmd.args(args).current_dir(&dir);
            let out = cmd.output().unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        run(&["checkout", "-q", "-b", "base"]);
        fs::write(dir.join("a.txt"), "line1\nline2\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "base"]);
        run(&["checkout", "-q", "-b", "feature/x"]);
        fs::write(dir.join("a.txt"), "line1\nline2\nline3\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "change"]);
        let stats = super::git_branch_diff_stats_blocking(&dir_str, "base", "feature/x").unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].path, "a.txt");
        assert_eq!(stats[0].additions, 1);
        assert_eq!(stats[0].deletions, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn patch_pick_plan_orders_dependencies_oldest_first() {
        let dir = std::env::temp_dir().join(format!("nezha-pick-plan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let mut cmd = Command::new("git");
            cmd.args(args).current_dir(&dir);
            let out = cmd.output().unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        run(&["checkout", "-q", "-b", "base"]);
        fs::write(dir.join("a.txt"), "0\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "base"]);
        run(&["checkout", "-q", "-b", "feature/x"]);
        fs::write(dir.join("a.txt"), "0\n1\n").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "one"]);
        fs::write(dir.join("a.txt"), "0\n1\n2\n").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "two"]);
        let second = String::from_utf8_lossy(
            &Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&dir)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();
        run(&["checkout", "-q", "base"]);
        run(&["checkout", "-q", "-b", "hotfix/2.5.1"]);
        let dir_str = dir.to_string_lossy().into_owned();
        let plans = super::patch_pick_plan_blocking(&dir_str, &[second.clone()]).unwrap();
        assert_eq!(plans.len(), 1);
        assert!(!plans[0].already_on_target);
        assert_eq!(plans[0].needed.len(), 2);
        // 最旧在前：第一个 commit 的 parent 是 base 上的初始提交，第二个是后续。
        assert_ne!(plans[0].needed[0], plans[0].needed[1]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_patch_pick_entries_extracts_source_sha() {
        let log = "a1f3c02\0fix: 号源锁定\0\n(cherry picked from commit 9c21ba0000000000000000000000000000000000)\n\x1e\
                   b77d2f1\0feat: 缴费页\0no marker\n\x1e";
        let entries = super::parse_patch_pick_entries(log.as_bytes(), "hotfix/2.5.1");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].source_commit,
            "9c21ba0000000000000000000000000000000000"
        );
        assert_eq!(entries[0].picked_commit, "a1f3c02");
        assert_eq!(entries[0].target_branch, "hotfix/2.5.1");
    }

    #[test]
    fn parse_conflicted_files_filters_merge_conflicts() {
        let status = b"UU file_a.cs\n M file_b.cs\nAA file_c.cs\nDU file_d.cs\n";
        let files = super::parse_conflicted_files(status);
        assert_eq!(files, vec!["file_a.cs", "file_c.cs", "file_d.cs"]);
    }
}
