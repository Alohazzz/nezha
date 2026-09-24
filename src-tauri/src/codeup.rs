//! Codeup (阿里云云效代码托管) 合并请求（MR）集成。
//!
//! 与 `yunxiao.rs` 共用同一接入点与鉴权头（`x-yunxiao-token`），token 复用应用级设置里的云效个人访问令牌。本模块只负责 Codeup 仓库侧的 MR 生命周期与分支保护管理员的读取。
//!
//! > ⚠️ 端点路径以官方 OpenAPI 契约为准（已用真实令牌逐个实测）。改动应集中在
//! > `CODUP_PREFIX` / `*_url()` / 解析函数里，避免散落。
//!
//! 已实测的关键契约（易踩坑，勿改回）：
//! - **创建 MR 是仓库级路径** `…/repositories/{repositoryId}/changeRequests`；组织级
//!   `…/organizations/{org}/changeRequests` 只有列表 GET 存在，POST 会 404。
//! - 评审人字段是 `reviewerUserIds`，收**云效 userID**（不是人名）；另需
//!   `sourceProjectId` / `targetProjectId`（仓库数字 id）与 `createFrom`。
//! - MR 详情/动作路径段收 `localId`，传 `mrBizId` 报 `Invalid param value`。

use crate::git::{path_to_string, resolve_repo_path, run_git, validate_project_path};
use crate::storage::{load_project_batches_sync, load_projects, save_project_batches_sync, DeliveryPlan};
use crate::yunxiao::{build_client, read_json_body, API_BASE};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

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
    /// 本地是否已拉取过该 MR 代码（用于合并前门禁；拉取按钮不因此禁用，可随时重新拉取刷新）。
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
    if let Some(found) = find_codeup_repository(repository, &repos) {
        if !found.http_url.is_empty() {
            return Ok(found.http_url.clone());
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

/// 归一化仓库路径，用于比较「git origin 解析出的路径」与「云效仓库标识」。
///
/// 两边**经常不一致**：云效的 `nameWithNamespace` 会吃掉分隔符——仓库 `HSP/Hsp_Main`
/// 的平台标识是 `HSP/HspMain`，而 origin URL 保留原始下划线。直接字符串相等会让这类仓库
/// 永远匹配不上，表现为「创建 MR 时找不到仓库」，也波及「本地分支 → 开放 MR」的 join。
/// 只保留字母数字并小写后再比（`HSP/HIS` 与 `HSP_XC/HIS` 仍能区分开）。
fn normalize_repo_path(path: &str) -> String {
    path.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 从克隆地址里取「组织内仓库路径」（如 `HSP/Hsp_Main`）。
fn repo_path_from_clone_url(url: &str) -> String {
    parse_codeup_remote(url)
        .map(|(_, repo)| repo)
        .unwrap_or_default()
}

/// 云效仓库是否就是本地 origin 指向的那个仓库。
///
/// 先比平台命名空间，再比克隆地址里的路径——`httpUrlToRepo` 与本地 origin 是同一来源，
/// 是这里最可靠的同一性判据（命名空间可能被平台改写过分隔符）。
fn codeup_repo_matches(repository: &str, candidate: &CodeupRepository) -> bool {
    let want = normalize_repo_path(repository);
    if want.is_empty() {
        return false;
    }
    normalize_repo_path(&candidate.namespace) == want
        || normalize_repo_path(&repo_path_from_clone_url(&candidate.http_url)) == want
}

/// 在已知仓库列表里找到 origin 对应的云效仓库。
fn find_codeup_repository<'a>(
    repository: &str,
    known: &'a [CodeupRepository],
) -> Option<&'a CodeupRepository> {
    known.iter().find(|r| codeup_repo_matches(repository, r))
}

/// 合并请求集合地址（**仓库级**）。
///
/// 组织级 `…/organizations/{org}/changeRequests` 只有列表 GET 存在；创建/查询单条都在
/// 仓库级路径下。历史上创建 MR 用了组织级路径，逐条 404（`Not Found`），
/// 表现为「点了发起合并请求，平台没收到」。
fn change_requests_url(org: &str, repository_id: &str) -> String {
    format!(
        "{API_BASE}/{CODUP_PREFIX}/organizations/{org}/repositories/{repository_id}/changeRequests"
    )
}

/// 按仓库路径取云效仓库数字 id（创建 MR / 读保护规则都要用）。
///
/// 匹配走 `find_codeup_repository`（归一化路径 + 克隆地址），不能按仓库名比：
/// 组织里存在同名仓库陷阱（`HSP/HIS` 与 `HSP_XC/HIS` 都叫 `HIS`）。
async fn codeup_repository_id_for(repository: &str) -> Result<String, String> {
    let repos = fetch_codeup_repositories().await?;
    find_codeup_repository(repository, &repos)
        .map(|r| r.id.clone())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            format!("未在云效组织内找到仓库 {repository}（检查该仓库的 git origin）")
        })
}

fn branch_rules_url(org: &str, repository_id: &str) -> String {
    format!(
        "{API_BASE}/{CODUP_PREFIX}/organizations/{org}/repositories/{repository_id}/protectedBranches"
    )
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

/// 从「用户对象」数组里取人名（`allowMergeUsers` / `defaultAssignees` 的元素形态）。
fn user_names_from(value: &serde_json::Value, keys: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in keys {
        let Some(arr) = value.get(key).and_then(serde_json::Value::as_array) else {
            continue;
        };
        for item in arr {
            let name = item
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    item.get("name")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            let name = name.trim().to_string();
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// 从 `protectedBranches` 的响应里挑出目标分支的默认评审人（纯函数，便于单测）。
///
/// 响应是**顶层数组**（每个受保护分支一条规则），但也兼容 `{rules|list|result: [...]}`
/// 的包裹形态——历史实现只认包裹形态，对顶层数组会退化成「拿整个数组当一条规则」，
/// 结果一个字段都取不到、静默返回空列表（实测踩到）。
///
/// 规则字段：`branch`（空表示通配）、`allowMergeUsers`（允许合并的人）、
/// `mergeRequestSetting.defaultAssignees`（该分支的默认评审人）。
/// 默认评审人排在前面（更贴近用户期望），`allowMergeUsers` 作为补充。
pub(crate) fn branch_reviewers_from_rules(json: &serde_json::Value, target_branch: &str) -> Vec<String> {
    let rules: &[serde_json::Value] = match json.as_array() {
        Some(arr) => arr.as_slice(),
        None => json
            .get("rules")
            .or_else(|| json.get("list"))
            .or_else(|| json.get("result"))
            .and_then(|v| v.as_array())
            .map(|a| a.as_slice())
            .unwrap_or_else(|| std::slice::from_ref(json)),
    };
    let target = target_branch.trim();
    let mut names: Vec<String> = Vec::new();
    let mut from_merge_users: Vec<String> = Vec::new();
    for rule in rules {
        if !rule.is_object() {
            continue;
        }
        let branch = rule
            .get("branch")
            .or_else(|| rule.get("branchName"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        // 规则里空 branch 表示通配；非空时必须与目标分支一致。
        if !branch.is_empty() && branch != target {
            continue;
        }
        if let Some(setting) = rule.get("mergeRequestSetting") {
            for name in user_names_from(setting, &["defaultAssignees"]) {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
        for name in user_names_from(rule, &["allowMergeUsers"]) {
            if !from_merge_users.contains(&name) {
                from_merge_users.push(name);
            }
        }
    }
    for name in from_merge_users {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// 读取某仓库某目标分支的**默认评审人**（「发起 MR」弹层的预填来源）。
///
/// 数据源是 `…/repositories/{id}/protectedBranches`：每个受保护分支规则带
/// `allowMergeUsers`（允许合并的人）与 `mergeRequestSetting.defaultAssignees`
/// （该分支的默认评审人），都是带 `name` 的用户对象。此前的 `…/repositories/{repo}/rule`
/// 路径不存在（404），前端把它包在 try/catch 里只 warn，于是预填永远是空的。
///
/// 返回人名（与弹层输入框同口径）；发起时后端再统一解析成云效 userID。
#[tauri::command]
pub async fn codeup_branch_managers(
    project_path: String,
    repo_path: Option<String>,
    target_branch: String,
) -> Result<Vec<String>, String> {
    let (token, _) = load_creds().await?;
    let repo = resolve_codeup_repo(&project_path, repo_path.as_deref()).await?;
    let org = repo_org_id(&repo);
    let repository_id = codeup_repository_id_for(&repo.repository).await?;
    let client = build_client()?;
    let bytes = crate::yunxiao::get_yunxiao_json(
        &client,
        &token,
        branch_rules_url(org, &repository_id),
    )
    .await?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析分支保护规则失败: {e}"))?;
    Ok(branch_reviewers_from_rules(&json, &target_branch))
}

/// 组织成员列表（供「发起 MR」弹层的评审人选择器）。
///
/// 返回 `[{ name, userId }]`：UI 展示 name，选中后只需把 name 发回后端即可
/// （`resolve_reviewer_ids` 统一做 name → userID 解析，重名会显式报错）。
#[tauri::command]
pub async fn codeup_list_members() -> Result<Vec<CodeupMemberEntry>, String> {
    Ok(fetch_org_members()
        .await?
        .into_iter()
        .map(|m| CodeupMemberEntry {
            name: m.name,
            user_id: m.user_id,
        })
        .collect())
}

/// `codeup_list_members` 的返回项。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodeupMemberEntry {
    pub name: String,
    pub user_id: String,
}

fn load_plan(project_id: &str, plan_id: &str) -> Result<DeliveryPlan, String> {
    load_project_batches_sync(project_id.to_string())?
        .into_iter()
        .find(|b| b.id == plan_id)
        .ok_or_else(|| "DeliveryPlan not found".to_string())
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
    let repository_id = find_codeup_repository(&repo.repository, &repos)
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

/// 组织成员（`GET /oapi/v1/platform/organizations/{org}/members` 分页返回）。
#[derive(Clone, Debug)]
pub struct CodeupMember {
    pub name: String,
    /// 云效用户 ID（`userId`）。合并请求的评审人字段收的就是这个值。
    pub user_id: String,
}

/// 组织成员列表的缓存条目：成员 + 拉取时刻（用于 TTL）。
struct MemberCacheEntry {
    members: Vec<CodeupMember>,
    fetched_at: std::time::Instant,
}

/// 组织成员列表缓存：`(org, token)` → 成员。
///
/// 发起 MR 时前端给的是**人名**（用户可编辑、可预填），而 changeRequests 的
/// `reviewerUserIds` 收的是云效 userID，必须做人名 → ID 的解析。成员表一页 100、
/// 当前组织 189 人，每次发起都重拉两页太浪费，故按组织缓存。
///
/// 带 TTL 而非永久缓存：新入职成员若因缓存而查不到，用户会持续拿到「找不到审核人」，
/// 且重试仍命中旧缓存，只能重启应用才能恢复。
static ORG_MEMBERS_CACHE: LazyLock<Mutex<HashMap<String, MemberCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 成员表缓存有效期。
const MEMBER_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

const MEMBER_PAGE_SIZE: u32 = 100;
const MAX_MEMBER_PAGES: u32 = 20;

/// 拉取组织全量成员（分页），按 `(org, token)` 缓存（带 TTL）。
pub(crate) async fn fetch_org_members() -> Result<Vec<CodeupMember>, String> {
    let (token, org) = load_creds().await?;
    if org.trim().is_empty() {
        return Err("云效组织 ID 不能为空（请在应用设置中配置）".to_string());
    }
    let cache_key = format!("{org}\u{0}{token}");
    if let Some(entry) = ORG_MEMBERS_CACHE.lock().get(&cache_key) {
        if entry.fetched_at.elapsed() < MEMBER_CACHE_TTL {
            return Ok(entry.members.clone());
        }
    }
    let client = build_client()?;
    let mut out: Vec<CodeupMember> = Vec::new();
    for page in 1..=MAX_MEMBER_PAGES {
        let url = format!(
            "{API_BASE}/oapi/v1/platform/organizations/{org}/members?page={page}&perPage={MEMBER_PAGE_SIZE}"
        );
        let bytes = crate::yunxiao::get_yunxiao_json(&client, &token, url).await?;
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("解析云效成员列表失败: {e}"))?;
        let arr = json
            .as_array()
            .or_else(|| json.get("list").and_then(|v| v.as_array()))
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        if arr.is_empty() {
            break;
        }
        let page_len = arr.len();
        for item in arr {
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let user_id = item
                .get("userId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if name.is_empty() || user_id.is_empty() {
                continue;
            }
            out.push(CodeupMember { name, user_id });
        }
        if page_len < MEMBER_PAGE_SIZE as usize {
            break;
        }
    }
    ORG_MEMBERS_CACHE.lock().insert(
        cache_key,
        MemberCacheEntry {
            members: out.clone(),
            fetched_at: std::time::Instant::now(),
        },
    );
    Ok(out)
}

/// 把前端传进来的审核人（可能是人名，也可能已经是 userID）解析成云效 userID。
///
/// 解析不出来的名字**必须报错**：静默丢掉会发出一条「没有评审人」的 MR，而用户以为
/// 自己已经指定了审核人——这种静默降级比发起失败更难发现。成员列表拉取失败时若入参
/// 本身已是 ID 形态（32 位十六进制）则直接放行，避免网络抖动卡住发起。
pub(crate) fn resolve_reviewer_ids(
    reviewers: &[String],
    members: &[CodeupMember],
) -> Result<Vec<String>, String> {
    let mut ids: Vec<String> = Vec::new();
    for raw in reviewers {
        let name = raw.trim();
        if name.is_empty() {
            continue;
        }
        // 已经是 userID（云效 userID 是 24 位十六进制）就直接用。
        if name.len() == 24 && name.chars().all(|c| c.is_ascii_hexdigit()) {
            if !ids.contains(&name.to_string()) {
                ids.push(name.to_string());
            }
            continue;
        }
        let matched: Vec<&CodeupMember> = members.iter().filter(|m| m.name == name).collect();
        match matched.as_slice() {
            [] => {
                // 成员表没拉到（空）时不阻断：可能只是列表接口抖动，交给服务端裁决。
                if members.is_empty() {
                    return Err(format!(
                        "无法解析审核人「{name}」：未取到云效组织成员列表，请稍后重试或改填用户 ID"
                    ));
                }
                return Err(format!(
                    "云效组织成员里找不到审核人「{name}」，请检查姓名或改填云效用户 ID"
                ));
            }
            [only] => {
                if !ids.contains(&only.user_id) {
                    ids.push(only.user_id.clone());
                }
            }
            _ => {
                return Err(format!(
                    "审核人「{name}」在云效组织里有重名，请改填云效用户 ID"
                ));
            }
        }
    }
    Ok(ids)
}

/// 创建成功的合并请求标识。
///
/// `local_id` 是**权威**标识：云效所有 MR 详情 / 动作路径段
/// （`…/repositories/{repositoryId}/changeRequests/{localId}`）收的都是它。
/// 官方 `ChangeRequest` 响应模型里**没有** `id` / `mrBizId`——那套是**列表**接口
/// （`…/organizations/{org}/changeRequests`）的形状，创建/详情返回的是另一套。
/// 创建后能用于后续查状态的只有 `localId`。
#[derive(Clone, Debug, PartialEq, Eq)]
struct CreatedChangeRequest {
    local_id: i64,
    /// 业务 id（`mrBizId`）。创建响应通常不带；带上时留作记录，不做路径参数。
    biz_id: Option<String>,
}

/// JSON 值 → i64（云效同一字段在不同接口会以数字或字符串给出）。
fn json_as_i64(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
}

/// 从创建 MR 的响应里解析出 MR 标识（纯函数，便于单测）。
///
/// **只认 `localId`**：它是后续路径操作的唯一可用标识。刻意不退化成取 `id`——
/// 官方响应模型没有该字段，一旦服务端某天补上（含义未知），把它写进批次记录就会让
/// 「删除批次时的已合并门禁」拿着错编号去查，报出 `Invalid param value` 这类
/// 与真实原因无关的错。宁可在这里明确报错，也不要存一个语义不明的值。
fn parse_created_change_request(json: &serde_json::Value) -> Result<CreatedChangeRequest, String> {
    let item = json.get("result").unwrap_or(json);
    let local_id = item
        .get("localId")
        .or_else(|| json.get("localId"))
        .and_then(json_as_i64)
        .ok_or_else(|| {
            "创建合并请求已成功，但响应里没有 localId，无法记录该 MR（请到云效上确认）".to_string()
        })?;
    let biz_id = item
        .get("mrBizId")
        .or_else(|| json.get("mrBizId"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty());
    Ok(CreatedChangeRequest { local_id, biz_id })
}

/// 在 Codeup 上创建合并请求（仅提交、不合并）的**去批次化**核心。
///
/// 抽出来供两条链路共用：分支批的 `codeup_create_mr`（回写批记录）与「待发起」视图的
/// `codeup_create_mrs_batch`（逐条回执）。调用方负责先解析出组织 id、仓库 id、推送源分支。
///
/// 路径是**仓库级**的 `…/repositories/{repositoryId}/changeRequests`：组织级
/// `…/organizations/{org}/changeRequests` 只有列表 GET 存在，POST 会 404（这正是「发起合并
/// 请求后平台没收到」的真因）。请求体同样以官方契约为准：`reviewerUserIds`（收 userID，
/// 不是人名）+ `sourceProjectId`/`targetProjectId` + `createFrom`。
#[allow(clippy::too_many_arguments)]
async fn post_change_request(
    client: &reqwest::Client,
    token: &str,
    org: &str,
    repository_id: &str,
    source_branch: &str,
    target_branch: &str,
    title: &str,
    description: &str,
    reviewer_ids: &[String],
) -> Result<CreatedChangeRequest, String> {
    let url = change_requests_url(org, repository_id);
    let body = serde_json::json!({
        "title": title,
        "description": description,
        "sourceBranch": source_branch,
        "targetBranch": target_branch,
        // 官方契约：仓库数字 ID 必须回传，缺省时云效会尝试自动推断，失败即 500。
        "sourceProjectId": repository_id,
        "targetProjectId": repository_id,
        "createFrom": "WEB",
        "reviewerUserIds": reviewer_ids,
    });
    let resp = client
        .post(url)
        .header("x-yunxiao-token", token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("创建合并请求失败: {e}"))?;
    let bytes = read_json_body(resp).await?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析创建合并请求响应失败: {e}"))?;
    parse_created_change_request(&json)
}

/// 本地是否存在该 ref（`rev-parse --verify --quiet`）。
fn ref_exists(dir: &str, name: &str) -> bool {
    run_git(dir, &["rev-parse", "--verify", "--quiet", name])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 源分支相对目标分支的提交数——创建代码评审的前提。
///
/// 云效对「源分支相对目标分支没有改动」会回
/// `400 MERGE_REQUEST_VALIDATE_ERROR: 源分支或提交不存在/没有改动`，用户拿到的是一串
/// 英文 API 报文，且分支已经被白推上去。这里提前判掉，给出可操作的中文提示，
/// 也省掉那次无意义的 push。
///
/// 返回 `Some(0)` = **确定**没有改动，应当拦下；`None` = 判不了（缺 ref / 远端不可达），
/// 此时**放行**交给云效裁决——本地信息不全时误拦合法 MR 的代价更高。
///
/// 目标 ref 优先取 `origin/<target>`：云效比的是**远端**目标分支，本地 `<target>` 可能
/// 是过期快照。`fetch` 为 true 时先拉一次目标分支（失败不阻断，退回本地已有 ref）。
///
/// 拦下是否可靠：`origin/<target>..<source>` 计数为 0 说明源分支是目标 ref 的祖先，
/// 而目标 ref 不会比远端更新（只能由 fetch 前进），故源分支也确实不含远端目标没有的提交。
async fn source_branch_ahead_count(
    dir: &str,
    source: &str,
    target: &str,
    fetch: bool,
) -> Option<u64> {
    let (source, target) = (source.trim(), target.trim());
    if source.is_empty() || target.is_empty() {
        return None;
    }
    if fetch {
        // 目标分支取最新远端；失败不阻断（离线 / 无权限时退回本地 ref 继续判）。
        let _ = crate::git::run_git_with_timeout(
            dir.to_string(),
            vec!["fetch".into(), "origin".into(), target.to_string()],
            std::time::Duration::from_secs(300),
        )
        .await;
    }
    let (dir, source, target) = (dir.to_string(), source.to_string(), target.to_string());
    tauri::async_runtime::spawn_blocking(move || -> Option<u64> {
        let target_ref = if ref_exists(&dir, &format!("origin/{target}")) {
            format!("origin/{target}")
        } else if ref_exists(&dir, &target) {
            target.clone()
        } else {
            return None;
        };
        // 源分支优先用本地 ref：它就是即将被 push 的那份内容。
        let source_ref = if ref_exists(&dir, &source) {
            source.clone()
        } else if ref_exists(&dir, &format!("origin/{source}")) {
            format!("origin/{source}")
        } else {
            return None;
        };
        let range = format!("{target_ref}..{source_ref}");
        let out = run_git(&dir, &["rev-list", "--count", &range]).ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().ok()
    })
    .await
    .ok()
    .flatten()
}

/// 「源分支无改动」的统一提示（两条链路共用，措辞一致）。
const NO_CHANGES_HINT: &str =
    "源分支相对目标分支没有改动，无法创建代码评审（请先在该分支上提交改动）";

/// 在 Codeup 上创建合并请求；仅提交（不合并）。成功后回写批的 mrId/mrStatus，status=review。
#[tauri::command]
pub async fn codeup_create_mr(
    project_path: String,
    repo_path: Option<String>,
    project_id: String,
    plan_id: String,
    reviewers: Vec<String>,
) -> Result<DeliveryPlan, String> {
    let (token, _) = load_creds().await?;
    let batch = load_plan(&project_id, &plan_id)?;
    if batch.status != "active" {
        return Err("计划不是进行中状态，无法提交 MR".to_string());
    }
    if batch.target_branch.trim().is_empty() {
        return Err("该批未指定合并回目标分支，无法提交 MR；请补记目标分支后重试".to_string());
    }
    let worktree_str = path_to_string(
        &std::path::Path::new(&project_path)
            .join(".nezha")
            .join("worktrees")
            .join(&plan_id),
    )?;
    // 无 worktree 的批：分支就在主工作区里，push / rev-parse 都在仓库根执行。
    // 脏文件判定跳过——主工作区常驻开发状态，拿 worktree 的「必须干净」标准会误拦。
    let push_dir = if batch.use_worktree {
        batch.worktree_path.clone().unwrap_or(worktree_str)
    } else {
        crate::git::resolve_repo_path(&project_path, batch.worktree_repo.as_deref()).await?
    };
    if batch.use_worktree {
        if let Some(dirty) = crate::git::worktree_dirty_reason(&push_dir)? {
            return Err(format!(
                "提交 MR 前 worktree 仍有未提交内容，请先处理：{dirty}"
            ));
        }
    } else {
        // 无 worktree 的批只在创建时切过一次分支，之后主检出可能漂移（改名 / 人工切换）。
        // push 按 batch.branch 推本地 ref，但用户实际提交可能落在别的分支上——HEAD 不是
        // 批分支时提前拦下，避免把「批分支指针推上去但内容为空」的 MR 建出来。
        let head = crate::git::current_branch_name(&push_dir)?;
        if head != batch.branch {
            let shown = if head.is_empty() {
                "游离 HEAD".to_string()
            } else {
                head
            };
            return Err(format!(
                "当前检出分支是「{shown}」，不是计划分支「{}」；请先切到计划分支再提交 MR",
                batch.branch
            ));
        }
    }

    // 创建代码评审的前提：源分支相对目标分支必须有改动，否则云效会回
    // `MERGE_REQUEST_VALIDATE_ERROR`。提前拦下，避免白推一次分支 + 让用户读 API 报文。
    // 判不了（缺 ref / 离线）时放行，交给云效裁决。
    if source_branch_ahead_count(&push_dir, &batch.branch, &batch.target_branch, true).await
        == Some(0)
    {
        return Err(NO_CHANGES_HINT.to_string());
    }

    // 云效侧定位与审核人解析都放在 push **之前**：这些都是能提前判定的失败，
    // 一旦不通过就地返回、不产生任何推送副作用。反过来（先推再解析）会让分支
    // 白推上去却发不出一条 MR——正是批量链路明确避免的情形。
    let repo = resolve_codeup_repo(&project_path, repo_path.as_deref()).await?;
    let org = repo_org_id(&repo);
    let client = build_client()?;
    // 创建接口是仓库级路径，必须先拿到云效仓库数字 id（网络拉取，失败即报错——
    // 猜一个 id 只会换来一个更难理解的 404/500）。
    let repository_id = codeup_repository_id_for(&repo.repository).await?;
    // 审核人由前端以「人名」传来（默认取自目标分支的评审人），这里换成云效 userID。
    let reviewers = resolve_reviewer_ids(&reviewers, &fetch_org_members().await?)?;

    // 非 force push 源分支，保证 MR 引用远端已有提交；再取提交时的 HEAD。
    let push = run_git(&push_dir, &["push", "origin", &batch.branch])?;
    if !push.status.success() {
        return Err(format!(
            "推送源分支失败（不会 force push）：{}",
            String::from_utf8_lossy(&push.stderr).trim()
        ));
    }
    let head_out = run_git(&push_dir, &["rev-parse", "HEAD"])?;
    if !head_out.status.success() {
        return Err(String::from_utf8_lossy(&head_out.stderr).trim().to_string());
    }
    let source_sha = String::from_utf8_lossy(&head_out.stdout).trim().to_string();

    let created = post_change_request(
        &client,
        &token,
        org,
        &repository_id,
        &batch.branch,
        &batch.target_branch,
        &batch.name,
        &format!("由 Nezha 分支批 {} 发起（{}）", batch.id, batch.kind),
        &reviewers,
    )
    .await?;

    let mut batches = load_project_batches_sync(project_id.clone())?;
    let updated = batches
        .iter_mut()
        .find(|b| b.id == plan_id)
        .ok_or_else(|| "DeliveryPlan not found".to_string())?;
    // mr_id 存 **localId**：云效的 MR 详情/动作路径段收的就是它，删除批次时的
    // 「已合并门禁」也正是拿这个值去查状态（见 batch_mr_is_merged）。
    updated.mr_id = Some(created.local_id.to_string());
    updated.mr_status = Some("opened".to_string());
    updated.status = "review".to_string();
    updated.mr_source_sha = Some(source_sha);
    let result = updated.clone();
    save_project_batches_sync(project_id, batches)?;
    Ok(result)
}

// ── 「待发起」视图的批量发起合并请求 ─────────────────────────────────────────

/// 批量发起合并请求的单项输入。
///
/// 刻意**不绑定分支批**：`codeup_create_mr` 要求 `plan_id` 存在、批次 active 且带干净
/// worktree，而「待发起」视图覆盖的正是 agent 用 `git checkout -b` 自建、或用户手推的分支，
/// 它们没有批次记录。这里只依赖仓库路径 + 源/目标分支，满足「到点发起」的闭环。
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MrCreateItem {
    /// 仓库绝对路径（多仓库项目下是子模块路径）。
    pub repo_path: String,
    /// 仓库显示名（仅用于回执回显）。
    #[serde(default)]
    pub repo: String,
    pub source_branch: String,
    pub target_branch: String,
    /// MR 标题；缺省用源分支名。
    #[serde(default)]
    pub title: Option<String>,
    /// MR 描述；缺省给出「由 Nezha 发起」的说明。
    #[serde(default)]
    pub description: Option<String>,
    /// 审核人（默认由前端按目标分支保护规则预填，可编辑）。
    #[serde(default)]
    pub reviewers: Vec<String>,
}

/// 批量发起的逐条回执。单条失败不中断整批，失败原因逐条给出。
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MrCreateReceipt {
    pub repo: String,
    pub repo_path: String,
    pub source_branch: String,
    pub target_branch: String,
    /// 本次是否真的创建了 MR（幂等跳过 / 失败时 false）。
    pub created: bool,
    /// 新建 MR 的业务 id（`mrBizId`）。创建响应通常不带，故多为 `None`。
    pub mr_id: Option<String>,
    /// 仓库内 MR 编号（`localId`）——云效 MR 详情/动作路径段收的就是它。
    pub mr_local_id: Option<i64>,
    /// 结果说明：成功 / 幂等跳过 / 失败原因。
    pub reason: String,
}

/// 批量发起合并请求（去批次化）。
///
/// 与删除同理，这是**对外可见且难以撤销**的推送动作，因此逐条给回执、单条失败不中断，
/// 并在创建前做幂等判重（同一「仓库 + 源分支 + 目标分支」已有开放 MR 就跳过，不重复发起）。
///
/// 每条的处理顺序：路径校验 → 解析云效仓库 id → 幂等判重 → **无改动预检** →
/// 审核人解析 → 非 force push 源分支 → POST changeRequests。
/// 全部可提前判定的失败都排在 push 之前，确保不产生推送副作用。
/// 路径安全：每个仓库路径都必须在项目内（在产生任何推送副作用之前校验）。
#[tauri::command]
pub async fn codeup_create_mrs_batch(
    project_path: String,
    items: Vec<MrCreateItem>,
) -> Result<Vec<MrCreateReceipt>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    validate_project_path(&project_path)?;
    let (token, _) = load_creds().await?;
    let client = build_client()?;
    // 已知仓库列表一次拉全：既用于把本地仓库映射到云效仓库 id（幂等判重），
    // 也避免逐条打仓库列表接口。拉不到不整体失败——逐条回执会如实标注。
    let known_repos = fetch_codeup_repositories().await.unwrap_or_default();

    // 路径边界校验 + 「仓库 → 云效仓库 id / 组织」解析：都要跑进程与文件系统，
    // 且**必须在任何推送之前**完成——越界路径不允许产生任何副作用。
    let wanted: Vec<(String, String)> = items
        .iter()
        .map(|item| (item.repo_path.clone(), item.repo.clone()))
        .collect();
    let resolved = {
        let known_repos = known_repos.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ResolvedMrRepo>, String> {
            let mut out = Vec::new();
            for (repo_path, repo) in wanted {
                // canonicalize + starts_with 校验；越界立即报错，不做任何推送。
                let dir = crate::git::resolve_repo_path_blocking(&project_path, Some(&repo_path))?;
                // 组织 id 与仓库路径都从 origin URL 解析（与 codeup_create_mr 同口径）。
                let output = run_git(&dir, &["remote", "get-url", "origin"])?;
                let org = if output.status.success() {
                    parse_codeup_remote(String::from_utf8_lossy(&output.stdout).trim())
                        .map(|(org, _)| org)
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let repository_id =
                    resolve_codeup_repository_id_blocking(&dir, &known_repos)
                        .ok()
                        .flatten()
                        .map(|(_, id)| id)
                        .unwrap_or_default();
                out.push(ResolvedMrRepo {
                    repo,
                    dir,
                    org,
                    repository_id,
                });
            }
            Ok(out)
        })
        .await
        .map_err(|e| format!("codeup_create_mrs_batch panicked: {e}"))??
    };

    // 幂等判据：一次拉全组织内开放 MR，按 (repositoryId, source, target) 判重。
    let open_mrs = fetch_open_change_requests().await.unwrap_or_default();
    // 审核人解析材料：一次拉全成员表，供逐条把人名换成云效 userID。
    // 拉不到时留空 —— `resolve_reviewer_ids` 会对「有审核人但无成员表」显式报错，
    // 不会静默发出没有评审人的 MR。
    let members = fetch_org_members().await.unwrap_or_default();

    let mut out: Vec<MrCreateReceipt> = Vec::new();
    for (item, resolved) in items.into_iter().zip(resolved) {
        let mut receipt = MrCreateReceipt {
            repo: if resolved.repo.is_empty() {
                item.repo.clone()
            } else {
                resolved.repo.clone()
            },
            repo_path: resolved.dir.clone(),
            source_branch: item.source_branch.clone(),
            target_branch: item.target_branch.clone(),
            created: false,
            mr_id: None,
            mr_local_id: None,
            reason: String::new(),
        };

        if resolved.org.is_empty() {
            receipt.reason =
                "未找到 git origin 远端，无法定位云效仓库（检查该仓库的 origin）".to_string();
            out.push(receipt);
            continue;
        }

        // 创建接口是仓库级路径，必须先有云效仓库数字 id；缺了就直接跳过并说明原因，
        // 不去猜一个 id（猜错只会换来一个更难懂的 404）。
        if resolved.repository_id.is_empty() {
            receipt.reason = format!(
                "未在云效组织内找到仓库 {}（检查该仓库的 git origin）",
                resolved.repo
            );
            out.push(receipt);
            continue;
        }

        // 幂等：同源 + 同目标已有开放 MR 就跳过，避免重复发起。
        // 放在无改动预检 / 审核人解析之前：命中幂等时那两项都不必算。
        if let Some(existing) = open_mrs.iter().find(|mr| {
            mr.repository_id == resolved.repository_id
                && mr.source_branch == item.source_branch
                && mr.target_branch == item.target_branch
        }) {
            receipt.mr_local_id = Some(existing.local_id);
            receipt.reason = format!("已有开放合并请求 #{}，跳过", existing.local_id);
            out.push(receipt);
            continue;
        }

        // 创建代码评审的前提：源分支相对目标分支必须有改动。提前拦下，避免白推一次分支
        // + 让用户读云效的 API 报文。放在审核人解析**之前**：这是纯本地判定（无网络），
        // 且「没有改动」比「审核人写错」更根本——先让用户看到它，省一次往返。
        //
        // `fetch=false`：本函数要对一批分支逐条处理，逐条 fetch 目标分支会让整批慢很多。
        // 用本地 `origin/<target>` 判「是否有改动」仍然可靠——目标 ref 只会被 fetch 推向前，
        // 源分支是它的祖先时对**更新的**远端目标同样没有改动。判不了（ref 缺失）时放行。
        if source_branch_ahead_count(
            &resolved.dir,
            &item.source_branch,
            &item.target_branch,
            false,
        )
        .await
            == Some(0)
        {
            receipt.reason = NO_CHANGES_HINT.to_string();
            out.push(receipt);
            continue;
        }

        let reviewer_ids = match resolve_reviewer_ids(&item.reviewers, &members) {
            Ok(ids) => ids,
            Err(e) => {
                receipt.reason = e;
                out.push(receipt);
                continue;
            }
        };

        // 非 force push 源分支：MR 必须引用远端已有提交。
        let dir_for_push = resolved.dir.clone();
        let source_branch = item.source_branch.clone();
        let push = tauri::async_runtime::spawn_blocking(move || {
            run_git(&dir_for_push, &["push", "origin", &source_branch])
        })
        .await
        .map_err(|e| format!("codeup_create_mrs_batch panicked: {e}"))?;
        match push {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                receipt.reason = format!(
                    "推送源分支失败（不会 force push）：{}",
                    String::from_utf8_lossy(&o.stderr).trim()
                );
                out.push(receipt);
                continue;
            }
            Err(e) => {
                receipt.reason = format!("推送源分支失败：{e}");
                out.push(receipt);
                continue;
            }
        }

        let title = item
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| item.source_branch.clone());
        let description = item
            .description
            .clone()
            .filter(|d| !d.trim().is_empty())
            .unwrap_or_else(|| {
                format!(
                    "由 Nezha 待发起视图发起（{} → {}）",
                    item.source_branch, item.target_branch
                )
            });

        match post_change_request(
            &client,
            &token,
            &resolved.org,
            &resolved.repository_id,
            &item.source_branch,
            &item.target_branch,
            &title,
            &description,
            &reviewer_ids,
        )
        .await
        {
            Ok(created) => {
                receipt.created = true;
                receipt.mr_id = created.biz_id;
                receipt.mr_local_id = Some(created.local_id);
                receipt.reason = format!(
                    "已发起合并请求（{} → {}）",
                    item.source_branch, item.target_branch
                );
            }
            Err(e) => receipt.reason = e,
        }
        out.push(receipt);
    }
    Ok(out)
}

/// `codeup_create_mrs_batch` 在 `spawn_blocking` 里解析出的仓库定位信息。
#[derive(Debug)]
struct ResolvedMrRepo {
    /// 仓库显示名（仅用于回执回显）。
    repo: String,
    /// 仓库绝对路径（canonicalize 后，已校验在项目内）。
    dir: String,
    /// 云效组织 id（origin URL 的第一段）。
    org: String,
    /// 云效仓库 id（幂等判重用；不在云效列表里时为空）。
    repository_id: String,
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
pub(crate) async fn fetch_codeup_repositories() -> Result<Vec<CodeupRepository>, String> {
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

// ── 「待发起」视图用的平台侧只读数据 ──────────────────────────────────────────

/// 平台分支条目（只取受保护判定所需字段；作者/时间以本地 git 为准）。
#[derive(Clone, Debug)]
pub(crate) struct CodeupBranchInfo {
    pub name: String,
    /// 平台侧受保护标志。覆盖面比 git 侧硬编码口径更广（如 `develop-old`）。
    pub is_protected: bool,
    /// 平台侧默认分支标志。
    pub is_default: bool,
}

/// 平台上的开放合并请求（仅保留评审中 / 待合并 / 已通过）。
///
/// 只带「前端要展示 + join 要用」的字段，避免塞进大量用不到的 MR 详情。
#[derive(Clone, Debug)]
pub(crate) struct OpenChangeRequest {
    pub repository_id: String,
    pub source_branch: String,
    /// 目标分支。发起前的幂等判据要用「同源 + 同目标」才精确：同一条源分支指向不同目标分支
    /// 是两个不同的合并请求，不能因为源分支同名就跳过。
    pub target_branch: String,
    pub local_id: i64,
    /// `UNDER_REVIEW` / `TO_BE_MERGED` / `APPROVED`。
    pub state: String,
    pub has_conflict: bool,
}

/// 与云效「已开启」口径一致：评审中 + 已通过(待合并) 都算开放。
pub(crate) fn is_open_mr_state(state: &str) -> bool {
    matches!(state, "UNDER_REVIEW" | "TO_BE_MERGED" | "APPROVED")
}

const BRANCH_PAGE_SIZE: u32 = 100;
const MAX_BRANCH_PAGES: u32 = 5;

fn repository_branches_url(org: &str, repository_id: &str) -> String {
    format!(
        "{API_BASE}/{CODUP_PREFIX}/organizations/{org}/repositories/{repository_id}/branches"
    )
}

/// 拉取某仓库的分支列表（含平台侧 `protected` / `defaultBranch`）。
///
/// 平台不可达时调用方回落 git 侧判据——本函数只做一次只读分页拉取，失败即 `Err`。
pub(crate) async fn fetch_codeup_branches(
    repository_id: &str,
) -> Result<Vec<CodeupBranchInfo>, String> {
    let (token, org_id) = load_creds().await?;
    let client = build_client()?;
    let mut out: Vec<CodeupBranchInfo> = Vec::new();
    for page in 1..=MAX_BRANCH_PAGES {
        let url = format!(
            "{}?page={page}&perPage={BRANCH_PAGE_SIZE}",
            repository_branches_url(&org_id, repository_id)
        );
        let bytes = crate::yunxiao::get_yunxiao_json(&client, &token, url).await?;
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("解析分支列表失败: {e}"))?;
        let arr = json
            .as_array()
            .or_else(|| json.get("list").and_then(|v| v.as_array()))
            .or_else(|| json.get("result").and_then(|v| v.as_array()))
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        if arr.is_empty() {
            break;
        }
        let page_len = arr.len();
        for item in arr {
            let name = item
                .get("name")
                .or_else(|| item.get("branchName"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if name.is_empty() {
                continue;
            }
            out.push(CodeupBranchInfo {
                name,
                is_protected: item
                    .get("protected")
                    .or_else(|| item.get("isProtected"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                is_default: item
                    .get("defaultBranch")
                    .or_else(|| item.get("isDefault"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            });
        }
        if page_len < BRANCH_PAGE_SIZE as usize {
            break;
        }
    }
    Ok(out)
}

/// 一次拉全组织内的开放 MR（分页），供「本地分支 → 是否有开放 MR」的内存 join。
///
/// 首页失败直接返回 `Err`：凭据 / 网络故障必须暴露给用户，不能被前端误读成「没有待发起分支」。
/// 逐分支查询被明确否决——那是 O(分支数) 次网络往返。
pub(crate) async fn fetch_open_change_requests() -> Result<Vec<OpenChangeRequest>, String> {
    let (token, _) = load_creds().await?;
    let client = build_client()?;
    let org_id = crate::app_settings::load_app_settings()
        .await?
        .yunxiao
        .organization_id
        .trim()
        .to_string();
    let url_base = format!("{API_BASE}/{CODUP_PREFIX}/organizations/{org_id}/changeRequests");
    let mut out: Vec<OpenChangeRequest> = Vec::new();
    let mut expected_page_len: Option<usize> = None;
    for page in 1..=MAX_CHANGE_PAGES {
        let url = format!("{url_base}?page={page}&perPage={CHANGE_PAGE_SIZE}");
        let bytes = match crate::yunxiao::get_yunxiao_json(&client, &token, url).await {
            Ok(b) => b,
            Err(e) if page == 1 => return Err(format!("拉取云效合并请求列表失败: {e}")),
            Err(_) => break,
        };
        let json: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) if page == 1 => return Err(format!("解析云效合并请求列表失败: {e}")),
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
            if !is_open_mr_state(&state) {
                continue;
            }
            open_on_page += 1;
            let repository_id = item
                .get("projectId")
                .and_then(|v| {
                    v.as_i64().map(|i| i.to_string()).or_else(|| {
                        v.as_str().map(|s| s.trim().to_string())
                    })
                })
                .unwrap_or_default();
            let source_branch = item
                .get("sourceBranch")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if repository_id.is_empty() || source_branch.is_empty() {
                continue;
            }
            out.push(OpenChangeRequest {
                repository_id,
                source_branch,
                target_branch: item
                    .get("targetBranch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                local_id: item.get("localId").and_then(|v| v.as_i64()).unwrap_or(0),
                state,
                has_conflict: item
                    .get("hasConflict")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            });
        }
        // 云效按近期活跃排序；某页（非首页）没有开放状态 MR 说明已扫完开放集群，提前结束。
        if open_on_page == 0 && page > 1 {
            break;
        }
        if page_len < expected_page_len.unwrap_or(page_len) || page_len < MIN_CHANGE_PAGE_SIZE {
            break;
        }
    }
    Ok(out)
}

/// 解析本地仓库对应的云效仓库（仓库路径 + 仓库 id），**同步**版本。
///
/// 必须按 `pathWithNamespace` 匹配：实测存在同名仓库陷阱（`HSP/HIS` 与 `HSP_XC/HIS` 都叫
/// `HIS`），按 name 匹配会选错仓库。`None` 表示该仓库不在云效仓库列表里（例如本地独有仓库）
/// 或没有 `origin` 远端。
///
/// 同步而非 async：内部要跑 `git remote get-url`（进程启动），按仓库既有规范必须由调用方放在
/// `spawn_blocking` 里，不能直接落在异步运行时上。`known` 让调用方复用已拉取的仓库列表。
pub(crate) fn resolve_codeup_repository_id_blocking(
    repo_path: &str,
    known: &[CodeupRepository],
) -> Result<Option<(String, String)>, String> {
    let cwd = crate::git::resolve_repo_path_blocking(repo_path, None)?;
    let output = run_git(&cwd, &["remote", "get-url", "origin"])
        .map_err(|e| format!("读取 git 远端失败（请确认项目可访问远端）: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let (_, repository) = match parse_codeup_remote(&url) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    Ok(find_codeup_repository(&repository, known).map(|r| (repository, r.id.clone())))
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
            if !is_open_mr_state(&state) {
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

/// 按仓库 id + MR **局部编号**拼 change 详情/动作地址。
///
/// 路径段收的是 `localId`（仓库内第几个 MR），不是列表里的 `mrBizId`：
/// 实测传 mrBizId 返回 `Invalid param value`。调用方必须传 localId。
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

/// 管理人「通过」（approve）一条 MR。
///
/// 官方契约是 `…/{localId}/review` + `reviewOpinion: "PASS"`（此前用的
/// `…/submitReview` + `{state:"APPROVED"}` 是推断值，子路径不存在）。
#[tauri::command]
pub async fn codeup_approve_mr(repository_id: String, mr_id: String) -> Result<String, String> {
    let (token, org_id) = load_creds().await?;
    let client = build_client()?;
    let url = format!("{}/review", change_item_url(&org_id, &repository_id, &mr_id));
    let resp = client
        .post(url)
        .header("x-yunxiao-token", &token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "reviewOpinion": "PASS" }))
        .send()
        .await
        .map_err(|e| format!("通过合并请求失败: {e}"))?;
    read_json_body(resp).await?;
    Ok(mr_id)
}

/// 管理人「合并」一条 MR（Codeup 侧真正合并）。
///
/// 官方契约字段是 `mergeType`（驼峰，取值 `ff-only` / `no-fast-forward` / `squash` /
/// `rebase`），此前发的是下划线的 `merge_type`。
#[tauri::command]
pub async fn codeup_merge_mr(
    repository_id: String,
    mr_id: String,
    merge_type: Option<String>,
) -> Result<String, String> {
    let (token, org_id) = load_creds().await?;
    let client = build_client()?;
    let url = format!("{}/merge", change_item_url(&org_id, &repository_id, &mr_id));
    let merge_type = merge_type
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "no-fast-forward".to_string());
    let resp = client
        .post(url)
        .header("x-yunxiao-token", &token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "mergeType": merge_type }))
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

/// MR 评论内容上限（Codeup CreateChangeRequestComment 文档为 1-65535 字，留余量）。
const MAX_MR_COMMENT_CHARS: usize = 60000;

/// MR 评论地址（CreateChangeRequestComment / ListMergeRequestComments 共用前缀）。
fn change_comments_url(org: &str, repository_id: &str, mr_id: &str) -> String {
    format!(
        "{}/comments",
        change_item_url(org, repository_id, mr_id)
    )
}

/// 拉取该 MR 最新 patch set 的 biz id（评论要求关联版本；取 versionNo 最大的版本）。
async fn fetch_latest_patchset_biz_id(
    client: &reqwest::Client,
    token: &str,
    org: &str,
    repository_id: &str,
    mr_id: &str,
) -> Result<String, String> {
    let url = format!("{}/diffs/patches", change_item_url(org, repository_id, mr_id));
    let bytes = crate::yunxiao::get_yunxiao_json(client, token, url).await?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析 MR 版本列表失败: {e}"))?;
    let arr = json.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
    let mut best: Option<(i64, String)> = None;
    for item in arr {
        let version = item.get("versionNo").and_then(|v| v.as_i64()).unwrap_or(0);
        let biz = item
            .get("patchSetBizId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if biz.is_empty() {
            continue;
        }
        if best.as_ref().map_or(true, |(v, _)| version >= *v) {
            best = Some((version, biz));
        }
    }
    Ok(best.map(|(_, b)| b).unwrap_or_default())
}

/// 在该 MR 下发表一条全局（整体）评论，`content` 为 Markdown 文本。
/// 供审查报告「回写到评论」用：评论要求关联 patch set，取不到最新版本时传空串由服务端兜底。
#[tauri::command]
pub async fn codeup_create_mr_comment(
    repository_id: String,
    mr_id: String,
    content: String,
) -> Result<String, String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("评论内容不能为空".to_string());
    }
    if content.chars().count() > MAX_MR_COMMENT_CHARS {
        return Err(format!("评论内容超过 {MAX_MR_COMMENT_CHARS} 字上限"));
    }
    let (token, org_id) = load_creds().await?;
    let client = build_client()?;
    let patchset_biz_id =
        fetch_latest_patchset_biz_id(&client, &token, &org_id, &repository_id, &mr_id)
            .await
            .unwrap_or_default();
    let url = change_comments_url(&org_id, &repository_id, &mr_id);
    let resp = client
        .post(url)
        .header("x-yunxiao-token", &token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "content": content,
            "comment_type": "GLOBAL_COMMENT",
            "draft": false,
            "resolved": false,
            "patchset_biz_id": patchset_biz_id,
        }))
        .send()
        .await
        .map_err(|e| format!("发送合并请求评论失败: {e}"))?;
    let bytes = read_json_body(resp).await?;
    let json: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("解析合并请求评论响应失败: {e}"))?;
    let comment_id = json
        .get("comment_biz_id")
        .or_else(|| json.get("result").and_then(|r| r.get("comment_biz_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(if comment_id.is_empty() { mr_id } else { comment_id })
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
    // 保留 `.nezha/review-<mrId>.json`（逐项判定）与 `.nezha/review-report-<mrId>.md`（总结报告）：
    // 合并前的 fail 闸门要读逐项判定数真实 fail 数，这里不清，下次审查由 Agent 直接覆盖。

    // 合并/审查成功后自动清理该 MR 的临时 checkout：先脱离 `codeup-mr-<id>` 分支，
    // 再删除该分支，让共享文件夹不再残留该 MR 的工作区。保留 .git 克隆与 pulled 标记，
    // 避免下次对同一仓库重克隆。全程 best-effort，失败不影响主流程（如分支已被删除）。
    let cleanup_root = root.clone();
    let temp_branch = format!("codeup-mr-{mr_id}");
    let _ = tokio::task::spawn_blocking(move || {
        let _ = crate::git::run_git(&cleanup_root, &["checkout", "-f", "--detach", "HEAD"]);
        let _ = crate::git::run_git(&cleanup_root, &["branch", "-D", temp_branch.as_str()]);
    })
    .await;
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

    /// 创建 MR 的路径必须是**仓库级**：组织级 POST 会 404（「平台没收到」的真因）。
    #[test]
    fn builds_repository_scoped_change_requests_url() {
        let url = change_requests_url("org1", "3402809");
        assert_eq!(
            url,
            "https://openapi-rdc.aliyuncs.com/oapi/v1/codeup/organizations/org1/repositories/3402809/changeRequests"
        );
        assert!(url.contains("/repositories/3402809/"));
    }

    fn members() -> Vec<CodeupMember> {
        vec![
            CodeupMember {
                name: "苏一".to_string(),
                user_id: "641a5524b8f7e038cbee4317".to_string(),
            },
            CodeupMember {
                name: "付茂玲".to_string(),
                user_id: "642bbc4b3cecdaec3aff0c12".to_string(),
            },
        ]
    }

    /// 人名要换成 userID —— 直接把人名发给云效会 400/500。
    #[test]
    fn resolves_reviewer_names_to_user_ids() {
        let ids = resolve_reviewer_ids(&["苏一".into(), "付茂玲".into()], &members()).unwrap();
        assert_eq!(
            ids,
            vec![
                "641a5524b8f7e038cbee4317".to_string(),
                "642bbc4b3cecdaec3aff0c12".to_string()
            ]
        );
    }

    /// 已经是 userID 形态的入参直接放行，避免成员表拉取失败时卡住发起。
    #[test]
    fn passes_through_raw_user_ids_and_dedupes() {
        let ids = resolve_reviewer_ids(
            &["641a5524b8f7e038cbee4317".into(), "苏一".into()],
            &members(),
        )
        .unwrap();
        assert_eq!(ids, vec!["641a5524b8f7e038cbee4317".to_string()]);
    }

    /// 查无此人必须报错：静默丢弃会发出一条没有评审人的 MR。
    #[test]
    fn rejects_unknown_reviewer_instead_of_silently_dropping() {
        let err = resolve_reviewer_ids(&["张三".into()], &members()).unwrap_err();
        assert!(err.contains("找不到审核人"), "{err}");
        assert!(err.contains("张三"), "{err}");
    }

    /// 重名无法安全解析，要求用户改填用户 ID。
    #[test]
    fn rejects_ambiguous_reviewer_names() {
        let dup = vec![
            CodeupMember {
                name: "张三".to_string(),
                user_id: "aaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            },
            CodeupMember {
                name: "张三".to_string(),
                user_id: "bbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
            },
        ];
        let err = resolve_reviewer_ids(&["张三".into()], &dup).unwrap_err();
        assert!(err.contains("重名"), "{err}");
    }

    /// 没选审核人时不应触发任何解析（这是最常见的路径）。
    #[test]
    fn empty_reviewer_list_needs_no_members() {
        assert!(resolve_reviewer_ids(&[], &[]).unwrap().is_empty());
        assert!(resolve_reviewer_ids(&["  ".into()], &[]).unwrap().is_empty());
    }

    /// 创建响应只有 `localId`（官方 ChangeRequest 模型没有 id/mrBizId）——它是后续
    /// 路径操作的唯一可用标识，必须优先取到。
    #[test]
    fn parses_created_mr_from_local_id() {
        let created = parse_created_change_request(&serde_json::json!({
            "localId": 3541,
            "title": "t",
            "projectId": 3402790,
            "mrBizId": "cef5669cc62e4a5990ebebdf1d1b2932",
        }))
        .unwrap();
        assert_eq!(created.local_id, 3541);
        assert_eq!(
            created.biz_id.as_deref(),
            Some("cef5669cc62e4a5990ebebdf1d1b2932")
        );
    }

    /// 数字与字符串两种给出方式都要认（云效同一字段在不同接口形态不一）。
    #[test]
    fn parses_created_mr_local_id_from_string_and_result_wrapper() {
        let as_string =
            parse_created_change_request(&serde_json::json!({ "localId": "42" })).unwrap();
        assert_eq!(as_string.local_id, 42);
        let wrapped = parse_created_change_request(&serde_json::json!({
            "result": { "localId": 7 }
        }))
        .unwrap();
        assert_eq!(wrapped.local_id, 7);
    }

    /// 没有 localId 时必须报错，**不能**退回取 `id`：官方模型没有该字段，一旦服务端
    /// 补上（含义未知），存进批次记录会让「已合并门禁」拿着错编号去查。
    #[test]
    fn refuses_to_guess_mr_id_when_local_id_missing() {
        for payload in [
            serde_json::json!({ "id": "abc" }),
            serde_json::json!({ "mrBizId": "abc" }),
            serde_json::json!({ "result": { "id": 1 } }),
        ] {
            let err = parse_created_change_request(&payload).unwrap_err();
            assert!(err.contains("localId"), "unexpected: {err}");
        }
    }

    // ── 无改动预检（真实 git）──────────────────────────────────────────────────

    /// 测试夹具的绝对基路径：不能用 `std::env::temp_dir()`（Git Bash 下会拿到 `/tmp`
    /// 这类非 Windows 绝对路径），固定落在已 gitignore 的 `target/` 下。
    fn temp_base() -> std::path::PathBuf {
        let base = std::env::current_dir()
            .expect("current dir")
            .join("target")
            .join("codeup-tests");
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    struct TempRepo {
        path: std::path::PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            let path = temp_base().join(format!("nezha-codeup-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            let repo = Self { path };
            repo.git(&["init"]);
            for (k, v) in [("user.email", "me@test.test"), ("user.name", "me")] {
                repo.git(&["config", k, v]);
            }
            // 把默认分支固定成 master：`git init` 的默认名随 git 版本/配置而变
            // （master 或 main），不固定的话 `git branch master` 会因重名而失败。
            repo.git(&["branch", "-M", "master"]);
            repo
        }

        fn dir(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }

        fn git(&self, args: &[&str]) {
            let o = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.path)
                .args(args)
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        }

        /// 提交一个文件（内容带 n 以产生不同 patch）。
        fn commit_file(&self, name: &str, n: u32, msg: &str) {
            std::fs::write(self.path.join(name), format!("{name}-{n}")).unwrap();
            self.git(&["add", "."]);
            self.git(&["commit", "-m", msg]);
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// 源分支相对目标分支有改动 → 计数 > 0（放行）。
    #[tokio::test]
    async fn ahead_count_is_positive_when_branch_has_changes() {
        let repo = TempRepo::new();
        repo.commit_file("a.txt", 1, "base");
        repo.git(&["checkout", "-b", "feature"]);
        repo.commit_file("a.txt", 2, "work");
        assert_eq!(
            source_branch_ahead_count(&repo.dir(), "feature", "master", false).await,
            Some(1)
        );
    }

    /// 源分支与目标分支指向同一提交（用户报的那个场景）→ 计数 0（拦下）。
    #[test]
    fn ahead_count_is_zero_when_branch_equals_target() {
        // 用 block_on 跑 async 判定；这里只为断言数值，故手动驱动。
        let repo = TempRepo::new();
        repo.commit_file("a.txt", 1, "base");
        // 新建分支但**不提交**，与 master 同提交。
        repo.git(&["checkout", "-b", "feature-empty"]);
        let dir = repo.dir();
        let count = tauri::async_runtime::block_on(source_branch_ahead_count(
            &dir,
            "feature-empty",
            "master",
            false,
        ));
        assert_eq!(count, Some(0), "空分支必须被判为无改动");
    }

    /// 目标分支的本地 ref 不存在时判不了（`None`）——必须**放行**而不是误拦：
    /// 本地信息不全时拦掉合法 MR 的代价更高。
    #[test]
    fn ahead_count_is_unknown_when_target_ref_missing() {
        let repo = TempRepo::new();
        repo.commit_file("a.txt", 1, "base");
        let dir = repo.dir();
        // 只有当前分支，没有 origin/master 也没有 master。
        let count = tauri::async_runtime::block_on(source_branch_ahead_count(
            &dir,
            "master",
            "no-such-target",
            false,
        ));
        assert_eq!(count, None);
    }

    /// 保护规则的默认评审人：**顶层数组**（实测响应形态），目标分支规则命中后取
    /// `mergeRequestSetting.defaultAssignees` + 兜底 `allowMergeUsers`，默认评审人排前面。
    #[test]
    fn extracts_default_reviewers_from_top_level_array() {
        let json = serde_json::json!([
            { "branch": "develop-old", "allowMergeUsers": [], "mergeRequestSetting": { "defaultAssignees": [] } },
            {
                "branch": "develop",
                "allowMergeUsers": [],
                "mergeRequestSetting": {
                    "defaultAssignees": [{ "name": "苏一" }, { "name": "付茂玲" }]
                }
            },
            {
                "branch": "master",
                "allowMergeUsers": [{ "name": "陈学清" }, { "name": "苏一" }],
                "mergeRequestSetting": { "defaultAssignees": [] }
            }
        ]);
        assert_eq!(
            branch_reviewers_from_rules(&json, "develop"),
            vec!["苏一".to_string(), "付茂玲".to_string()]
        );
        // 没有配置默认评审人时，回落到「允许合并的人」。
        assert_eq!(
            branch_reviewers_from_rules(&json, "master"),
            vec!["陈学清".to_string(), "苏一".to_string()]
        );
        // 只取命中目标分支的那条规则，不把其他分支的评审人混进来。
        assert!(branch_reviewers_from_rules(&json, "release").is_empty());
    }

    /// 兼容 `{rules: [...]}` 包裹形态（接口版本差异），并容忍非对象元素。
    #[test]
    fn extracts_reviewers_from_wrapped_and_junk_shapes() {
        let wrapped = serde_json::json!({
            "rules": [
                { "branch": "master", "mergeRequestSetting": { "defaultAssignees": [{ "name": "苏一" }] } }
            ]
        });
        assert_eq!(
            branch_reviewers_from_rules(&wrapped, "master"),
            vec!["苏一".to_string()]
        );
        // 空 branch 视为通配规则。
        let wildcard = serde_json::json!([
            { "branch": "", "mergeRequestSetting": { "defaultAssignees": [{ "name": "苏一" }] } }
        ]);
        assert_eq!(
            branch_reviewers_from_rules(&wildcard, "master"),
            vec!["苏一".to_string()]
        );
        // 顶层数组里的非对象元素不能让解析崩或误配。
        let junk = serde_json::json!(["oops", 42, null]);
        assert!(branch_reviewers_from_rules(&junk, "master").is_empty());
    }

    /// 构造 `CodeupRepository` 的测试夹具。
    fn codeup_repo(id: &str, namespace: &str, http_url: &str) -> CodeupRepository {
        CodeupRepository {
            id: id.to_string(),
            name: String::new(),
            path: String::new(),
            namespace: namespace.to_string(),
            http_url: http_url.to_string(),
            web_url: String::new(),
        }
    }

    /// 实测坑：平台命名空间会吃掉分隔符（仓库 `HSP/Hsp_Main` 在平台上是
    /// `HSP/HspMain`），而 origin URL 保留下划线。只比字符串相等会永远匹配不上，
    /// 表现为「创建 MR 时找不到仓库」。
    #[test]
    fn matches_repo_despite_namespace_separator_rewrite() {
        let repos = vec![codeup_repo(
            "3402809",
            "641881e9b9581d62e8f8186e / HSP / HspMain",
            "https://codeup.aliyun.com/641881e9b9581d62e8f8186e/HSP/Hsp_Main.git",
        )];
        let found = find_codeup_repository("HSP/Hsp_Main", &repos).expect("must match");
        assert_eq!(found.id, "3402809");
    }

    /// 同名仓库不能串台：`HSP/HIS` 与 `HSP_XC/HIS` 都叫 HIS，必须按命名空间区分。
    #[test]
    fn keeps_same_named_repos_apart() {
        let repos = vec![
            codeup_repo(
                "1",
                "org / HSP / HIS",
                "https://codeup.aliyun.com/org/HSP/HIS.git",
            ),
            codeup_repo(
                "2",
                "org / HSP_XC / HIS",
                "https://codeup.aliyun.com/org/HSP_XC/HIS.git",
            ),
        ];
        assert_eq!(find_codeup_repository("HSP/HIS", &repos).unwrap().id, "1");
        assert_eq!(
            find_codeup_repository("HSP_XC/HIS", &repos).unwrap().id,
            "2"
        );
    }
}
