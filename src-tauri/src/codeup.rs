//! Codeup (阿里云云效代码托管) 合并请求（MR）集成。
//!
//! 与 `yunxiao.rs` 共用同一接入点与鉴权头（`x-yunxiao-token`），token 复用应用级设置里的云效个人访问令牌。本模块只负责 Codeup 仓库侧的 MR 生命周期与分支保护管理员的读取。
//!
//! > ⚠️ 端点路径为最佳推断，集中定义在下方常量/函数中。由于 Codeup OpenAPI 需在已登录的环境才能实测，路径/字段若与实际情况有出入，改动应集中在 `CODUP_PREFIX` / `*_path()` / 解析函数里，避免散落。

use crate::git::{path_to_string, resolve_repo_path, run_git};
use crate::storage::{load_project_batches, load_projects, save_project_batches, Batch};
use crate::yunxiao::{build_client, read_json_body, API_BASE};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// Codeup API 前缀（相对接入点）。若实际为其它路径，仅需改这里。
const CODUP_PREFIX: &str = "oapi/v1/codeup";

/// 进程内自增计数，与毫秒时间戳组合保证每次临时目录/分支不重名。
static MR_TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 为这次操作生成唯一后缀（毫秒时间戳 + 进程内自增）。
fn unique_mr_temp_suffix() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = MR_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{ts}-{n}")
}

/// 一个仓库的 Codeup 定位信息。
#[derive(Clone, Debug)]
struct CodeupRepo {
    org_id: String,
    /// 组织内仓库路径（如 "HSP/HIS"）。
    repository: String,
}

/// 返回给前端的合并请求对象（跨项目聚合用）。
#[derive(Serialize, Clone, Debug)]
pub struct CodeupMr {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "projectPath")]
    pub project_path: String,
    pub repository: String,
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(rename = "sourceBranch")]
    pub source_branch: String,
    #[serde(rename = "targetBranch")]
    pub target_branch: String,
    pub status: String,
    pub author: String,
    pub reviewers: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// Codeup 仓库 id（数字，按仓库操作 MR 用）。
    #[serde(rename = "repositoryId")]
    pub repository_id: String,
    /// 仓库内 MR 编号（change 的 local id）。
    #[serde(rename = "localId")]
    pub local_id: i64,
    /// 是否存在冲突。
    #[serde(rename = "hasConflict")]
    pub has_conflict: bool,
    /// MR 详情 web 链接。
    #[serde(rename = "detailUrl")]
    pub detail_url: String,
    /// 更新时间戳（若可解析）。
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    /// 本地是否已拉取该 MR 代码（用于「拉取代码」门禁）。
    pub pulled: bool,
    /// 已拉取后的本地 worktree 路径。
    #[serde(rename = "worktreePath")]
    pub worktree_path: String,
}

/// 返回给前端的 Codeup 仓库（用于仓库过滤下拉）。
#[derive(Serialize, Clone, Debug)]
pub struct CodeupRepository {
    pub id: String,
    pub name: String,
    pub path: String,
    pub namespace: String,
    /// 克隆地址（`httpUrlToRepo`），合并审核对未注册仓库自动 clone 用。
    #[serde(rename = "httpUrl")]
    pub http_url: String,
    #[serde(rename = "webUrl")]
    pub web_url: String,
}

/// 把仓库 URL 解析成 Codeup 组织 + 仓库路径。
fn parse_codeup_remote(url: &str) -> Result<(String, String), String> {
    let url = url.trim();
    let after_host = if let Some(rest) = url.strip_prefix("https://") {
        rest.splitn(2, '/').nth(1).unwrap_or("")
    } else if let Some(rest) = url.strip_prefix("http://") {
        rest.splitn(2, '/').nth(1).unwrap_or("")
    } else if let Some(rest) = url.strip_prefix("git@") {
        rest.splitn(2, ':').nth(1).unwrap_or("")
    } else {
        return Err(format!("不支持的仓库 URL：{url}"));
    };
    let trimmed = after_host.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let mut parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return Err(format!("无法从仓库 URL 解析组织与路径：{url}"));
    }
    let org = parts.remove(0).to_string();
    let repo = parts.join("/");
    Ok((org, repo))
}

/// 从本地项目（子模块）解析出 Codeup 仓库定位。
async fn resolve_codeup_repo(
    project_path: &str,
    repo_path: Option<&str>,
) -> Result<CodeupRepo, String> {
    let cwd = resolve_repo_path(project_path, repo_path).await?;
    let output = run_git(&cwd, &["remote", "get-url", "origin"])
        .map_err(|e| format!("读取 git 远端失败（请确认项目可访问远端）: {e}"))?;
    if !output.status.success() {
        return Err("未找到 git origin 远端，无法定位 Codeup 仓库".to_string());
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let (org, repository) = parse_codeup_remote(&url)?;
    Ok(CodeupRepo {
        org_id: org,
        repository,
    })
}

/// 按仓库路径找到已注册的本地 Nezha 项目（git origin 可解析到同一 Codeup 仓库）。
async fn resolve_project_for_repo(repository: &str) -> Result<String, String> {
    let projects = load_projects()?;
    for project in &projects {
        if project.path.trim().is_empty() {
            continue;
        }
        if let Ok(repo) = resolve_codeup_repo(&project.path, None).await {
            if repo.repository == repository {
                return Ok(project.path.clone());
            }
        }
    }
    Err(format!(
        "本地未注册仓库 {repository}，无法拉取代码。请先将其注册为 Nezha 项目。"
    ))
}

/// 一次性构建「Codeup 仓库路径 → 已注册本地项目路径」映射。
///
/// 遍历所有已注册项目、每个项目只做一次 git origin 解析；此后列表里每条 MR 直接查表即可，
/// 避免原先「每条 MR × 每个项目」各跑一次 git 的 O(MR × 项目数) 开销。同名仓库保留首个命中。
async fn build_repo_to_project_map() -> HashMap<String, String> {
    let Ok(projects) = load_projects() else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    for project in &projects {
        if project.path.trim().is_empty() {
            continue;
        }
        if let Ok(repo) = resolve_codeup_repo(&project.path, None).await {
            map.entry(repo.repository)
                .or_insert_with(|| project.path.clone());
        }
    }
    map
}

/// 把 Codeup 仓库路径转成安全的本地目录名（杜绝 Windows 非法字符与路径穿越）。
fn sanitize_repo_dir(repository: &str) -> String {
    let mut out = String::new();
    for ch in repository.trim().chars() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => out.push('_'),
            _ => out.push(ch),
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "repository".to_string()
    } else {
        trimmed
    }
}

/// 去掉 Windows `std::fs::canonicalize` 产生的 `\\?\` / `//?/` verbatim 前缀。
/// 这类前缀会导致 `git worktree add` 在 checkout 的 `git reset --hard` 阶段卡死
/// （历史残留 worktree 的 `locked: initializing` 正是这样来的），git 命令一律用普通路径。
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        return rest.to_string();
    }
    if let Some(rest) = path.strip_prefix("//?/") {
        return rest.to_string();
    }
    path.to_string()
}

/// 从 Codeup 仓库列表里为某个仓库找到克隆地址（`httpUrlToRepo`）。
async fn codeup_find_clone_url(repository: &str) -> Result<String, String> {
    let repos = fetch_codeup_repositories().await?;
    for r in &repos {
        if r.namespace == repository || r.path == repository {
            if !r.http_url.is_empty() {
                return Ok(r.http_url.clone());
            }
        }
    }
    Err(format!(
        "未找到仓库 {repository} 的克隆地址（请确认其在 Codeup 组织内可见）。"
    ))
}

/// 确保 `<root>` 成为一个可用 git 仓库：已是 git 仓库则跳过；否则 `git init` + 配置 origin。
/// 采用 init + fetch 而非 clone，是为了**不要求目录为空**（历史残留也不报错），
/// 后续由 `codeup_pull_code` 的 fetch + `checkout -f` 全覆盖，不检查本地冲突。
async fn ensure_codeup_repo(root: &str, repository: &str) -> Result<(), String> {
    let root_path = Path::new(root);
    std::fs::create_dir_all(root_path).map_err(|e| format!("创建基路径失败: {e}"))?;
    if root_path.join(".git").exists() {
        return Ok(());
    }
    let init = crate::git::run_git_with_timeout(
        root.to_string(),
        vec!["init".into()],
        std::time::Duration::from_secs(60),
    )
    .await?;
    if !init.status.success() {
        return Err(format!(
            "git init 失败: {}",
            String::from_utf8_lossy(&init.stderr).trim()
        ));
    }
    let url = codeup_find_clone_url(repository).await?;
    let add = crate::git::run_git_with_timeout(
        root.to_string(),
        vec!["remote".into(), "add".into(), "origin".into(), url],
        std::time::Duration::from_secs(60),
    )
    .await?;
    if !add.status.success() {
        return Err(format!(
            "配置 origin 失败: {}",
            String::from_utf8_lossy(&add.stderr).trim()
        ));
    }
    // git init 不会像 clone 那样配置 fetch refspec；补上，使 `git fetch origin <branch>`
    // 会更新 `origin/<branch>`（否则后面 `git checkout origin/<branch>` 找不到 ref）。
    let _ = crate::git::run_git_with_timeout(
        root.to_string(),
        vec![
            "config".into(),
            "remote.origin.fetch".into(),
            "+refs/heads/*:refs/remotes/origin/*".into(),
        ],
        std::time::Duration::from_secs(30),
    )
    .await?;
    Ok(())
}

/// 合并审核的「worktree 槽位根」：`<基路径>/<仓库路径>`。所有 MR 的临时 worktree
/// 都统一落在 `<根>/.nezha/worktrees/` 下，**不区分仓库是否已注册**（设置面板的
/// 基路径对所有合并审核 pull 生效）。
async fn codeup_worktree_root(repository: &str) -> Result<String, String> {
    let base = crate::app_settings::codeup_worktree_base().await?;
    let root = Path::new(&base).join(sanitize_repo_dir(repository));
    let root_str = strip_verbatim_prefix(&path_to_string(&root)?);
    Ok(root_str)
}

/// 拉取/审查所需的 git 源仓库（含 origin，用于 fetch / worktree add）：
/// - 已注册为 Nezha 项目 → 复用项目自己的克隆（避免重复克隆大仓库）；
/// - 未注册仓库 → 在基路径槽位下自动 clone（`ensure_clone` 为 true 时）。
async fn codeup_git_source(repository: &str, ensure_clone: bool) -> Result<String, String> {
    if let Ok(project_path) = resolve_project_for_repo(repository).await {
        return resolve_repo_path(&project_path, None).await;
    }
    let root = codeup_worktree_root(repository).await?;
    if !Path::new(&root).join(".git").exists() {
        if !ensure_clone {
            return Err(format!(
                "本地未注册仓库 {repository}，且未在临时仓库基路径下 clone。"
            ));
        }
        ensure_codeup_repo(&root, repository).await?;
    }
    Ok(root)
}

/// 每仓库的「固定文件夹」（merge-review 用）：`<基路径>/<仓库>`。
/// 首次调用会全量 clone，之后该文件夹常驻，每次拉取只做 fetch + checkout 增量更新，
/// 避免大仓库（如 HIS）每次为每个 MR 新建整份 worktree 导致的耗时。
async fn codeup_repo_dir(repository: &str, ensure_clone: bool) -> Result<String, String> {
    let base = crate::app_settings::codeup_worktree_base().await?;
    let root = Path::new(&base).join(sanitize_repo_dir(repository));
    let root_str = strip_verbatim_prefix(&path_to_string(&root)?);
    if !Path::new(&root_str).join(".git").exists() {
        if !ensure_clone {
            return Err(format!(
                "本地未注册仓库 {repository}，且未在临时仓库基路径下 clone。"
            ));
        }
        ensure_codeup_repo(&root_str, repository).await?;
    }
    Ok(root_str)
}

/// 每仓库固定文件夹的**确定性路径**（不要求已存在、不触发 clone）。
/// 供未注册为 Nezha 项目的仓库兜底：前端据此把该路径当作项目根自动定位。
async fn codeup_repo_dir_path(repository: &str) -> Result<String, String> {
    let base = crate::app_settings::codeup_worktree_base().await?;
    let root = Path::new(&base).join(sanitize_repo_dir(repository));
    Ok(strip_verbatim_prefix(&path_to_string(&root)?))
}

/// 该 MR 当前仍存在的本地临时 worktree 路径（取最近创建的一个），没有则返回 None。
/// 读取应用级设置中的云效 token / organizationId。
async fn load_creds() -> Result<(String, String), String> {
    let settings = crate::app_settings::load_app_settings().await?;
    let token = settings.yunxiao.token.trim().to_string();
    if token.is_empty() {
        return Err("云效个人访问令牌不能为空（请在应用设置中配置）".to_string());
    }
    let org = settings.yunxiao.organization_id.trim().to_string();
    Ok((token, org))
}

fn repo_org_id(repo: &CodeupRepo) -> &str {
    &repo.org_id
}

fn branch_rules_url(org: &str, repo: &str) -> String {
    format!("{API_BASE}/{CODUP_PREFIX}/organizations/{org}/repositories/{repo}/rule")
}

/// 从 JSON 中宽容提取字符串数组字段（兼容 reviewers / managers / users / names 等命名差异）。
fn extract_string_list(value: &serde_json::Value, keys: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in keys {
        if let Some(arr) = value.get(key).and_then(serde_json::Value::as_array) {
            for item in arr {
                if let Some(s) = item.as_str() {
                    if !out.contains(&s.to_string()) {
                        out.push(s.to_string());
                    }
                } else if let Some(id) = item.get("id").and_then(serde_json::Value::as_str) {
                    if !out.contains(&id.to_string()) {
                        out.push(id.to_string());
                    }
                } else if let Some(name) = item.get("name").and_then(serde_json::Value::as_str) {
                    if !out.contains(&name.to_string()) {
                        out.push(name.to_string());
                    }
                }
            }
        }
    }
    out
}

/// 读取某仓库某分支的保护规则管理人员（审核人默认来源）。
#[tauri::command]
pub async fn codeup_branch_managers(
    project_path: String,
    repo_path: Option<String>,
    target_branch: String,
) -> Result<Vec<String>, String> {
    let (token, _) = load_creds().await?;
    let repo = resolve_codeup_repo(&project_path, repo_path.as_deref()).await?;
    let org = repo_org_id(&repo);
    let client = build_client()?;
    let bytes =
        crate::yunxiao::get_yunxiao_json(&client, &token, branch_rules_url(org, &repo.repository))
            .await?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析分支规则失败: {e}"))?;
    let rules = json
        .get("rules")
        .or_else(|| json.get("list"))
        .or_else(|| json.get("result"))
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or_else(|| std::slice::from_ref(&json));
    let mut names: Vec<String> = Vec::new();
    for rule in rules {
        let branch = rule
            .get("branch")
            .or_else(|| rule.get("branchName"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !branch.is_empty() && branch != target_branch {
            continue;
        }
        for m in extract_string_list(rule, &["managers", "reviewers", "users", "managerNames"]) {
            if !names.contains(&m) {
                names.push(m);
            }
        }
    }
    Ok(names)
}

fn load_batch(project_id: &str, batch_id: &str) -> Result<Batch, String> {
    load_project_batches(project_id.to_string())?
        .into_iter()
        .find(|b| b.id == batch_id)
        .ok_or_else(|| "Batch not found".to_string())
}

/// 查询 Codeup 上该 MR 当前是否已合并（状态归一化为含 "MERGED"）。
pub(crate) async fn batch_mr_is_merged(
    project_path: &str,
    repo_path: Option<&str>,
    mr_id: &str,
) -> Result<bool, String> {
    let (token, org_id) = load_creds().await?;
    let repo = resolve_codeup_repo(project_path, repo_path).await?;
    let repos = fetch_codeup_repositories().await?;
    let repository_id = repos
        .iter()
        .find(|r| r.namespace == repo.repository || r.path == repo.repository)
        .map(|r| r.id.clone())
        .ok_or_else(|| format!("未找到仓库 {} 的 Codeup 仓库 id", repo.repository))?;
    let url = change_item_url(&org_id, &repository_id, mr_id);
    let client = build_client()?;
    let bytes = crate::yunxiao::get_yunxiao_json(&client, &token, url).await?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析 MR 状态失败: {e}"))?;
    let item = json.get("result").unwrap_or(&json);
    let state = item
        .get("state")
        .or_else(|| item.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_uppercase();
    Ok(state.contains("MERGED"))
}

/// 在 Codeup 上创建合并请求；仅提交（不合并）。成功后回写批的 mrId/mrStatus，status=review。
#[tauri::command]
pub async fn codeup_create_mr(
    project_path: String,
    repo_path: Option<String>,
    project_id: String,
    batch_id: String,
    reviewers: Vec<String>,
) -> Result<Batch, String> {
    let (token, _) = load_creds().await?;
    let batch = load_batch(&project_id, &batch_id)?;
    if batch.status != "active" {
        return Err("批次不是进行中状态，无法提交 MR".to_string());
    }
    let worktree_str = path_to_string(
        &std::path::Path::new(&project_path)
            .join(".nezha")
            .join("worktrees")
            .join(&batch_id),
    )?;
    let worktree_path = batch.worktree_path.clone().unwrap_or(worktree_str);
    if let Some(dirty) = crate::git::worktree_dirty_reason(&worktree_path)? {
        return Err(format!(
            "提交 MR 前 worktree 仍有未提交内容，请先处理：{dirty}"
        ));
    }

    // 先非 force push 源分支，保证 MR 引用远端已有提交；再取提交时的 HEAD。
    let push = run_git(&worktree_path, &["push", "origin", &batch.branch])?;
    if !push.status.success() {
        return Err(format!(
            "推送源分支失败（不会 force push）：{}",
            String::from_utf8_lossy(&push.stderr).trim()
        ));
    }
    let head_out = run_git(&worktree_path, &["rev-parse", "HEAD"])?;
    if !head_out.status.success() {
        return Err(String::from_utf8_lossy(&head_out.stderr).trim().to_string());
    }
    let source_sha = String::from_utf8_lossy(&head_out.stdout).trim().to_string();

    let repo = resolve_codeup_repo(&project_path, repo_path.as_deref()).await?;
    let org = repo_org_id(&repo);
    let url = format!("{API_BASE}/{CODUP_PREFIX}/organizations/{org}/changeRequests");
    let client = build_client()?;
    let body = serde_json::json!({
        "title": batch.name,
        "description": format!("由 Nezha 分支批 {} 发起（{}）", batch.id, batch.kind),
        "sourceBranch": batch.branch,
        "targetBranch": batch.target_branch,
        "reviewerIds": reviewers,
    });
    let resp = client
        .post(url)
        .header("x-yunxiao-token", &token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("创建合并请求失败: {e}"))?;
    let bytes = read_json_body(resp).await?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析创建合并请求响应失败: {e}"))?;
    let mr_id = json
        .get("id")
        .or_else(|| json.get("mrId"))
        .or_else(|| json.get("result").and_then(|r| r.get("id")))
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| {
            json.get("id")
                .and_then(|v| v.as_i64())
                .map(|i| i.to_string())
        })
        .ok_or_else(|| "创建合并请求后未取到 MR id".to_string())?;

    let mut batches = load_project_batches(project_id.clone())?;
    let updated = batches
        .iter_mut()
        .find(|b| b.id == batch_id)
        .ok_or_else(|| "Batch not found".to_string())?;
    updated.mr_id = Some(mr_id);
    updated.mr_status = Some("opened".to_string());
    updated.status = "review".to_string();
    updated.mr_source_sha = Some(source_sha);
    let result = updated.clone();
    save_project_batches(project_id, batches)?;
    Ok(result)
}

/// changeRequests 分页上限（每页 20），只取最近若干页；已开启 MR 按更新时间靠前。
/// 单次分页拉取条数（云效接口实测支持 perPage，可显著减少翻页次数、加快列表加载）。
/// 接口若不识别该参数仍会按默认 20 条返回，下方 MIN_CHANGE_PAGE_SIZE 兜底保证不会漏页。
const CHANGE_PAGE_SIZE: u32 = 100;
const MIN_CHANGE_PAGE_SIZE: usize = 20;
const MAX_CHANGE_PAGES: u32 = 10;

/// 把 `nameWithNamespace`（org / group / repo）折算成仓库路径（如 "HSP/HIS"）。
fn namespace_to_repo_path(ns: &str) -> String {
    ns.split('/')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .skip(1) // 第一个段是 org id
        .collect::<Vec<_>>()
        .join("/")
}

/// 列出当前组织下所有 Codeup 仓库（供「仓库过滤」下拉）。
/// 从 Codeup API 拉取当前组织下的仓库列表（含克隆地址）。供命令与克隆解析共用。
async fn fetch_codeup_repositories() -> Result<Vec<CodeupRepository>, String> {
    let (token, _) = load_creds().await?;
    let client = build_client()?;
    let org_id = crate::app_settings::load_app_settings()
        .await?
        .yunxiao
        .organization_id
        .trim()
        .to_string();
    let url = format!("{API_BASE}/{CODUP_PREFIX}/organizations/{org_id}/repositories");
    let bytes = crate::yunxiao::get_yunxiao_json(&client, &token, url).await?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析仓库列表失败: {e}"))?;
    let arr = json.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
    let mut out: Vec<CodeupRepository> = Vec::new();
    for item in arr {
        let repo_path = item
            .get("nameWithNamespace")
            .or_else(|| item.get("httpUrlToRepo"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let namespace = item
            .get("nameWithNamespace")
            .and_then(|v| v.as_str())
            .map(namespace_to_repo_path)
            .unwrap_or_default();
        out.push(CodeupRepository {
            id: item
                .get("id")
                .and_then(|v| {
                    v.as_str()
                        .map(String::from)
                        .or_else(|| v.as_i64().map(|i| i.to_string()))
                })
                .unwrap_or_default(),
            name: item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            path: repo_path,
            namespace,
            http_url: item
                .get("httpUrlToRepo")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            web_url: item
                .get("webUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn codeup_list_repositories() -> Result<Vec<CodeupRepository>, String> {
    fetch_codeup_repositories().await
}

/// 跨仓库聚合「已开启/评审中」的 MR；可选按仓库 id 过滤。
#[tauri::command]
pub async fn codeup_list_pending_mrs(
    repository_id: Option<String>,
) -> Result<Vec<CodeupMr>, String> {
    let (token, _) = load_creds().await?;
    let client = build_client()?;
    let url_base = format!(
        "{API_BASE}/{CODUP_PREFIX}/organizations/{}/changeRequests",
        crate::app_settings::load_app_settings()
            .await?
            .yunxiao
            .organization_id
            .trim()
    );
    let mut out: Vec<CodeupMr> = Vec::new();
    // 一次性解析所有已注册项目的 Codeup 仓库映射，供下方逐条 MR 查表（避免 O(MR × 项目数) 的 git 调用）。
    let repo_to_project = build_repo_to_project_map().await;
    // 每仓库只算一次「基路径固定文件夹」与「确定性兜底路径」，避免对重复仓库反复读应用设置。
    let mut root_cache: HashMap<String, String> = HashMap::new();
    let mut dir_path_cache: HashMap<String, String> = HashMap::new();
    // 记录首页实际返回条数（用于识别真正末页），并对每一页统计「开放状态 MR 数量」用于早停。
    let mut expected_page_len: Option<usize> = None;
    for page in 1..=MAX_CHANGE_PAGES {
        let url = format!("{url_base}?page={page}&perPage={CHANGE_PAGE_SIZE}");
        let bytes = match crate::yunxiao::get_yunxiao_json(&client, &token, url).await {
            Ok(b) => b,
            // 第一页失败直接暴露给前端，避免把「请求/凭据失败」误显示成「无可审核 MR」。
            Err(e) if page == 1 => return Err(format!("拉取待审核合并请求失败: {e}")),
            Err(_) => break,
        };
        let json: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) if page == 1 => {
                return Err(format!(
                    "解析待审核合并请求响应失败: {e} (body={})",
                    String::from_utf8_lossy(&bytes)
                ))
            }
            Err(_) => break,
        };
        let arr = json
            .as_array()
            .or_else(|| json.get("list").and_then(|v| v.as_array()))
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        if arr.is_empty() {
            break;
        }
        let page_len = arr.len();
        expected_page_len.get_or_insert(page_len);
        let mut open_on_page = 0usize;
        for item in arr {
            let state = item
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // 与云效「已开启」口径对齐：评审中 + 已通过(待合并) 都展示。
            // 是否冲突/有冲突 是独立标记（hasConflict），不在此处过滤 —— 有/无冲突都显示。
            if state != "UNDER_REVIEW" && state != "TO_BE_MERGED" && state != "APPROVED" {
                continue;
            }
            open_on_page += 1;
            let project_id = item
                .get("projectId")
                .and_then(|v| v.as_i64().map(|i| i.to_string()))
                .unwrap_or_default();
            // 仓库过滤：匹配目标仓库 id。
            if let Some(filter) = &repository_id {
                if !filter.is_empty() && &project_id != filter {
                    continue;
                }
            }
            let mr_biz = item
                .get("mrBizId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if mr_biz.is_empty() {
                continue;
            }
            let local_id = item.get("localId").and_then(|v| v.as_i64()).unwrap_or(0);
            let ns = item
                .get("nameWithNamespace")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let reviewers = item
                .get("reviewers")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|r| {
                            r.get("name")
                                .or_else(|| r.get("userName"))
                                .and_then(|n| n.as_str())
                                .map(|s| s.to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let repo_path = namespace_to_repo_path(&ns);
            // 已注册项目路径：前端把审查/冲突任务挂在项目上必须依赖它（保持原样）。
            // 直接查一次性构建的仓库→项目映射，不再对每条 MR 遍历所有项目。
            let registered_project = repo_to_project.get(&repo_path).cloned();
            // 固定文件夹路径（基路径下）：用于探测 MR 是否已拉取（只读，不触发 clone）；
            // 未注册仓库时兜底把该确定性路径给前端，让「代码审查」能自动定位、无需手动注册。
            let root = match root_cache.get(&repo_path) {
                Some(r) => r.clone(),
                None => {
                    let r = codeup_repo_dir(&repo_path, false).await.unwrap_or_default();
                    root_cache.insert(repo_path.clone(), r.clone());
                    r
                }
            };
            let project_path = match &registered_project {
                Some(p) => p.clone(),
                None => match dir_path_cache.get(&repo_path) {
                    Some(d) => d.clone(),
                    None => {
                        let d = codeup_repo_dir_path(&repo_path).await.unwrap_or_default();
                        dir_path_cache.insert(repo_path.clone(), d.clone());
                        d
                    }
                },
            };
            let pulled = if root.is_empty() {
                false
            } else {
                Path::new(&root)
                    .join(".nezha")
                    .join(format!("pulled-{}", local_id))
                    .is_file()
            };
            out.push(CodeupMr {
                project_id: project_id.clone(),
                project_path,
                repository: repo_path,
                id: mr_biz,
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(无标题)")
                    .to_string(),
                description: item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                source_branch: item
                    .get("sourceBranch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                target_branch: item
                    .get("targetBranch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                status: state,
                author: item
                    .get("author")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                reviewers,
                created_at: 0,
                repository_id: project_id,
                local_id,
                has_conflict: item
                    .get("hasConflict")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                detail_url: item
                    .get("detailUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                updated_at: 0,
                pulled,
                worktree_path: if pulled { root.clone() } else { String::new() },
            });
        }
        // 云效按近期活跃排序，评审中/待合并的 MR 集中在前部；一旦某一页（非首页）没有开放状态 MR，
        // 说明已扫完开放集群，可提前结束，避免为几千条历史 MR 一路翻满 10 页。
        if open_on_page == 0 && page > 1 {
            break;
        }
        // 兜底：到达真实末页（某页返回条数少于首页）也停止。
        if page_len < expected_page_len.unwrap_or(page_len) || page_len < MIN_CHANGE_PAGE_SIZE {
            break;
        }
    }
    Ok(out)
}

/// 按仓库 id + MR 编号拼 change 详情/动作地址（动作子路径未实测，需联调）。
fn change_item_url(org: &str, repository_id: &str, mr_id: &str) -> String {
    format!(
        "{API_BASE}/{CODUP_PREFIX}/organizations/{org}/repositories/{repository_id}/changeRequests/{mr_id}"
    )
}

#[tauri::command]
pub async fn codeup_get_mr(repository_id: String, mr_id: String) -> Result<CodeupMr, String> {
    let (token, org_id) = load_creds().await?;
    let client = build_client()?;
    let url = change_item_url(&org_id, &repository_id, &mr_id);
    let bytes = crate::yunxiao::get_yunxiao_json(&client, &token, url).await?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析 MR 详情失败: {e}"))?;
    let item = json.get("result").unwrap_or(&json);
    Ok(CodeupMr {
        project_id: String::new(),
        project_path: String::new(),
        repository: String::new(),
        id: mr_id.clone(),
        title: item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(无标题)")
            .to_string(),
        description: item
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        source_branch: item
            .get("sourceBranch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        target_branch: item
            .get("targetBranch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        status: item
            .get("state")
            .or_else(|| item.get("status"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        author: item
            .get("author")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        reviewers: extract_string_list(item, &["reviewers"]),
        created_at: 0,
        repository_id: repository_id.clone(),
        local_id: mr_id.parse().unwrap_or(0),
        has_conflict: item
            .get("hasConflict")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        detail_url: item
            .get("detailUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: 0,
        pulled: false,
        worktree_path: String::new(),
    })
}

/// 管理人「通过」（approve）一条 MR。动作子路径为最佳推断，需联调。
#[tauri::command]
pub async fn codeup_approve_mr(repository_id: String, mr_id: String) -> Result<String, String> {
    let (token, org_id) = load_creds().await?;
    let client = build_client()?;
    let url = format!(
        "{}/submitReview",
        change_item_url(&org_id, &repository_id, &mr_id)
    );
    let resp = client
        .post(url)
        .header("x-yunxiao-token", &token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "state": "APPROVED" }))
        .send()
        .await
        .map_err(|e| format!("通过合并请求失败: {e}"))?;
    read_json_body(resp).await?;
    Ok(mr_id)
}

/// 管理人「合并」一条 MR（Codeup 侧真正合并）。动作子路径为最佳推断，需联调。
#[tauri::command]
pub async fn codeup_merge_mr(
    repository_id: String,
    mr_id: String,
    merge_type: Option<String>,
) -> Result<String, String> {
    let (token, org_id) = load_creds().await?;
    let client = build_client()?;
    let url = format!("{}/merge", change_item_url(&org_id, &repository_id, &mr_id));
    let merge_type = merge_type.unwrap_or_else(|| "merge".to_string());
    let resp = client
        .post(url)
        .header("x-yunxiao-token", &token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "merge_type": merge_type }))
        .send()
        .await
        .map_err(|e| format!("合并请求失败: {e}"))?;
    read_json_body(resp).await?;
    Ok(mr_id)
}

/// 清掉该 MR 在 `worktree_root/.nezha/worktrees` 下所有 `codeup-mr-<id>(-*)` 临时 worktree
/// （含 git worktree 元数据与临时分支），失败静默。
async fn codeup_cleanup_mr_temps(worktree_root: String, source_cwd: String, mr_id: String) {
    tokio::task::spawn_blocking(move || {
        let worktrees_dir = Path::new(&worktree_root).join(".nezha").join("worktrees");
        let base = format!("codeup-mr-{mr_id}");
        let prefix = format!("{base}-");
        let Ok(entries) = std::fs::read_dir(&worktrees_dir) else {
            return;
        };
        // Windows 下 git 把 worktree 登记为 //?/ 长路径，直接 `git worktree remove` 用普通
        // 路径会匹配不上（"not a working tree"）。所以先物理删目录，再 prune 清登记，最后删分支。
        let mut removed_names: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if path.is_dir() && (name == base || name.starts_with(&prefix)) {
                let _ = std::fs::remove_dir_all(&path);
                removed_names.push(name);
            }
        }
        let _ = run_git(&source_cwd, &["worktree", "prune"]);
        for name in removed_names {
            let _ = run_git(&source_cwd, &["branch", "-D", &name]);
        }
    })
    .await
    .ok();
}

/// 为 MR 创建一份**全新的**临时 worktree（每次都是新目录，绝不复用本地遗留）。
/// 返回 `(worktree_path, local_branch)`。
async fn codeup_create_temp_worktree(
    source_cwd: String,
    worktree_root: String,
    source_branch: String,
    target_branch: Option<String>,
    mr_id: String,
    no_checkout: bool,
) -> Result<(String, String), String> {
    let worktrees_dir = Path::new(&worktree_root).join(".nezha").join("worktrees");
    std::fs::create_dir_all(&worktrees_dir).map_err(|e| format!("创建 worktrees 目录失败: {e}"))?;
    let suffix = unique_mr_temp_suffix();
    let dir = worktrees_dir.join(format!("codeup-mr-{mr_id}-{suffix}"));
    let dir_str = strip_verbatim_prefix(&path_to_string(&dir)?);
    let local = format!("codeup-mr-{mr_id}-{suffix}");
    // 拉取源分支（带超时，避免网络/凭据卡死）。
    let fetch = crate::git::run_git_with_timeout(
        source_cwd.clone(),
        vec!["fetch".into(), "origin".into(), source_branch.clone()],
        std::time::Duration::from_secs(300),
    )
    .await?;
    if !fetch.status.success() {
        return Err(format!(
            "拉取源分支失败: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    // 拉取目标分支：让工作区内的 `git diff origin/<target>...origin/<source>` 能解析，
    // 否则审查任务会因缺少分支 ref 而「加载不出来具体分支」。
    if let Some(target) = target_branch
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        let fetch_target = crate::git::run_git_with_timeout(
            source_cwd.clone(),
            vec!["fetch".into(), "origin".into(), target.to_string()],
            std::time::Duration::from_secs(300),
        )
        .await?;
        if !fetch_target.status.success() {
            return Err(format!(
                "拉取目标分支失败: {}",
                String::from_utf8_lossy(&fetch_target.stderr).trim()
            ));
        }
    }
    let branch_ref = format!("origin/{source_branch}");
    // 创建临时 worktree。HIS 这类大仓库 + `* text=auto` 在 checkout 时会按文件做
    // CRLF 归一化，极慢；关掉 autocrlf/safecrlf 跳过行尾转换，大幅提速。审查只读，
    // 行尾不影响 diff 结论；提交时代理会按 .gitattributes 再归一化。
    let mut add_args: Vec<String> = vec![
        "-c".into(),
        "core.autocrlf=false".into(),
        "-c".into(),
        "core.safecrlf=false".into(),
        "worktree".into(),
        "add".into(),
    ];
    // 审查只读且仓库极大（HIS）：用 --no-checkout 只建 worktree 骨架、不落盘文件，
    // 秒级完成；agent 用 git diff/show 读对象库。浏览/冲突仍需整树检出。 --no-checkout
    // 要放在 <dir> 之前。
    if no_checkout {
        add_args.push("--no-checkout".into());
    }
    add_args.push(dir_str.clone());
    add_args.push("-b".into());
    add_args.push(local.clone());
    add_args.push(branch_ref);
    let add =
        crate::git::run_git_with_timeout(source_cwd, add_args, std::time::Duration::from_secs(600))
            .await?;
    if !add.status.success() {
        return Err(format!(
            "创建 worktree 失败: {}",
            String::from_utf8_lossy(&add.stderr).trim()
        ));
    }
    Ok((dir_str, local))
}

/// 移除本次操作创建的临时 worktree（force 移除 + prune + 删临时分支），失败静默。
async fn codeup_remove_temp_worktree(cwd: String, worktree_path: String, local_branch: String) {
    tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(&worktree_path);
        let _ = run_git(&cwd, &["worktree", "prune"]);
        let _ = run_git(&cwd, &["branch", "-D", &local_branch]);
    })
    .await
    .ok();
}

/// 对某个跨仓库 MR 执行 Agent 代码审查：每次都用一份**全新的临时 worktree**
/// （不复用本地遗留，也不论是否已经拉取过），跑完即清理，仅返回 findings。
#[tauri::command]
pub async fn codeup_review_mr(
    repository: String,
    source_branch: String,
    target_branch: String,
    mr_id: String,
    agent: Option<String>,
) -> Result<Vec<crate::agent_assist::ReviewFinding>, String> {
    let agent = agent.unwrap_or_else(|| "claude".to_string());
    let source = codeup_git_source(&repository, true).await?;
    let root = codeup_worktree_root(&repository).await?;
    // 每次处理都重建全新临时 worktree，先清掉旧残留。
    codeup_cleanup_mr_temps(root.clone(), source.clone(), mr_id.clone()).await;
    let (worktree_path, local_branch) = codeup_create_temp_worktree(
        source.clone(),
        root.clone(),
        source_branch.clone(),
        Some(target_branch.clone()),
        mr_id.clone(),
        true,
    )
    .await?;
    let result = crate::agent_assist::run_merge_code_review(
        root,
        None,
        worktree_path.clone(),
        target_branch,
        source_branch,
        agent,
    )
    .await;
    codeup_remove_temp_worktree(source, worktree_path.clone(), local_branch).await;
    result
}

/// 带重试的 git 命令：对瞬时网络 / DNS 失败重试 `attempts` 次，成功返回 Output。
async fn run_git_with_retry(
    project_path: String,
    args: Vec<String>,
    timeout: std::time::Duration,
    attempts: u32,
) -> Result<std::process::Output, String> {
    let mut last_msg = String::new();
    for i in 0..attempts {
        match crate::git::run_git_with_timeout(project_path.clone(), args.clone(), timeout).await {
            Ok(out) if out.status.success() => return Ok(out),
            Ok(out) => {
                last_msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if i + 1 < attempts {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
            Err(e) => {
                last_msg = e;
                if i + 1 < attempts {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    }
    Err(if last_msg.is_empty() {
        "git 命令失败".to_string()
    } else {
        last_msg
    })
}

/// 显式「拉取代码」：使用**每仓库固定文件夹**（`<基路径>/<仓库>`）。
/// 首次全量 clone，之后每次只 fetch + 切到源分支（增量更新），解决大仓库每次
/// 建整份 worktree 造成的耗时。
#[tauri::command]
pub async fn codeup_pull_code(
    repository: String,
    source_branch: String,
    target_branch: String,
    mr_id: String,
) -> Result<String, String> {
    let root = codeup_repo_dir(&repository, true).await?;
    // fetch 源分支（带超时；固定文件夹首次 clone 后，这里只是增量更新）。
    let _ = run_git_with_retry(
        root.clone(),
        vec!["fetch".into(), "origin".into(), source_branch.clone()],
        std::time::Duration::from_secs(300),
        3,
    )
    .await
    .map_err(|e| format!("拉取源分支失败: {e}"))?;
    // fetch 目标分支，使 `git diff origin/<target>...origin/<source>` 可解析。
    let target_trim = target_branch.trim().to_string();
    if !target_trim.is_empty() {
        let _ = run_git_with_retry(
            root.clone(),
            vec!["fetch".into(), "origin".into(), target_trim],
            std::time::Duration::from_secs(300),
            3,
        )
        .await
        .map_err(|e| format!("拉取目标分支失败: {e}"))?;
    }
    // 把固定文件夹 HEAD 切到源分支（force 丢弃上次审查对工作区文件的改动）。
    let local = format!("codeup-mr-{mr_id}");
    let branch_ref = format!("origin/{source_branch}");
    let _ = run_git_with_retry(
        root.clone(),
        vec![
            "checkout".into(),
            "-f".into(),
            "-B".into(),
            local,
            branch_ref,
        ],
        std::time::Duration::from_secs(300),
        2,
    )
    .await
    .map_err(|e| format!("切换分支失败: {e}"))?;
    // 记录该 MR 已拉取（文件夹共享，按 MR 标记区分）。
    let nezha = Path::new(&root).join(".nezha");
    std::fs::create_dir_all(&nezha).map_err(|e| format!("创建 .nezha 失败: {e}"))?;
    let _ = std::fs::write(nezha.join(format!("pulled-{mr_id}")), b"");
    Ok(root)
}

/// 查询某个 MR 是否已拉取（按固定文件夹下的 per-MR 标记）。
#[tauri::command]
pub async fn codeup_is_pulled(repository: String, mr_id: String) -> Result<bool, String> {
    let root = match codeup_repo_dir(&repository, false).await {
        Ok(r) => r,
        Err(_) => return Ok(false),
    };
    Ok(Path::new(&root)
        .join(".nezha")
        .join(format!("pulled-{mr_id}"))
        .is_file())
}

/// 读取某个 MR 在固定文件夹里保存的代码审查结果（`.nezha/review-<mrId>.json`）。
/// 没有该文件或未拉取到 worktree 时返回 None。
#[tauri::command]
pub async fn codeup_read_review(
    repository: String,
    mr_id: String,
) -> Result<Option<Vec<crate::agent_assist::ReviewFinding>>, String> {
    let root = match codeup_repo_dir(&repository, false).await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let result_path = Path::new(&root)
        .join(".nezha")
        .join(format!("review-{mr_id}.json"));
    if !result_path.is_file() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&result_path).map_err(|e| format!("读取审查结果失败: {e}"))?;
    let parsed: Vec<crate::agent_assist::ReviewFinding> =
        serde_json::from_str(&raw).map_err(|e| format!("解析审查结果失败: {e}"))?;
    Ok(Some(parsed))
}

/// 读取某个 MR 在固定文件夹里保存的代码审查**总结报告**（`.nezha/review-report-<mrId>.md`）。
/// 没有该文件或未拉取到 worktree 时返回 None。
#[tauri::command]
pub async fn codeup_read_review_report(
    repository: String,
    mr_id: String,
) -> Result<Option<String>, String> {
    let root = match codeup_repo_dir(&repository, false).await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let report_path = Path::new(&root)
        .join(".nezha")
        .join(format!("review-report-{mr_id}.md"));
    if !report_path.is_file() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&report_path).map_err(|e| format!("读取审查报告失败: {e}"))?;
    Ok(Some(raw))
}

/// 把某 MR 的代码审查**总结报告**（`.nezha/review-report-<mrId>.md`）导出到用户所选路径。
/// `dest_path` 由前端「另存为」对话框给出，必须是绝对路径；源报告不存在则报错。
#[tauri::command]
pub async fn codeup_export_review_report(
    repository: String,
    mr_id: String,
    dest_path: String,
) -> Result<String, String> {
    let root = codeup_repo_dir(&repository, false).await?;
    let source = Path::new(&root)
        .join(".nezha")
        .join(format!("review-report-{mr_id}.md"));
    let dest = std::path::PathBuf::from(&dest_path);
    if !dest.is_absolute() {
        return Err("导出路径必须是绝对路径".to_string());
    }
    tokio::task::spawn_blocking(move || {
        if !source.is_file() {
            return Err("该 MR 暂无审查报告，请先执行「代码审查」。".to_string());
        }
        let content =
            std::fs::read_to_string(&source).map_err(|e| format!("读取审查报告失败: {e}"))?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败: {e}"))?;
        }
        std::fs::write(&dest, content).map_err(|e| format!("写入审查报告失败: {e}"))?;
        Ok(dest_path)
    })
    .await
    .map_err(|e| format!("导出线程错误: {e}"))?
}

/// 清理某 MR 在固定文件夹下的拉取标记与审查结果（Agent 审查/冲突任务结束后由前端调用；
/// 固定文件夹本身保留，下次拉取复用）。
#[tauri::command]
pub async fn codeup_cleanup_mr(repository: String, mr_id: String) -> Result<(), String> {
    let root = match codeup_repo_dir(&repository, false).await {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    // 保留 `.nezha/pulled-<mrId>`：表示该 MR 已拉取过，清理后仍显示「已拉取」，避免每次都要重拉。
    // 真正发起审查/合并任务时，`codeup_pull_code` 仍会 fetch + checkout 最新代码，不影响新鲜度。
    let _ = std::fs::remove_file(
        Path::new(&root)
            .join(".nezha")
            .join(format!("review-{mr_id}.json")),
    );
    Ok(())
}

/// 处理冲突：每次用一份**全新的临时 worktree**（不复用本地遗留），把目标分支并入源分支找出冲突；
/// 有冲突则跑 Agent 解决→提交→push 回源分支；无冲突则提示可直接合并。跑完即清理临时 worktree。
#[tauri::command]
pub async fn codeup_resolve_conflicts(
    repository: String,
    source_branch: String,
    target_branch: String,
    mr_id: String,
    agent: Option<String>,
) -> Result<String, String> {
    let agent = agent.unwrap_or_else(|| "claude".to_string());
    if target_branch.trim().is_empty() {
        return Err("目标分支不能为空".to_string());
    }
    let source = codeup_git_source(&repository, true).await?;
    let root = codeup_worktree_root(&repository).await?;
    codeup_cleanup_mr_temps(root.clone(), source.clone(), mr_id.clone()).await;
    let (worktree_path, local_branch) = codeup_create_temp_worktree(
        source.clone(),
        root.clone(),
        source_branch.clone(),
        Some(target_branch.clone()),
        mr_id.clone(),
        false,
    )
    .await?;
    let result = codeup_resolve_conflicts_inner(
        root,
        worktree_path.clone(),
        target_branch,
        source_branch,
        agent,
    )
    .await;
    codeup_remove_temp_worktree(source, worktree_path.clone(), local_branch).await;
    result
}

/// `codeup_resolve_conflicts` 的具体冲突探测/解决逻辑（在临时 worktree 内执行）。
async fn codeup_resolve_conflicts_inner(
    project_path: String,
    worktree_path: String,
    target_branch: String,
    source_branch: String,
    agent: String,
) -> Result<String, String> {
    // 拉目标分支，并在 worktree 里做一次不提交的 merge 以暴露冲突。
    let fetch = run_git(&worktree_path, &["fetch", "origin", &target_branch])?;
    if !fetch.status.success() {
        return Err(format!(
            "拉取目标分支失败: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    let target_ref = format!("origin/{target_branch}");
    let merge = run_git(
        &worktree_path,
        &["merge", "--no-commit", "--no-ff", &target_ref],
    )?;
    if merge.status.success() {
        // 无冲突，还原 worktree 状态即可。
        let _ = run_git(&worktree_path, &["merge", "--abort"]);
        return Ok("MR 当前无冲突，可直接合并。".to_string());
    }
    // 有冲突：Agent 解决 → 提交 → push 回源分支。
    crate::agent_assist::run_conflict_resolution(
        project_path.clone(),
        None,
        worktree_path.clone(),
        agent,
    )
    .await?;
    crate::git::commit_conflict_resolution(
        project_path.clone(),
        None,
        worktree_path.clone(),
        "resolve merge conflicts".to_string(),
        None,
    )
    .await?;
    let refspec = format!("HEAD:{source_branch}");
    let push = run_git(&worktree_path, &["push", "origin", &refspec])?;
    if !push.status.success() {
        return Err(format!(
            "推送解决结果到源分支失败: {}",
            String::from_utf8_lossy(&push.stderr).trim()
        ));
    }
    Ok("已解决冲突并推送回源分支，可刷新后合并。".to_string())
}

/// 供测试/调试：输出项目的 Codeup 定位信息（不含远端 URL 细节）。
#[tauri::command]
pub async fn codeup_resolve_repo(
    project_path: String,
    repo_path: Option<String>,
) -> Result<String, String> {
    let repo = resolve_codeup_repo(&project_path, repo_path.as_deref()).await?;
    Ok(format!("{}|{}", repo.org_id, repo.repository))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_codeup_remote() {
        let (org, repo) =
            parse_codeup_remote("https://codeup.aliyun.com/641881e9b9581d62e8f8186e/HSP/HIS.git")
                .unwrap();
        assert_eq!(org, "641881e9b9581d62e8f8186e");
        assert_eq!(repo, "HSP/HIS");
    }

    #[test]
    fn parses_git_ssh_codeup_remote() {
        let (org, repo) =
            parse_codeup_remote("git@codeup.aliyun.com:641881e9b9581d62e8f8186e/HSP/HIS.git")
                .unwrap();
        assert_eq!(org, "641881e9b9581d62e8f8186e");
        assert_eq!(repo, "HSP/HIS");
    }
}
