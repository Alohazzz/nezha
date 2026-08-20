//! 云效 (Alibaba Cloud DevOps / Projex) OpenAPI 集成。
//! 官方文档要点（help.aliyun.com/zh/yunxiao/developer-reference/）：
//! - 中心版服务接入点：`openapi-rdc.aliyuncs.com`
//! - 鉴权头：`x-yunxiao-token: <个人访问令牌>`
//! - organizationId 仅中心版需要（组织管理后台 → 基本信息）
//! - 工作项查询：`POST /oapi/v1/projex/organizations/{orgId}/workitems:search`
//!
//! v1 只做只读查询（组织 / 项目 / 工作项），不做写回云效。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

const API_BASE: &str = "https://openapi-rdc.aliyuncs.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ISSUE_IMAGES: usize = 20;
const MAX_COMMENT_CHARS: usize = 20_000;
const MAX_REPORTED_ERRORS: usize = 5;

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// 图片下载客户端：允许有限重定向（OSS 签名 URL 常见），最终域名仍走白名单校验。
fn build_download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

fn body_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// 校验响应域名与 HTTP 状态，返回响应体字节。
async fn read_json_body(resp: reqwest::Response) -> Result<Vec<u8>, String> {
    let final_url = resp.url().as_str();
    if !final_url.starts_with(API_BASE) {
        return Err(format!("Unexpected response URL: {final_url}"));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.bytes().await.unwrap_or_default();
        let message = if body.is_empty() {
            format!("HTTP {status}")
        } else {
            match serde_json::from_slice::<serde_json::Value>(&body) {
                Ok(json) => json
                    .get("errorMessage")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&body_string(&body))
                    .to_string(),
                Err(_) => body_string(&body),
            }
        };
        return Err(message);
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Read body failed: {e}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Response exceeds size limit".to_string());
    }
    Ok(bytes.to_vec())
}

// ── 响应模型 ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct YunxiaoOrganization {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct YunxiaoProject {
    pub id: String,
    pub name: String,
    #[serde(rename = "customCode", default, skip_serializing_if = "Option::is_none")]
    pub custom_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct YunxiaoUserRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct YunxiaoStatus {
    #[serde(default)]
    pub name: String,
    #[serde(rename = "displayName", default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(rename = "nameEn", default, skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    #[serde(default)]
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct YunxiaoCustomFieldEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(rename = "displayValue", default, skip_serializing_if = "Option::is_none")]
    pub display_value: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct YunxiaoCustomFieldValue {
    #[serde(rename = "fieldId", default)]
    pub field_id: String,
    #[serde(rename = "fieldName", default)]
    pub field_name: String,
    #[serde(default)]
    pub values: Vec<YunxiaoCustomFieldEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct YunxiaoWorkitem {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "serialNumber", default)]
    pub serial_number: String,
    #[serde(default)]
    pub subject: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_description",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<YunxiaoStatus>,
    #[serde(rename = "assignedTo", default, skip_serializing_if = "Option::is_none")]
    pub assigned_to: Option<YunxiaoUserRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<YunxiaoUserRef>,
    #[serde(rename = "gmtCreate", default, skip_serializing_if = "Option::is_none")]
    pub gmt_create: Option<i64>,
    #[serde(rename = "customFieldValues", default)]
    pub custom_field_values: Vec<YunxiaoCustomFieldValue>,
    /// 描述正文中的图片数量（详情接口由 parse_workitem_response 从原始描述计算，列表接口为 0）。
    #[serde(default)]
    pub image_count: usize,
    #[serde(rename = "categoryId", default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(rename = "logicalStatus", default, skip_serializing_if = "Option::is_none")]
    pub logical_status: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct YunxiaoWorkitemType {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "categoryId", default)]
    pub category_id: String,
}

/// 分页结果：items 来自响应体数组，total 来自响应头 x-total（缺失时回落到本页数量）。
#[derive(Serialize, Clone, Debug)]
pub struct YunxiaoPage<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub page: u32,
    pub per_page: u32,
}

fn parse_total_header(resp: &reqwest::Response) -> Option<usize> {
    resp.headers()
        .get("x-total")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse().ok())
}

/// GET 请求 + 鉴权头 + 响应校验（新命令复用；域名白名单由 read_json_body 兜底）。
async fn get_yunxiao_json(
    client: &reqwest::Client,
    token: &str,
    url: String,
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .header("x-yunxiao-token", token)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求云效数据失败: {e}"))?;
    read_json_body(resp).await
}

/// 解析当前用户响应；兼容 id/userId、name/userName 两种字段形态。
fn parse_current_user(bytes: &[u8]) -> Result<YunxiaoUserRef, String> {
    #[derive(Deserialize, Default)]
    struct CurrentUserPayload {
        #[serde(default)]
        id: String,
        #[serde(default)]
        name: String,
        #[serde(rename = "userId", default)]
        user_id: String,
        #[serde(rename = "userName", default)]
        user_name: String,
    }
    let payload: CurrentUserPayload = serde_json::from_slice(bytes)
        .map_err(|e| format!("解析云效当前用户失败: {e}"))?;
    Ok(YunxiaoUserRef {
        id: if payload.id.is_empty() {
            payload.user_id
        } else {
            payload.id
        },
        name: if payload.name.is_empty() {
            payload.user_name
        } else {
            payload.name
        },
    })
}

/// 解析工作流响应中的状态列表。
fn parse_workflow_statuses(bytes: &[u8]) -> Result<Vec<YunxiaoStatus>, String> {
    #[derive(Deserialize, Default)]
    struct WorkflowPayload {
        #[serde(default)]
        statuses: Vec<YunxiaoStatus>,
    }
    serde_json::from_slice::<WorkflowPayload>(bytes)
        .map(|p| p.statuses)
        .map_err(|e| format!("解析云效工作流状态失败: {e}"))
}

/// 合并多个工作项类型的状态列表，按状态 ID 去重（保留首次出现顺序）；空 ID 不参与去重。
fn merge_status_lists(lists: Vec<Vec<YunxiaoStatus>>) -> Vec<YunxiaoStatus> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for list in lists {
        for status in list {
            if status.id.is_empty() || seen.insert(status.id.clone()) {
                merged.push(status);
            }
        }
    }
    merged
}

/// 云效描述可能是富文本 JSON（TipTap/Notion 风格）或 HTML：
/// 递归提取字符串叶子（优先 text/content/value 字段），块级数组按行拼接，
/// 普通字符串剥离 HTML 标签；非文本值返回 None。
fn normalize_issue_description(value: serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => {
            let stripped = strip_html_tags(&s);
            if stripped.is_empty() {
                None
            } else {
                Some(stripped)
            }
        }
        serde_json::Value::Array(items) => {
            let lines: Vec<String> = items
                .iter()
                .filter_map(|v| normalize_issue_description(v.clone()))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if lines.is_empty() {
                None
            } else {
                Some(lines.join("\n"))
            }
        }
        serde_json::Value::Object(map) => {
            for key in ["text", "content", "value"] {
                if let Some(v) = map.get(key) {
                    if let Some(text) = normalize_issue_description(v.clone()) {
                        return Some(text);
                    }
                }
            }
            let parts: Vec<String> = map
                .iter()
                .filter_map(|(_, v)| normalize_issue_description(v.clone()))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" "))
            }
        }
        _ => None,
    }
}

/// 剥离 HTML 标签（不处理属性内 `>` 的极端情况，够用于描述展示）。
fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// description 字段反序列化：兼容字符串 / 富文本 JSON 对象 / 数组 / null。
fn deserialize_optional_description<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(normalize_issue_description))
}

/// 解析 GetWorkitem 响应：兼容直接对象与 `{"result": {...}}` 包裹形态；
/// 顺带从原始描述计算图片数量（供详情页提示「议题含 N 张图片」）。
fn parse_workitem_response(bytes: &[u8]) -> Result<YunxiaoWorkitem, String> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("解析云效工作项详情失败: {e}"))?;
    if value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::is_empty)
        .unwrap_or(true)
    {
        if let Some(result) = value.get_mut("result") {
            value = result.take();
        }
    }
    let mut item: YunxiaoWorkitem = serde_json::from_value(value.clone())
        .map_err(|e| format!("解析云效工作项详情失败: {e}"))?;
    if item.id.is_empty() {
        return Err("解析云效工作项详情失败：响应中没有工作项数据".to_string());
    }
    let mut urls = Vec::new();
    if let Some(description) = value.get("description") {
        extract_image_urls_from_value(description, &mut urls);
    }
    item.image_count = urls.len();
    Ok(item)
}

// ── Tauri 命令 ───────────────────────────────────────────────────────────────

/// 获取当前令牌所属用户（「我负责的」过滤的身份来源）。
#[tauri::command]
pub async fn yunxiao_get_current_user(token: String) -> Result<YunxiaoUserRef, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("云效个人访问令牌不能为空".to_string());
    }
    let client = build_client()?;
    let bytes = get_yunxiao_json(&client, token, format!("{API_BASE}/oapi/v1/platform/user")).await?;
    parse_current_user(&bytes)
}

/// 查询个人访问令牌所属的组织列表（中心版）。
#[tauri::command]
pub async fn yunxiao_list_organizations(token: String) -> Result<Vec<YunxiaoOrganization>, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("云效个人访问令牌不能为空".to_string());
    }
    let client = build_client()?;
    let resp = client
        .get(format!("{API_BASE}/oapi/v1/platform/organizations"))
        .header("x-yunxiao-token", token)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求云效组织列表失败: {e}"))?;
    let bytes = read_json_body(resp).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("解析云效组织列表失败: {e}"))
}

/// 搜索组织下的项目（分页）。
#[tauri::command]
pub async fn yunxiao_search_projects(
    token: String,
    organization_id: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<YunxiaoPage<YunxiaoProject>, String> {
    let token = token.trim();
    let organization_id = organization_id.trim();
    if token.is_empty() || organization_id.is_empty() {
        return Err("缺少云效令牌或组织 ID".to_string());
    }
    let page = page.unwrap_or(1).max(1);
    let per_page = per_page.unwrap_or(100).clamp(1, 200);
    let body = serde_json::json!({
        "conditions": "{\"conditionGroups\":[[]]}",
        "orderBy": "gmtCreate",
        "sort": "desc",
        "page": page,
        "perPage": per_page,
    });
    let client = build_client()?;
    let resp = client
        .post(format!(
            "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/projects:search"
        ))
        .header("x-yunxiao-token", token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求云效项目列表失败: {e}"))?;
    let total = parse_total_header(&resp);
    let bytes = read_json_body(resp).await?;
    let items: Vec<YunxiaoProject> =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析云效项目列表失败: {e}"))?;
    Ok(YunxiaoPage {
        total: total.unwrap_or(items.len()),
        items,
        page,
        per_page,
    })
}

/// 搜索项目下的工作项（议题），category 为空时默认查需求+任务+缺陷。
#[tauri::command]
pub async fn yunxiao_search_workitems(
    token: String,
    organization_id: String,
    project_id: String,
    category: Option<String>,
    conditions: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<YunxiaoPage<YunxiaoWorkitem>, String> {
    let token = token.trim();
    let organization_id = organization_id.trim();
    let project_id = project_id.trim();
    if token.is_empty() || organization_id.is_empty() || project_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或项目 ID".to_string());
    }
    let category = category
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "Req,Task,Bug".to_string());
    let conditions = conditions
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "{\"conditionGroups\":[[]]}".to_string());
    let page = page.unwrap_or(1).max(1);
    let per_page = per_page.unwrap_or(100).clamp(1, 200);
    let body = serde_json::json!({
        "category": category,
        "conditions": conditions,
        "orderBy": "gmtCreate",
        "sort": "desc",
        "page": page,
        "perPage": per_page,
        "spaceId": project_id,
        "spaceType": "Project",
    });
    let client = build_client()?;
    let resp = client
        .post(format!(
            "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems:search"
        ))
        .header("x-yunxiao-token", token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求云效议题列表失败: {e}"))?;
    let total = parse_total_header(&resp);
    let bytes = read_json_body(resp).await?;
    let items: Vec<YunxiaoWorkitem> =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析云效议题列表失败: {e}"))?;
    Ok(YunxiaoPage {
        total: total.unwrap_or(items.len()),
        items,
        page,
        per_page,
    })
}

/// 获取项目下指定分类（Req/Task/Bug）的全部工作项状态：
/// 每个分类查工作项类型，再按类型查工作流，最后按状态 ID 合并去重。
#[tauri::command]
pub async fn yunxiao_list_workitem_statuses(
    token: String,
    organization_id: String,
    project_id: String,
    categories: Vec<String>,
) -> Result<Vec<YunxiaoStatus>, String> {
    let token = token.trim();
    let organization_id = organization_id.trim();
    let project_id = project_id.trim();
    if token.is_empty() || organization_id.is_empty() || project_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或项目 ID".to_string());
    }
    let client = build_client()?;
    let mut lists: Vec<Vec<YunxiaoStatus>> = Vec::new();
    for category in categories.iter().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        let types_url = format!(
            "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}/workitemTypes?category={category}"
        );
        let types: Vec<YunxiaoWorkitemType> = {
            let bytes = get_yunxiao_json(&client, token, types_url).await?;
            serde_json::from_slice(&bytes).map_err(|e| format!("解析云效工作项类型失败: {e}"))?
        };
        for workitem_type in &types {
            if workitem_type.id.is_empty() {
                continue;
            }
            let workflows_url = format!(
                "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}/workitemTypes/{}/workflows",
                workitem_type.id
            );
            let bytes = get_yunxiao_json(&client, token, workflows_url).await?;
            lists.push(parse_workflow_statuses(&bytes)?);
        }
    }
    Ok(merge_status_lists(lists))
}

/// 按工作项 ID 获取议题详情（GetWorkitem）。
/// REST 路径与返回结构以官方文档 + 真实 token 复验为准（仓库惯例）。
#[tauri::command]
pub async fn yunxiao_get_workitem(
    token: String,
    organization_id: String,
    workitem_id: String,
) -> Result<YunxiaoWorkitem, String> {
    let token = token.trim();
    let organization_id = organization_id.trim();
    let workitem_id = workitem_id.trim();
    if token.is_empty() || organization_id.is_empty() || workitem_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或工作项 ID".to_string());
    }
    let client = build_client()?;
    let url = format!(
        "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems/{workitem_id}"
    );
    let bytes = get_yunxiao_json(&client, token, url).await?;
    parse_workitem_response(&bytes)
}

// ── 议题图片提取 / 下载（识图）────────────────────────────────────────────────

/// 图片提取结果：下载成功的本地路径 + 统计（供前端提示部分失败/全部失败）。
#[derive(Serialize, Clone, Debug, Default)]
pub struct IssueImagesPrepared {
    pub paths: Vec<String>,
    pub total: usize,
    pub downloaded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

fn push_image_url(urls: &mut Vec<String>, url: &str) {
    let url = url.trim();
    if url.is_empty() || urls.iter().any(|u| u == url) {
        return;
    }
    urls.push(url.to_string());
}

/// 从原始描述（富文本 JSON / HTML / Markdown）递归提取图片 URL，保留出现顺序并去重。
fn extract_image_urls_from_value(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => {
            for url in extract_image_urls_from_text(s) {
                push_image_url(out, &url);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                extract_image_urls_from_value(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            // 富文本图片节点：{"type":"image","src"/"url"/"attrs":{"src":...}}
            let is_image_node =
                map.get("type").and_then(serde_json::Value::as_str) == Some("image");
            if is_image_node {
                for key in ["src", "url", "filePath"] {
                    if let Some(serde_json::Value::String(u)) = map.get(key) {
                        push_image_url(out, u);
                    }
                }
                if let Some(attrs) = map.get("attrs") {
                    for key in ["src", "url"] {
                        if let Some(serde_json::Value::String(u)) = attrs.get(key) {
                            push_image_url(out, u);
                        }
                    }
                }
            }
            for (_, v) in map {
                extract_image_urls_from_value(v, out);
            }
        }
        _ => {}
    }
}

/// 从纯文本中提取图片 URL（HTML `<img src>` + Markdown `![alt](url)`）。
fn extract_image_urls_from_text(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for url in extract_html_img_urls(text) {
        push_image_url(&mut urls, &url);
    }
    for url in extract_markdown_image_urls(text) {
        push_image_url(&mut urls, &url);
    }
    urls
}

/// 解析 `<img ... src="...">`（大小写不敏感，兼容单双引号）。to_ascii_lowercase 不改变字节长度，
/// 因此 lower 与原文的字节偏移一一对应。
fn extract_html_img_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let lower = text.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("<img") {
        let start = search_from + rel;
        let tag_end = text[start..]
            .find('>')
            .map(|i| start + i)
            .unwrap_or(text.len());
        let tag = &text[start..tag_end];
        let tag_lower = &lower[start..tag_end];
        let mut s = 0;
        while let Some(src_rel) = tag_lower[s..].find("src") {
            let src_pos = s + src_rel;
            let rest = tag[src_pos + 3..].trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let rest = rest.trim_start();
                if let Some(q) = rest.chars().next() {
                    if q == '"' || q == '\'' {
                        if let Some(end) = rest[q.len_utf8()..].find(q) {
                            let url = &rest[q.len_utf8()..][..end];
                            push_image_url(&mut urls, url);
                        }
                        break;
                    }
                }
            }
            s = src_pos + 3;
        }
        search_from = tag_end;
    }
    urls
}

/// 解析 Markdown `![alt](https://...)`。
fn extract_markdown_image_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find("![") {
        let start = search_from + rel;
        let after = &text[start + 2..];
        if let Some(close_idx) = after.find(']') {
            let after_close = after[close_idx + 1..].trim_start();
            if let Some(rest) = after_close.strip_prefix('(') {
                if let Some(end) = rest.find(')') {
                    push_image_url(&mut urls, rest[..end].trim());
                }
            }
        }
        search_from = start + 2;
    }
    urls
}

/// 图片域名白名单：仅放行阿里云系域名，防 SSRF。
fn is_allowed_image_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host.ends_with(".aliyuncs.com") || host.ends_with(".alicdn.com") || host.ends_with(".aliyun.com")
}

/// 校验图片 URL：必须 https 且域名在白名单内。
fn normalize_image_url(url: &str) -> Option<reqwest::Url> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !is_allowed_image_host(&host) {
        return None;
    }
    Some(parsed)
}

fn image_extension(content_type: &str) -> Option<&'static str> {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("image/png") {
        Some("png")
    } else if ct.starts_with("image/jpeg") {
        Some("jpg")
    } else if ct.starts_with("image/gif") {
        Some("gif")
    } else if ct.starts_with("image/webp") {
        Some("webp")
    } else if ct.starts_with("image/bmp") {
        Some("bmp")
    } else {
        None
    }
}

fn push_reported_error(errors: &mut Vec<String>, message: String) {
    if errors.len() < MAX_REPORTED_ERRORS {
        errors.push(message);
    }
}

/// 下载单张议题图片：带 token 鉴权 + 域名白名单 + 类型/体积校验。
async fn download_issue_image(
    client: &reqwest::Client,
    token: &str,
    url: &str,
) -> Result<(Vec<u8>, String), String> {
    let parsed =
        normalize_image_url(url).ok_or_else(|| "图片地址非法（非 https 或非阿里云域名）".to_string())?;
    let resp = client
        .get(parsed)
        .header("x-yunxiao-token", token)
        .send()
        .await
        .map_err(|e| format!("下载图片失败: {e}"))?;
    let final_host = resp.url().host_str().unwrap_or("").to_string();
    if !is_allowed_image_host(&final_host) {
        return Err("图片被重定向到非阿里云域名，已拦截".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("图片下载 HTTP {}", resp.status()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ext = image_extension(&content_type)
        .ok_or_else(|| format!("不支持的图片类型: {}", content_type))?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取图片失败: {e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("图片超过 10MB（{} 字节）", bytes.len()));
    }
    Ok((bytes.to_vec(), ext.to_string()))
}

/// 发起讨论前调用：拉取议题全量描述 → 提取图片 URL → 下载到 `.nezha/attachments/<taskId>/`。
/// 返回本地路径与统计；前端据 `failed == total` 决定是否阻断发起。
#[tauri::command]
pub async fn yunxiao_prepare_issue_images(
    token: String,
    organization_id: String,
    workitem_id: String,
    project_path: String,
    task_id: String,
) -> Result<IssueImagesPrepared, String> {
    let token = token.trim().to_string();
    let organization_id = organization_id.trim().to_string();
    let workitem_id = workitem_id.trim().to_string();
    if token.is_empty() || organization_id.is_empty() || workitem_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或工作项 ID".to_string());
    }
    let task_id = task_id.trim();
    if task_id.is_empty()
        || task_id == "."
        || task_id == ".."
        || task_id.contains('/')
        || task_id.contains('\\')
    {
        return Err("非法的任务 ID".to_string());
    }
    let project = Path::new(&project_path)
        .canonicalize()
        .map_err(|e| format!("项目路径无效: {e}"))?;
    if !project.is_dir() {
        return Err("项目路径不是目录".to_string());
    }
    let attachments_dir = project.join(".nezha").join("attachments").join(task_id);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| format!("创建附件目录失败: {e}"))?;

    // 1) 拉全量详情原始 JSON（保留富文本/HTML 结构，避免图片被文本化剥掉）
    let client = build_client()?;
    let url = format!(
        "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems/{workitem_id}"
    );
    let bytes = get_yunxiao_json(&client, &token, url).await?;
    let mut json: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("解析云效工作项详情失败: {e}"))?;
    if json
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::is_empty)
        .unwrap_or(true)
    {
        if let Some(result) = json.get_mut("result") {
            json = result.take();
        }
    }
    let description = json
        .get("description")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let mut urls: Vec<String> = Vec::new();
    extract_image_urls_from_value(&description, &mut urls);
    if urls.is_empty() {
        return Ok(IssueImagesPrepared::default());
    }

    // 2) 逐张下载（带鉴权头），序号命名
    let download_client = build_download_client()?;
    let mut result = IssueImagesPrepared {
        total: urls.len(),
        ..Default::default()
    };
    for (i, url) in urls.into_iter().enumerate() {
        if i >= MAX_ISSUE_IMAGES {
            result.skipped += 1;
            continue;
        }
        match download_issue_image(&download_client, &token, &url).await {
            Ok((data, ext)) => {
                let filename = format!("image-{:02}.{}", result.downloaded + 1, ext);
                let file_path = attachments_dir.join(&filename);
                if let Err(e) = std::fs::write(&file_path, &data) {
                    result.failed += 1;
                    push_reported_error(
                        &mut result.errors,
                        format!("写入 {filename} 失败: {e}"),
                    );
                } else {
                    result.paths.push(file_path.to_string_lossy().into_owned());
                    result.downloaded += 1;
                }
            }
            Err(e) => {
                result.failed += 1;
                push_reported_error(&mut result.errors, e);
            }
        }
    }
    Ok(result)
}

// ── 议题评论回写（闭环）──────────────────────────────────────────────────────

/// 创建工作项评论（CreateWorkitemComment，官方文档已确认）：
/// `POST /oapi/v1/projex/organizations/{orgId}/workitems/{id}/comments`，
/// body `{"content": "..."}`，返回 `{"id": "..."}`。路径/返回结构实现时以真实 token 复验。
#[tauri::command]
pub async fn yunxiao_create_workitem_comment(
    token: String,
    organization_id: String,
    workitem_id: String,
    content: String,
) -> Result<String, String> {
    let token = token.trim();
    let organization_id = organization_id.trim();
    let workitem_id = workitem_id.trim();
    if token.is_empty() || organization_id.is_empty() || workitem_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或工作项 ID".to_string());
    }
    let content = content.trim();
    if content.is_empty() {
        return Err("评论内容不能为空".to_string());
    }
    if content.chars().count() > MAX_COMMENT_CHARS {
        return Err(format!("评论内容超过 {MAX_COMMENT_CHARS} 字上限"));
    }
    let client = build_client()?;
    let resp = client
        .post(format!(
            "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems/{workitem_id}/comments"
        ))
        .header("x-yunxiao-token", token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "content": content }))
        .send()
        .await
        .map_err(|e| format!("请求云效创建评论失败: {e}"))?;
    let bytes = read_json_body(resp).await?;
    #[derive(Deserialize)]
    struct CommentCreated {
        id: String,
    }
    let created: CommentCreated = serde_json::from_slice(&bytes)
        .map_err(|e| format!("解析云效创建评论响应失败: {e}"))?;
    Ok(created.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 来自真实 SearchWorkitems 响应（字段已脱敏保留结构）。
    const WORKITEM_JSON: &str = r#"{
      "creator": {"name": "唐建祖", "id": "644f9087f8c4cdf0a4487992"},
      "modifier": {"name": "唐建祖", "id": "644f9087f8c4cdf0a4487992"},
      "gmtCreate": 1787042498000,
      "gmtModified": 1787042498000,
      "serialNumber": "QHDK-29728",
      "subject": "【芒市医共体】试剂出库查询，过滤框输入字符就报错",
      "description": "在试剂出库查询页面输入过滤字符时直接报错。",
      "formatType": null,
      "assignedTo": {"name": "许宏民", "id": "642b88712ca4e1cd30de4718"},
      "status": {"name": "待处理", "nameEn": "To Do", "displayName": "待处理", "id": "100005"},
      "space": {"name": "Hsp 2.0", "id": "07a763450c8733172523320ab6"},
      "workitemType": {"name": "产品类需求", "id": "9uy29901re573f561d69jn40"},
      "logicalStatus": "NORMAL",
      "customFieldValues": [
        {"fieldName": "来源", "fieldFormat": "list", "values": [{"identifier": "客户反馈", "displayValue": "客户反馈"}], "fieldId": "12870b90729a20c378a99c9463"},
        {"fieldName": "优先级", "fieldFormat": "list", "values": [{"identifier": "5461a5b1d0ae12fcdf98b048bb", "displayValue": "中"}], "fieldId": "priority"}
      ],
      "updateStatusAt": null,
      "trackers": null,
      "participants": null,
      "verifier": null,
      "sprint": null,
      "labels": null,
      "versions": null,
      "id": "741d91e70b392b65ef95604c1f",
      "idPath": "741d91e70b392b65ef95604c1f",
      "statusStageId": "1",
      "categoryId": "Req",
      "parentId": "EMPTY_VALUE"
    }"#;

    #[test]
    fn parses_workitem_with_optional_fields_and_unknown_fields() {
        let item: YunxiaoWorkitem = serde_json::from_str(WORKITEM_JSON).expect("workitem parses");
        assert_eq!(item.id, "741d91e70b392b65ef95604c1f");
        assert_eq!(item.serial_number, "QHDK-29728");
        assert_eq!(item.subject, "【芒市医共体】试剂出库查询，过滤框输入字符就报错");
        assert_eq!(item.status.as_ref().unwrap().name, "待处理");
        assert_eq!(item.assigned_to.as_ref().unwrap().name, "许宏民");
        let priority = item
            .custom_field_values
            .iter()
            .find(|f| f.field_id == "priority")
            .expect("priority field present");
        assert_eq!(priority.values[0].display_value.as_deref(), Some("中"));
    }

    #[test]
    fn parses_project_with_missing_optional_fields() {
        let json = r#"{"creator": {"name": "罗永智", "id": "642bbdf554d884946b579e30"}, "name": "Hsp 2.0", "id": "07a763450c8733172523320ab6"}"#;
        let project: YunxiaoProject = serde_json::from_str(json).expect("project parses");
        assert_eq!(project.id, "07a763450c8733172523320ab6");
        assert_eq!(project.name, "Hsp 2.0");
        assert_eq!(project.custom_code, None);
    }

    fn test_status(id: &str, name: &str) -> YunxiaoStatus {
        YunxiaoStatus {
            id: id.to_string(),
            name: name.to_string(),
            display_name: Some(name.to_string()),
            name_en: None,
        }
    }

    #[test]
    fn parses_current_user_response_with_id_and_name() {
        let json = r#"{"id": "642b88712ca4e1cd30de4718", "name": "许宏民", "avatarUrl": "https://example.com/a.png"}"#;
        let user = parse_current_user(json.as_bytes()).expect("current user parses");
        assert_eq!(user.id, "642b88712ca4e1cd30de4718");
        assert_eq!(user.name, "许宏民");
    }

    #[test]
    fn parses_current_user_response_with_alias_fields() {
        let json = r#"{"userId": "abc123", "userName": "张三", "displayName": "张三"}"#;
        let user = parse_current_user(json.as_bytes()).expect("current user parses with aliases");
        assert_eq!(user.id, "abc123");
        assert_eq!(user.name, "张三");
    }

    #[test]
    fn parses_workflow_response_statuses() {
        let json = r#"{
          "defaultStatusId": "1",
          "statuses": [
            {"id": "100005", "name": "待处理", "nameEn": "To Do", "displayName": "待处理"},
            {"id": "100006", "name": "进行中", "nameEn": "Doing", "displayName": "进行中"}
          ]
        }"#;
        let statuses = parse_workflow_statuses(json.as_bytes()).expect("workflow parses");
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].id, "100005");
        assert_eq!(statuses[0].display_name.as_deref(), Some("待处理"));
    }

    #[test]
    fn merges_status_lists_dedup_by_id() {
        let req_statuses = vec![
            test_status("100005", "待处理"),
            test_status("100006", "进行中"),
        ];
        let bug_statuses = vec![
            test_status("100005", "待处理"),
            test_status("100007", "已完成"),
        ];
        let merged = merge_status_lists(vec![req_statuses, bug_statuses]);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].id, "100005");
        assert_eq!(merged[1].id, "100006");
        assert_eq!(merged[2].id, "100007");
    }

    #[test]
    fn merge_keeps_status_with_empty_id() {
        let a = vec![test_status("", "无 ID 状态")];
        let merged = merge_status_lists(vec![a.clone(), a]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn parses_get_workitem_direct_response() {
        let item = parse_workitem_response(WORKITEM_JSON.as_bytes()).expect("direct response parses");
        assert_eq!(item.id, "741d91e70b392b65ef95604c1f");
        assert_eq!(item.serial_number, "QHDK-29728");
        assert_eq!(item.subject, "【芒市医共体】试剂出库查询，过滤框输入字符就报错");
    }

    #[test]
    fn parses_get_workitem_wrapped_result_response() {
        let json = format!(r#"{{"success": true, "result": {WORKITEM_JSON}}}"#);
        let item = parse_workitem_response(json.as_bytes()).expect("wrapped response parses");
        assert_eq!(item.id, "741d91e70b392b65ef95604c1f");
        assert_eq!(item.status.as_ref().unwrap().name, "待处理");
    }

    #[test]
    fn get_workitem_parse_error_on_garbage() {
        assert!(parse_workitem_response(b"not json").is_err());
        assert!(parse_workitem_response(br#"{"success": true}"#).is_err());
    }

    #[test]
    fn normalizes_plain_string_description() {
        assert_eq!(
            normalize_issue_description(serde_json::json!("plain text")),
            Some("plain text".to_string())
        );
    }

    #[test]
    fn normalizes_rich_text_json_description() {
        let json = serde_json::json!({
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "第一行"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "第二行"}]}
            ]
        });
        assert_eq!(
            normalize_issue_description(json).as_deref(),
            Some("第一行\n第二行")
        );
    }

    #[test]
    fn strips_html_tags_in_description() {
        assert_eq!(
            normalize_issue_description(serde_json::json!("<p>hello</p>")),
            Some("hello".to_string())
        );
    }

    #[test]
    fn deserializes_object_description_to_readable_text() {
        let json = r#"{"description": {"document": "对象描述"}, "id": "x", "subject": "s"}"#;
        let item: YunxiaoWorkitem = serde_json::from_str(json).expect("parses");
        assert_eq!(item.description.as_deref(), Some("对象描述"));
    }

    #[test]
    fn extracts_html_img_urls_case_insensitive() {
        let text = r#"<p>截图如下</p><img src="https://img.alicdn.com/a.png" alt="x"/><IMG src='https://img.alicdn.com/b.jpg'>"#;
        let urls = extract_image_urls_from_text(text);
        assert_eq!(
            urls,
            vec![
                "https://img.alicdn.com/a.png",
                "https://img.alicdn.com/b.jpg"
            ]
        );
    }

    #[test]
    fn extracts_rich_text_image_nodes() {
        let json = serde_json::json!({
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "看下图"}]},
                {"type": "image", "attrs": {"src": "https://img.alicdn.com/s1.png", "alt": "截图"}},
                {"type": "image", "src": "https://img.alicdn.com/s2.png"}
            ]
        });
        let mut urls = Vec::new();
        extract_image_urls_from_value(&json, &mut urls);
        assert_eq!(
            urls,
            vec![
                "https://img.alicdn.com/s1.png",
                "https://img.alicdn.com/s2.png"
            ]
        );
    }

    #[test]
    fn extracts_markdown_images_and_dedups() {
        let text = "![a](https://img.alicdn.com/m1.png) 和 ![b](https://img.alicdn.com/m1.png)";
        let urls = extract_image_urls_from_text(text);
        assert_eq!(urls, vec!["https://img.alicdn.com/m1.png"]);
    }

    #[test]
    fn extracts_html_img_inside_rich_text_text_node() {
        let json = serde_json::json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": "<img src=\"https://img.alicdn.com/x.png\">"}]}]
        });
        let mut urls = Vec::new();
        extract_image_urls_from_value(&json, &mut urls);
        assert_eq!(urls, vec!["https://img.alicdn.com/x.png"]);
    }

    #[test]
    fn returns_empty_when_no_images() {
        let urls = extract_image_urls_from_text("纯文字描述，没有图片");
        assert!(urls.is_empty());
        let mut urls = Vec::new();
        extract_image_urls_from_value(&serde_json::json!({"type": "doc"}), &mut urls);
        assert!(urls.is_empty());
    }

    #[test]
    fn image_host_whitelist_checks_scheme_and_domain() {
        assert!(is_allowed_image_host("img.alicdn.com"));
        assert!(is_allowed_image_host("yunxiao.oss-cn-hangzhou.aliyuncs.com"));
        assert!(is_allowed_image_host("devops.aliyun.com"));
        assert!(!is_allowed_image_host("evil.example.com"));
        assert!(normalize_image_url("http://img.alicdn.com/a.png").is_none());
        assert!(normalize_image_url("https://evil.example.com/a.png").is_none());
        assert!(normalize_image_url("https://img.alicdn.com/a.png").is_some());
    }

    #[test]
    fn image_extension_maps_supported_types() {
        assert_eq!(image_extension("image/png"), Some("png"));
        assert_eq!(image_extension("image/jpeg"), Some("jpg"));
        assert_eq!(image_extension("image/webp"), Some("webp"));
        assert_eq!(image_extension("text/html"), None);
        assert_eq!(image_extension("application/octet-stream"), None);
    }
}
