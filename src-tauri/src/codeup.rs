//! Codeup (阿里云云效代码托管) 合并请求（MR）集成。
//!
//! 与 `yunxiao.rs` 共用同一接入点与鉴权头（`x-yunxiao-token`），token 复用应用级设置里的云效个人访问令牌。本模块只负责 Codeup 仓库侧的 MR 生命周期与分支保护管理员的读取。
//!
//! > ⚠️ 端点路径为最佳推断，集中定义在下方常量/函数中。由于 Codeup OpenAPI 需在已登录的环境才能实测，路径/字段若与实际情况有出入，改动应集中在 `CODUP_PREFIX` / `*_path()` / 解析函数里，避免散落。

use serde::Serialize;
use std::path::Path;
use crate::git::{path_to_string, resolve_repo_path, run_git};
use crate::storage::{Batch, load_project_batches, load_projects, save_project_batches};
use crate::yunxiao::{API_BASE, build_client, read_json_body};

/// Codeup API 前缀（相对接入点）。若实际为其它路径，仅需改这里。
const CODUP_PREFIX: &str = "oapi/v1/codeup";

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
}

/// 返回给前端的 Codeup 仓库（用于仓库过滤下拉）。
#[derive(Serialize, Clone, Debug)]
pub struct CodeupRepository {
    pub id: String,
    pub name: String,
    pub path: String,
    pub namespace: String,
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
async fn resolve_codeup_repo(project_path: &str, repo_path: Option<&str>) -> Result<CodeupRepo, String> {
    let cwd = resolve_repo_path(project_path, repo_path).await?;
    let output = run_git(&cwd, &["remote", "get-url", "origin"]).map_err(|e| {
        format!("读取 git 远端失败（请确认项目可访问远端）: {e}")
    })?;
    if !output.status.success() {
        return Err("未找到 git origin 远端，无法定位 Codeup 仓库".to_string());
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let (org, repository) = parse_codeup_remote(&url)?;
    Ok(CodeupRepo { org_id: org, repository })
}

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
    let bytes = crate::yunxiao::get_yunxiao_json(
        &client,
        &token,
        branch_rules_url(org, &repo.repository),
    )
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
        .or_else(|| json.get("id").and_then(|v| v.as_i64()).map(|i| i.to_string()))
        .ok_or_else(|| "创建合并请求后未取到 MR id".to_string())?;

    let mut batches = load_project_batches(project_id.clone())?;
    let updated = batches
        .iter_mut()
        .find(|b| b.id == batch_id)
        .ok_or_else(|| "Batch not found".to_string())?;
    updated.mr_id = Some(mr_id);
    updated.mr_status = Some("opened".to_string());
    updated.status = "review".to_string();
    let result = updated.clone();
    save_project_batches(project_id, batches)?;
    Ok(result)
}

/// changeRequests 分页上限（每页 20），只取最近若干页；已开启 MR 按更新时间靠前。
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
#[tauri::command]
pub async fn codeup_list_repositories() -> Result<Vec<CodeupRepository>, String> {
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
                .and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|i| i.to_string())))
                .unwrap_or_default(),
            name: item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            path: repo_path,
            namespace,
            web_url: item
                .get("webUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(out)
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
        crate::app_settings::load_app_settings().await?.yunxiao.organization_id.trim()
    );
    let mut out: Vec<CodeupMr> = Vec::new();
    for page in 1..=MAX_CHANGE_PAGES {
        let url = format!("{url_base}?page={page}");
        let bytes = match crate::yunxiao::get_yunxiao_json(&client, &token, url).await {
            Ok(b) => b,
            Err(_) => break,
        };
        let json: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
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
        for item in arr {
            let state = item
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if state != "UNDER_REVIEW" {
                continue;
            }
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
            let local_id = item
                .get("localId")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
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
            out.push(CodeupMr {
                project_id: project_id.clone(),
                project_path: String::new(),
                repository: namespace_to_repo_path(&ns),
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
            });
        }
        if arr.len() < 20 {
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
pub async fn codeup_get_mr(
    repository_id: String,
    mr_id: String,
) -> Result<CodeupMr, String> {
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
    })
}

/// 管理人「通过」（approve）一条 MR。动作子路径为最佳推断，需联调。
#[tauri::command]
pub async fn codeup_approve_mr(
    repository_id: String,
    mr_id: String,
) -> Result<String, String> {
    let (token, org_id) = load_creds().await?;
    let client = build_client()?;
    let url = format!("{}/submitReview", change_item_url(&org_id, &repository_id, &mr_id));
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

/// 为某个 MR 拉取其源分支并创建本地临时 worktree，供 Agent 代码审核/冲突解决使用。
/// 若已存在同名 worktree 则直接复用。
#[tauri::command]
pub async fn codeup_ensure_worktree(
    project_path: String,
    repo_path: Option<String>,
    source_branch: String,
    mr_id: String,
) -> Result<String, String> {
    let cwd = resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    tokio::task::spawn_blocking(move || {
        let worktrees_dir = Path::new(&cwd).join(".nezha").join("worktrees");
        std::fs::create_dir_all(&worktrees_dir)
            .map_err(|e| format!("创建 worktrees 目录失败: {e}"))?;
        let wt = worktrees_dir.join(format!("codeup-mr-{mr_id}"));
        let wt_str = path_to_string(&wt)?;
        if wt.exists() {
            return Ok(wt_str);
        }
        // 先拉取源分支，再基于远端 ref 建本地分支 + worktree。
        let fetch = run_git(&cwd, &["fetch", "origin", &source_branch])?;
        if !fetch.status.success() {
            return Err(format!(
                "拉取源分支失败: {}",
                String::from_utf8_lossy(&fetch.stderr).trim()
            ));
        }
        let local = format!("codeup-mr-{mr_id}");
        let branch_ref = format!("origin/{source_branch}");
        let add = run_git(&cwd, &["worktree", "add", &wt_str, "-b", &local, &branch_ref])?;
        if !add.status.success() {
            return Err(format!(
                "创建 worktree 失败: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            ));
        }
        Ok(wt_str)
    })
    .await
    .map_err(|e| format!("ensure worktree task panicked: {e}"))?
}

/// 对某个跨仓库 MR 执行 Agent 代码审查：先在已注册项目里按仓库路径找到本地仓库，
/// 再建临时 worktree，最后跑 `run_merge_code_review`（软提示，仅返回 findings）。
#[tauri::command]
pub async fn codeup_review_mr(
    repository: String,
    source_branch: String,
    target_branch: String,
    mr_id: String,
    agent: Option<String>,
) -> Result<Vec<crate::agent_assist::ReviewFinding>, String> {
    let agent = agent.unwrap_or_else(|| "claude".to_string());
    let projects = load_projects()?;
    let mut matched: Option<String> = None;
    for project in &projects {
        if project.path.trim().is_empty() {
            continue;
        }
        let repo = match resolve_codeup_repo(&project.path, None).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        if repo.repository == repository {
            matched = Some(project.path.clone());
            break;
        }
    }
    let project_path = matched.ok_or_else(|| {
        format!("本地未注册仓库 {repository}，无法执行 Agent 代码审查。请先将其注册为 Nezha 项目。")
    })?;
    let worktree_path =
        codeup_ensure_worktree(project_path.clone(), None, source_branch.clone(), mr_id.clone())
            .await?;
    crate::agent_assist::run_merge_code_review(
        project_path,
        None,
        worktree_path,
        target_branch,
        source_branch,
        agent,
    )
    .await
}

/// 供测试/调试：输出项目的 Codeup 定位信息（不含远端 URL 细节）。
#[tauri::command]
pub async fn codeup_resolve_repo(project_path: String, repo_path: Option<String>) -> Result<String, String> {
    let repo = resolve_codeup_repo(&project_path, repo_path.as_deref()).await?;
    Ok(format!("{}|{}", repo.org_id, repo.repository))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_codeup_remote() {
        let (org, repo) = parse_codeup_remote("https://codeup.aliyun.com/641881e9b9581d62e8f8186e/HSP/HIS.git").unwrap();
        assert_eq!(org, "641881e9b9581d62e8f8186e");
        assert_eq!(repo, "HSP/HIS");
    }

    #[test]
    fn parses_git_ssh_codeup_remote() {
        let (org, repo) = parse_codeup_remote("git@codeup.aliyun.com:641881e9b9581d62e8f8186e/HSP/HIS.git").unwrap();
        assert_eq!(org, "641881e9b9581d62e8f8186e");
        assert_eq!(repo, "HSP/HIS");
    }
}
