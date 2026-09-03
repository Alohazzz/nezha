//! 云效 (Alibaba Cloud DevOps / Projex) OpenAPI 集成。
//! 官方文档要点（help.aliyun.com/zh/yunxiao/developer-reference/）：
//! - 中心版服务接入点：`openapi-rdc.aliyuncs.com`
//! - 鉴权头：`x-yunxiao-token: <个人访问令牌>`
//! - organizationId 仅中心版需要（组织管理后台 → 基本信息）
//! - 工作项查询：`POST /oapi/v1/projex/organizations/{orgId}/workitems:search`
//!
//! v1 只做只读查询（组织 / 项目 / 工作项），不做写回云效。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use parking_lot::Mutex;
use pulldown_cmark::{html, Options, Parser};

pub(crate) const API_BASE: &str = "https://openapi-rdc.aliyuncs.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ISSUE_IMAGES: usize = 20;
const MAX_COMMENT_CHARS: usize = 20_000;
const MAX_REPORTED_ERRORS: usize = 5;

pub(crate) fn build_client() -> Result<reqwest::Client, String> {
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
pub(crate) async fn read_json_body(resp: reqwest::Response) -> Result<Vec<u8>, String> {
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
    #[serde(
        rename = "customCode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
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
    #[serde(
        rename = "displayName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
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
    #[serde(
        rename = "displayValue",
        default,
        skip_serializing_if = "Option::is_none"
    )]
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
    #[serde(
        rename = "assignedTo",
        default,
        skip_serializing_if = "Option::is_none"
    )]
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
    #[serde(
        rename = "categoryId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub category_id: Option<String>,
    #[serde(
        rename = "logicalStatus",
        default,
        skip_serializing_if = "Option::is_none"
    )]
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

/// 工作项类型字段配置（GET .../workitemTypes/{typeId}/fields 的数组元素）。
#[derive(Deserialize, Clone, Debug, Default)]
pub struct YunxiaoFieldConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// 按名称「价值评分」查找字段 ID（名称是 issue-value-scoring 技能与云效字段配置的约定）。
fn find_value_score_field_id(configs: &[YunxiaoFieldConfig]) -> Option<&str> {
    configs
        .iter()
        .find(|c| c.name == "价值评分")
        .map(|c| c.id.as_str())
        .filter(|id| !id.is_empty())
}

/// UpdateWorkitem 请求体：字段 ID 直接作为顶层 key，value 为字符串（官方文档格式）。
fn build_update_field_payload(field_id: &str, value: i32) -> serde_json::Value {
    serde_json::json!({ field_id: value.to_string() })
}

/// 从工作项详情 JSON 中提取项目（space）与工作项类型 ID，供字段配置查询使用。
fn extract_workitem_placements(workitem: &serde_json::Value) -> Option<(String, String)> {
    let project_id = workitem.get("space")?.get("id")?.as_str()?;
    let type_id = workitem.get("workitemType")?.get("id")?.as_str()?;
    if project_id.is_empty() || type_id.is_empty() {
        return None;
    }
    Some((project_id.to_string(), type_id.to_string()))
}

/// 「价值评分」字段 ID 的内存缓存（org, project, workitemType → fieldId），避免每次发布都查字段配置。
static VALUE_SCORE_FIELD_ID_CACHE: LazyLock<Mutex<HashMap<(String, String, String), String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
pub(crate) async fn get_yunxiao_json(
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
    let payload: CurrentUserPayload =
        serde_json::from_slice(bytes).map_err(|e| format!("解析云效当前用户失败: {e}"))?;
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
fn deserialize_optional_description<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(normalize_issue_description))
}

/// 解析 GetWorkitem 响应：兼容直接对象与 `{"result": {...}}` 包裹形态；
/// 顺带从原始描述计算图片数量（供详情页提示「议题含 N 张图片」）。
fn parse_workitem_response(bytes: &[u8]) -> Result<YunxiaoWorkitem, String> {
    let mut value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("解析云效工作项详情失败: {e}"))?;
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
    let bytes =
        get_yunxiao_json(&client, token, format!("{API_BASE}/oapi/v1/platform/user")).await?;
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
    for category in categories
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
    {
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
            // 富文本图片节点：{"type":"image","src"/"url"/"attrs":{"src":...}}，
            // 以及 JSONML 节点属性对象（["img", {...,"src":...}, ...]，无 type 字段）。
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
            for (_, v) in map {
                extract_image_urls_from_value(v, out);
            }
        }
        _ => {}
    }
}

/// 从议题描述提取图片 URL：描述可能是序列化 JSON 字符串（htmlValue + jsonMLValue，
/// 内部 HTML 引号处于转义态）、纯 HTML / Markdown 文本或对象。
/// 序列化字符串需要二次解析后再提取，否则 `<img src=\"...\">` 的转义引号解析不到。
fn extract_issue_description_urls(value: &serde_json::Value, out: &mut Vec<String>) {
    if let serde_json::Value::String(text) = value {
        let trimmed = text.trim_start();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if let Ok(inner) = serde_json::from_str::<serde_json::Value>(text) {
                extract_image_urls_from_value(&inner, out);
                return;
            }
        }
    }
    extract_image_urls_from_value(value, out);
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
    host.ends_with(".aliyuncs.com")
        || host.ends_with(".alicdn.com")
        || host.ends_with(".aliyun.com")
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

/// 云效工作项文件元数据（`GET .../workitems/{id}/files/{fileIdentifier}` 返回）。
#[derive(Deserialize)]
struct IssueFileMeta {
    #[serde(default)]
    suffix: String,
    #[serde(default)]
    size: Option<u64>,
    url: String,
}

/// 从云效图片链接解析 `fileIdentifier`（形如 `.../file/url?fileIdentifier=<id>`）。
fn extract_file_identifier(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    parsed
        .query_pairs()
        .find(|(key, _)| key == "fileIdentifier")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
}

/// 经 OpenAPI 获取工作项文件信息：描述里的图片链接是 Web 会话端点（返回 401
/// `invalid session`），需先用令牌换取签名 OSS 直链（`url` 字段）再下载。
async fn fetch_issue_file_meta(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    workitem_id: &str,
    file_identifier: &str,
) -> Result<IssueFileMeta, String> {
    let url = format!(
        "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems/{workitem_id}/files/{file_identifier}"
    );
    let bytes = get_yunxiao_json(client, token, url).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("解析云效文件信息失败: {e}"))
}

/// 下载单张议题图片：描述链接先经 OpenAPI 换签名直链（Web 链接 401），
/// 直链下载不携带令牌；域名白名单 + 类型/体积校验。
async fn download_issue_image(
    download_client: &reqwest::Client,
    api_client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    workitem_id: &str,
    url: &str,
) -> Result<(Vec<u8>, String), String> {
    let (download_url, ext_hint) = match extract_file_identifier(url) {
        Some(file_identifier) => {
            let meta = fetch_issue_file_meta(
                api_client,
                token,
                organization_id,
                workitem_id,
                &file_identifier,
            )
            .await?;
            if let Some(size) = meta.size {
                if size > MAX_IMAGE_BYTES as u64 {
                    return Err(format!("图片超过 10MB（{size} 字节）"));
                }
            }
            let parsed = normalize_image_url(&meta.url)
                .ok_or_else(|| "文件下载地址非法（非 https 或非阿里云域名）".to_string())?;
            let ext_hint = image_extension(&format!("image/{}", meta.suffix.to_lowercase()));
            (parsed, ext_hint)
        }
        None => {
            // 兜底：直接下载签名链接（如 OSS 直链），不携带令牌。
            let parsed = normalize_image_url(url)
                .ok_or_else(|| "图片地址非法（非 https 或非阿里云域名）".to_string())?;
            (parsed, None)
        }
    };
    let resp = download_client
        .get(download_url)
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
    let ext = ext_hint
        .or_else(|| image_extension(&content_type))
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
    let mut json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析云效工作项详情失败: {e}"))?;
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
    extract_issue_description_urls(&description, &mut urls);
    if urls.is_empty() {
        return Ok(IssueImagesPrepared::default());
    }

    // 2) 逐张下载（先用令牌换签名直链，再下载），序号命名
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
        match download_issue_image(
            &download_client,
            &client,
            &token,
            &organization_id,
            &workitem_id,
            &url,
        )
        .await
        {
            Ok((data, ext)) => {
                let filename = format!("image-{:02}.{}", result.downloaded + 1, ext);
                let file_path = attachments_dir.join(&filename);
                if let Err(e) = std::fs::write(&file_path, &data) {
                    result.failed += 1;
                    push_reported_error(&mut result.errors, format!("写入 {filename} 失败: {e}"));
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
    post_workitem_comment(&client, &token, &organization_id, &workitem_id, &content).await
}

/// 把 Markdown 转成云效工作项富文本 `content`（CreateWorkitemComment 的 content 字段要求富文本 JSON 字符串）。
///
/// 云效富文本规范（实测确认，含临时议题 3cddd161d3ca59dd3c52e5acc0 复验）：评论/描述 `content` 是一个 JSON 字符串，
/// 形如 `{"htmlValue":"<article class=\"4ever-article\">…</article>","jsonMLValue":["root",{},…]}`，且
/// `contentFormat="RICHTEXT"`。**`jsonMLValue` 必须是合法的 JSONML 树，绝不能是空数组 `[]`**——空数组会触发云效前端
/// `jsonMLToValue` 抛 `Cannot find any rule which match`，导致议题页白屏。
///
/// 这里用 pulldown-cmark 解析 Markdown，同时生成 htmlValue 与完整 jsonMLValue 双份。
/// 节点映射（均经实测确认合法）：标题 → `h3`（加粗 span），段落 → `p`，加粗 → leaf `bold:true`；
/// 列表项 / 代码块 / 引用为规避未实测的节点类型，降级为带前缀的 `p` 段落（不崩、可读）。
fn markdown_to_yunxiao_rich_text(markdown: &str) -> String {
    let md = markdown.trim();
    if md.is_empty() {
        return String::new();
    }
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_TASKLISTS);

    // 生成 htmlValue：直接渲染 HTML 包进 4ever-article 容器（阅读态富文本）。
    let mut body = String::new();
    html::push_html(&mut body, Parser::new_ext(md, opts));
    let html_value = format!("<article class=\"4ever-article\">{body}</article>");

    // 生成 jsonMLValue：root 下仅 p + span(leaf)，每行纯文本（云效评论最小可接受结构，保证不崩）。
    let jsonml_value = md_to_safe_jsonml(md);

    serde_json::json!({
        "htmlValue": html_value,
        "jsonMLValue": jsonml_value,
    })
    .to_string()
}

/// 生成云效「评论 / 描述」能渲染的 jsonMLValue 富文本树。
///
/// 规则引擎（实测：QHDK-30023 临时议题 + QHDK-29994 评论对比，以及黄金模板评论 22971651）：
/// - 块节点结构是 `["tag", attrs, child1, child2, ...]`，children 直接是第 3 位起的子节点，**不能**包成数组；
/// - 标题 → `h3`（leaf 带 `bold/sz/szUnit`），段落 → `p`，行内 `**x**` → bold leaf；
/// - 不接受空数组、多余嵌套数组、未实测节点（table/ul/ol/blockquote）——这些会触发 jsonMLToValue 崩。
/// 因此这里把标题/加粗映射为 h3/bold leaf，列表/引用/代码块降级为带前缀的 p 段落，并剥离 Markdown/HTML 残留。
fn md_to_safe_jsonml(markdown: &str) -> serde_json::Value {
    // 按云效编辑器黄金模板（实测 QHDK-30023 评论 id=22971651 阅读态富文本正常且不崩）生成 JSONML。
    // 标题 -> h3 (leaf bold+sz+szUnit)，正文 -> p，行内 **x** -> bold leaf；列表/引用用前缀段落。
    let mut blocks: Vec<serde_json::Value> = Vec::new();
    let mut in_code = false;

    fn flush_para(spans: Vec<serde_json::Value>) -> serde_json::Value {
        // 云效 JSONML 的块节点结构是 `["tag", attrs, child1, child2, ...]`：children 直接是 Node 的
        // 第 3 位起多个参数，**不能**再用一个数组包住 children（`["p",{},[span]]` 会触发 jsonMLToValue 崩）。
        let mut arr = vec![serde_json::Value::String("p".to_string()), serde_json::json!({})];
        arr.extend(spans);
        serde_json::Value::Array(arr)
    }
    fn text_span(text: &str, bold: bool) -> serde_json::Value {
        if bold {
            serde_json::json!(["span", {"data-type":"text"}, ["span", {"bold":true,"sz":14,"szUnit":"pt","data-type":"leaf"}, text]])
        } else {
            serde_json::json!(["span", {"data-type":"text"}, ["span", {"data-type":"leaf"}, text]])
        }
    }
    fn heading_node(text: &str) -> serde_json::Value {
        serde_json::json!(["h3", {"spacing":{"before":12,"after":12,"line":0.8529411764705882}},
            ["span", {"data-type":"text"}, ["span", {"bold":true,"sz":14,"szUnit":"pt","data-type":"leaf"}, text]]])
    }

    for raw_line in markdown.lines() {
        let line = raw_line.trim_end();
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") { in_code = !in_code; continue; }
        if trimmed.is_empty() { continue; }

        if in_code {
            let text = strip_markdown_line(line);
            if !text.is_empty() { blocks.push(flush_para(vec![text_span(&text, false)])); }
            continue;
        }

        // 标题（H1-H6 统一映射为 h3，云效评论只认 h3）
        if trimmed.starts_with('#') {
            let title = strip_markdown_line(trimmed.trim_start_matches('#'));
            if !title.is_empty() { blocks.push(heading_node(&title)); }
            continue;
        }
        // 无序列表
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
            let t = strip_markdown_line(trimmed.trim_start_matches(['-','*','+']).trim());
            if !t.is_empty() { blocks.push(flush_para(vec![text_span(&format!("- {}", t), false)])); }
            continue;
        }
        // 有序列表：数字.
        if let Some(digits) = strip_ordered_prefix(trimmed) {
            let t = strip_markdown_line(digits);
            if !t.is_empty() { blocks.push(flush_para(vec![text_span(&t, false)])); }
            continue;
        }
        // 引用
        if trimmed.starts_with("> ") || trimmed.starts_with('>') {
            let t = strip_markdown_line(trimmed.trim_start_matches('>').trim());
            if !t.is_empty() { blocks.push(flush_para(vec![text_span(&format!("▏ {}", t), false)])); }
            continue;
        }

        // 待办清单 [- x] / [x]
        if trimmed.starts_with("[x]") || trimmed.starts_with("[ ]") || trimmed.starts_with("[X]") {
            let t = strip_markdown_line(trimmed);
            if !t.is_empty() { blocks.push(flush_para(vec![text_span(&t, false)])); }
            continue;
        }

        // 普通段落：先在含 ** 的原文上拆出 bold 片段，再对每段剥掉其余 Markdown。
        let spans = split_inline_bold(trimmed);
        if !spans.is_empty() {
            blocks.push(flush_para(spans));
        }
    }

    if blocks.is_empty() {
        blocks.push(flush_para(vec![text_span("", false)]));
    }
    serde_json::Value::Array(vec![
        serde_json::Value::String("root".to_string()),
        serde_json::json!({}),
        serde_json::Value::Array(blocks),
    ])
}

/// 去掉有序列表的 "1. " 等数字前缀，返回剩余部分。
fn strip_ordered_prefix(line: &str) -> Option<&str> {
    let mut chars = line.chars();
    let mut digit_count = 0;
    while let Some(ch) = chars.next() {
        if ch.is_ascii_digit() { digit_count += 1; } else { break; }
    }
    if digit_count == 0 { return None; }
    let rest = line[digit_count..].trim_start();
    if let Some(r) = rest.strip_prefix(".") { Some(r.trim_start()) } else { None }
}

/// 把含 `**` 的原文按加粗态拆成「普通 / 加粗」交替的 span 序列；每段再剥离其余 Markdown。
fn split_inline_bold(text: &str) -> Vec<serde_json::Value> {
    let mut spans = Vec::new();
    let mut bold = false;
    let mut rest = text;
    loop {
        let idx = rest.find("**");
        let segment = match idx {
            Some(i) => {
                let seg = &rest[..i];
                rest = &rest[i + 2..];
                seg
            }
            None => {
                let seg = rest;
                rest = "";
                seg
            }
        };
        let cleaned = strip_markdown_line(segment);
        if !cleaned.is_empty() {
            spans.push(text_span_leaf(&cleaned, bold));
        }
        bold = !bold;
        if idx.is_none() {
            break;
        }
    }
    if spans.is_empty() { spans.push(text_span_leaf("", false)); }
    spans
}

fn text_span_leaf(text: &str, bold: bool) -> serde_json::Value {
    if bold {
        serde_json::json!(["span", {"data-type":"text"}, ["span", {"bold":true,"sz":14,"szUnit":"pt","data-type":"leaf"}, text]])
    } else {
        serde_json::json!(["span", {"data-type":"text"}, ["span", {"data-type":"leaf"}, text]])
    }
}

fn strip_markdown_line(line: &str) -> String {
    let mut s = line.trim().to_string();
    // 标题前缀：连续 # 后跟空格
    s = s.replace("# ", "").replace("#", "");
    // 任务清单勾选框 [x] / [ ]
    s = s.replace("[x]", "").replace("[X]", "").replace("[ ]", "").replace("[]", "");
    // 加粗/斜体/删除线标记
    for pat in ["**", "__", "~~", "*", "_"] {
        s = s.replace(pat, "");
    }
    // 行内代码反引号
    s = s.replace('`', "");
    // 链接 / 图片：保留文字部分，去 URL；图片残留的 ! 去掉
    s = replace_markdown_links(&s);
    s = s.replace("![", "").replace("!", "");
    // HTML 标签整体剥离（<u>、<del>、<br>、<input ...> 等），避免把 < > 当特殊符号带入
    s = strip_inline_html_tags(&s);
    // 表格行：'|' 替换为空格
    s = s.replace('|', " ");
    s.trim().to_string()
}

/// 剥离整行内的 HTML/类标签片段（<u>…</u> → 中间文本；孤立标签直接去掉）。
fn strip_inline_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '<' {
            for c2 in chars.by_ref() {
                if c2 == '>' { break; }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// 把 `[文字](url)` / `![alt](url)` 还原成「文字」，去括号与 URL。
fn replace_markdown_links(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(close) = s[i + 1..].find(']') {
                let label = &s[i + 1..i + 1 + close];
                let rest = &s[i + 1 + close + 1..];
                if let Some(rest) = rest.strip_prefix('(') {
                    if let Some(end) = rest.find(')') {
                        out.push_str(label);
                        i = i + 1 + close + 1 + 1 + end + 1;
                        continue;
                    }
                }
            }
        }
        out.push(s[i..].chars().next().unwrap_or(' '));
        i += s[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
    }
    out
}

/// POST 创建评论（CreateWorkitemComment），返回评论 ID。
async fn post_workitem_comment(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    workitem_id: &str,
    content: &str,
) -> Result<String, String> {
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
    let created: CommentCreated =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析云效创建评论响应失败: {e}"))?;
    Ok(created.id)
}

/// 提交总结回写结果：评论必然已发布；评分字段写入状态与警告分开返回。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct YunxiaoWritebackResult {
    pub dev_comment_id: String,
    /// 测试向评论 ID（测试内容为空时未发布，为 None）。
    pub test_comment_id: Option<String>,
    /// 解析出的评分指数（四舍五入），无评分小节时为 None。
    pub score_value: Option<i32>,
    /// 「价值评分」字段是否写入成功。
    pub field_written: bool,
    /// 非阻断警告（评分缺失 / 字段未找到 / 字段写入失败）。
    pub warning: Option<String>,
}

/// 提交总结回写：发布两条评论（开发向 + 测试向），再把「价值评分」写入议题字段。
/// - 开发向评论保留「价值评分」推导小节（面向开发解释评分由来）；
/// - 评分数值同时从开发向评论解析并写入议题「价值评分」字段；
/// - 测试向评论为空时跳过发布（test_comment_id=None）。
/// 字段写入失败不阻断（返回 warning，前端提供「补写字段」入口）。
#[tauri::command]
pub async fn yunxiao_writeback_with_score(
    token: String,
    organization_id: String,
    workitem_id: String,
    dev_content: String,
    test_content: String,
) -> Result<YunxiaoWritebackResult, String> {
    let token = token.trim().to_string();
    let organization_id = organization_id.trim().to_string();
    let workitem_id = workitem_id.trim().to_string();
    if token.is_empty() || organization_id.is_empty() || workitem_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或工作项 ID".to_string());
    }
    let dev_content = dev_content.trim();
    let test_content = test_content.trim();
    if dev_content.is_empty() {
        return Err("开发向评论不能为空".to_string());
    }
    if dev_content.chars().count() > MAX_COMMENT_CHARS {
        return Err(format!("开发向评论超过 {MAX_COMMENT_CHARS} 字上限"));
    }
    if test_content.chars().count() > MAX_COMMENT_CHARS {
        return Err(format!("测试向评论超过 {MAX_COMMENT_CHARS} 字上限"));
    }
    // 从开发向评论解析「价值评分」数值（评分小节保留在开发向评论正文里，随评论发布）。
    let score_value = crate::value_score::extract_value_score_section(dev_content)
        .and_then(crate::value_score::parse_value_score_index)
        .map(|v| v.round() as i32);
    // 发送前把 Markdown 转成云效富文本 JSON（评分解析已在原始 Markdown 上完成，转换不破坏评分链路）。
    let dev_rich = markdown_to_yunxiao_rich_text(dev_content);
    let test_rich = markdown_to_yunxiao_rich_text(test_content);

    let client = build_client()?;
    // 1) 先发布开发向评论（含评分推导小节）。
    let dev_comment_id =
        post_workitem_comment(&client, &token, &organization_id, &workitem_id, &dev_rich).await?;
    // 2) 测试向评论非空时再发布（test_content 非空则 test_rich 必非空）。
    let test_comment_id = if test_content.is_empty() {
        None
    } else {
        Some(
            post_workitem_comment(
                &client,
                &token,
                &organization_id,
                &workitem_id,
                &test_rich,
            )
            .await?,
        )
    };

    // 3) 评分写入议题字段（失败不阻断，返回 warning）
    let Some(score_value) = score_value else {
        return Ok(YunxiaoWritebackResult {
            dev_comment_id,
            test_comment_id,
            score_value: None,
            field_written: false,
            warning: Some("未检测到价值评分小节，未写入议题字段".to_string()),
        });
    };
    match write_value_score_field(&client, &token, &organization_id, &workitem_id, score_value)
        .await
    {
        Ok(()) => Ok(YunxiaoWritebackResult {
            dev_comment_id,
            test_comment_id,
            score_value: Some(score_value),
            field_written: true,
            warning: None,
        }),
        Err(warning) => Ok(YunxiaoWritebackResult {
            dev_comment_id,
            test_comment_id,
            score_value: Some(score_value),
            field_written: false,
            warning: Some(warning),
        }),
    }
}

/// 补写「价值评分」字段（评论已发布但字段写入失败时的重试入口，不重复发评论）。
#[tauri::command]
pub async fn yunxiao_write_score_field(
    token: String,
    organization_id: String,
    workitem_id: String,
    value: i32,
) -> Result<(), String> {
    let token = token.trim().to_string();
    let organization_id = organization_id.trim().to_string();
    let workitem_id = workitem_id.trim().to_string();
    if token.is_empty() || organization_id.is_empty() || workitem_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或工作项 ID".to_string());
    }
    let client = build_client()?;
    write_value_score_field(&client, &token, &organization_id, &workitem_id, value).await
}

/// 自动探测「价值评分」字段并写入（字段不存在 / 探测失败返回 Err，由调用方转成 warning）。
async fn write_value_score_field(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    workitem_id: &str,
    value: i32,
) -> Result<(), String> {
    let (project_id, workitem_type_id) =
        fetch_workitem_placements(client, token, organization_id, workitem_id).await?;
    let field_id = fetch_value_score_field_id(
        client,
        token,
        organization_id,
        &project_id,
        &workitem_type_id,
    )
    .await
    .ok_or_else(|| "议题类型未配置「价值评分」字段".to_string())?;
    update_workitem_field(
        client,
        token,
        organization_id,
        workitem_id,
        &field_id,
        value,
    )
    .await
}

/// 拉取工作项详情并提取项目 / 类型 ID（字段配置查询的前置）。
async fn fetch_workitem_placements(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    workitem_id: &str,
) -> Result<(String, String), String> {
    let url = format!(
        "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems/{workitem_id}"
    );
    let bytes = get_yunxiao_json(client, token, url).await?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析云效工作项详情失败: {e}"))?;
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
    extract_workitem_placements(&value).ok_or_else(|| "工作项详情缺少项目或类型信息".to_string())
}

/// 查询工作项类型的字段配置，按名称找「价值评分」字段（带进程内缓存）。
async fn fetch_value_score_field_id(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    project_id: &str,
    workitem_type_id: &str,
) -> Option<String> {
    let key = (
        organization_id.to_string(),
        project_id.to_string(),
        workitem_type_id.to_string(),
    );
    if let Some(cached) = VALUE_SCORE_FIELD_ID_CACHE.lock().get(&key) {
        return Some(cached.clone());
    }
    let url = format!(
        "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}/workitemTypes/{workitem_type_id}/fields"
    );
    let bytes = get_yunxiao_json(client, token, url).await.ok()?;
    let configs: Vec<YunxiaoFieldConfig> = serde_json::from_slice(&bytes).ok()?;
    let found = find_value_score_field_id(&configs).map(str::to_string);
    if let Some(id) = found.clone() {
        VALUE_SCORE_FIELD_ID_CACHE.lock().insert(key, id);
    }
    found
}

/// PUT 更新工作项字段（UpdateWorkitem，官方文档格式 `{"fieldId": "value"}`）。
async fn update_workitem_field(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    workitem_id: &str,
    field_id: &str,
    value: i32,
) -> Result<(), String> {
    let resp = client
        .put(format!(
            "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems/{workitem_id}"
        ))
        .header("x-yunxiao-token", token)
        .header("Content-Type", "application/json")
        .json(&build_update_field_payload(field_id, value))
        .send()
        .await
        .map_err(|e| format!("请求云效更新字段失败: {e}"))?;
    let _ = read_json_body(resp).await?;
    Ok(())
}

/// PUT 更新工作项字段（字符串值版，如 status=状态ID）。
async fn update_workitem_field_str(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    workitem_id: &str,
    field_id: &str,
    value: &str,
) -> Result<(), String> {
    let resp = client
        .put(format!(
            "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems/{workitem_id}"
        ))
        .header("x-yunxiao-token", token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ field_id: value }))
        .send()
        .await
        .map_err(|e| format!("请求云效更新字段失败: {e}"))?;
    let _ = read_json_body(resp).await?;
    Ok(())
}

/// 查询指定工作项类型工作流里名为「已完成」的状态 ID；找不到时报错。
async fn find_done_status_id(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    project_id: &str,
    workitem_type_id: &str,
) -> Result<String, String> {
    let url = format!(
        "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}/workitemTypes/{workitem_type_id}/workflows"
    );
    let bytes = get_yunxiao_json(client, token, url).await?;
    let statuses = parse_workflow_statuses(&bytes)?;
    statuses
        .iter()
        .find(|s| s.name == "已完成" || s.display_name.as_deref() == Some("已完成"))
        .map(|s| s.id.clone())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "工作流中未找到「已完成」状态".to_string())
}

/// 把工作项状态置为「已完成」（知识沉淀自动回写闭环用）。
#[tauri::command]
pub async fn yunxiao_complete_workitem(
    token: String,
    organization_id: String,
    workitem_id: String,
) -> Result<(), String> {
    let token = token.trim().to_string();
    let organization_id = organization_id.trim().to_string();
    let workitem_id = workitem_id.trim().to_string();
    if token.is_empty() || organization_id.is_empty() || workitem_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或工作项 ID".to_string());
    }
    let client = build_client()?;
    let (project_id, workitem_type_id) =
        fetch_workitem_placements(&client, &token, &organization_id, &workitem_id).await?;
    let status_id = find_done_status_id(
        &client,
        &token,
        &organization_id,
        &project_id,
        &workitem_type_id,
    )
    .await?;
    update_workitem_field_str(
        &client,
        &token,
        &organization_id,
        &workitem_id,
        "status",
        &status_id,
    )
    .await
}

/// 知识沉淀创建的审核议题结果：`duplicated=true` 表示标题已存在（幂等，不重复创建）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateKnowledgeIssueResult {
    pub created: bool,
    pub duplicated: bool,
    pub workitem_id: String,
}

/// 获取当前令牌用户 ID（创建议题时作为指派人）。
async fn fetch_current_user_id(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let bytes =
        get_yunxiao_json(client, token, format!("{API_BASE}/oapi/v1/platform/user")).await?;
    let user = parse_current_user(&bytes)?;
    if user.id.is_empty() {
        return Err("无法获取当前用户 ID".to_string());
    }
    Ok(user.id)
}

/// 获取项目下指定类别的工作项类型 ID（CreateWorkitem 必填）。
async fn fetch_default_workitem_type_id(
    client: &reqwest::Client,
    token: &str,
    organization_id: &str,
    project_id: &str,
    category: &str,
) -> Result<String, String> {
    let url = format!(
        "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}/workitemTypes?category={category}"
    );
    let bytes = get_yunxiao_json(client, token, url).await?;
    let types: Vec<YunxiaoWorkitemType> =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析云效工作项类型失败: {e}"))?;
    types
        .iter()
        .find(|t| t.category_id == category)
        .or_else(|| types.first())
        .map(|t| t.id.clone())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("目标项目未找到 {category} 工作项类型"))
}

/// 创建知识沉淀审核议题（CreateWorkitem）：先按标题去重（搜索目标项目最近需求议题，
/// 标题完全一致视为已存在），未命中才创建。已用真实 token 复验：
/// body 需 `spaceId` + `assignedTo`（当前用户 id）+ `workitemTypeId`（默认需求类型）。
#[tauri::command]
pub async fn yunxiao_create_knowledge_issue(
    token: String,
    organization_id: String,
    project_id: String,
    subject: String,
    description: String,
) -> Result<CreateKnowledgeIssueResult, String> {
    let token = token.trim().to_string();
    let organization_id = organization_id.trim().to_string();
    let project_id = project_id.trim().to_string();
    if token.is_empty() || organization_id.is_empty() || project_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或项目 ID".to_string());
    }
    let subject = subject.trim().to_string();
    if subject.is_empty() {
        return Err("议题标题不能为空".to_string());
    }
    if description.chars().count() > MAX_COMMENT_CHARS {
        return Err(format!("议题描述超过 {MAX_COMMENT_CHARS} 字上限"));
    }
    // description 字段要求富文本 JSON 字符串（与评论一致），否则云效把 Markdown 当纯文本显示。
    let description = markdown_to_yunxiao_rich_text(&description);

    // 1) 去重：搜索项目内最近需求议题，标题完全一致视为已存在
    let page = yunxiao_search_workitems(
        token.clone(),
        organization_id.clone(),
        project_id.clone(),
        Some("Req".to_string()),
        None,
        Some(1),
        Some(200),
    )
    .await?;
    if let Some(existing) = page.items.iter().find(|w| w.subject.trim() == subject) {
        return Ok(CreateKnowledgeIssueResult {
            created: false,
            duplicated: true,
            workitem_id: existing.id.clone(),
        });
    }

    // 2) 创建
    let client = build_client()?;
    let assigned_to = fetch_current_user_id(&client, &token).await?;
    let workitem_type_id =
        fetch_default_workitem_type_id(&client, &token, &organization_id, &project_id, "Req")
            .await?;
    let resp = client
        .post(format!(
            "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems"
        ))
        .header("x-yunxiao-token", &token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "category": "Req",
            "subject": subject,
            "description": description,
            "spaceId": project_id,
            "assignedTo": assigned_to,
            "workitemTypeId": workitem_type_id,
        }))
        .send()
        .await
        .map_err(|e| format!("请求云效创建议题失败: {e}"))?;
    let bytes = read_json_body(resp).await?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析云效创建议题响应失败: {e}"))?;
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
    let workitem_id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "创建议题响应中没有工作项 ID".to_string())?
        .to_string();
    Ok(CreateKnowledgeIssueResult {
        created: true,
        duplicated: false,
        workitem_id,
    })
}

// ── 补录议题（backfill skill 驱动）─────────────────────────────────────────────

/// 补录议题的描述内容段（标题 + 正文）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct BackfillContentSection {
    pub label: String,
    #[serde(default)]
    pub text: String,
}

/// 补录议题请求：由 `yunxiao-backfill-issue` skill 盘问后写入 `backfill-issue.json`。
/// 前端 / 侦测逻辑读取后传给 `yunxiao_create_backfill_issue`。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct BackfillIssueRequest {
    pub category: String,
    pub subject: String,
    #[serde(rename = "contentSections", default)]
    pub content_sections: Vec<BackfillContentSection>,
    #[serde(rename = "customFields", default)]
    pub custom_fields: Vec<YunxiaoCustomFieldValue>,
    #[serde(
        rename = "sourceNote",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub source_note: Option<String>,
}

/// 补录议题创建结果。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CreateBackfillIssueResult {
    pub created: bool,
    #[serde(rename = "workitemId")]
    pub workitem_id: String,
    #[serde(
        rename = "serialNumber",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub serial_number: Option<String>,
}

/// 从补录请求拼 description：按内容段拼接，末尾追加来源行。
fn build_backfill_description(request: &BackfillIssueRequest) -> String {
    let mut parts: Vec<String> = Vec::new();
    for section in &request.content_sections {
        let text = section.text.trim();
        if text.is_empty() {
            continue;
        }
        let label = section.label.trim();
        if label.is_empty() {
            parts.push(text.to_string());
        } else {
            parts.push(format!("## {label}\n{text}"));
        }
    }
    if let Some(note) = request.source_note.as_ref() {
        let note = note.trim();
        if !note.is_empty() {
            parts.push(note.to_string());
        }
    }
    parts.join("\n\n")
}

/// CreateWorkitem 的自定义字段为扁平对象 `{fieldId: 选项id}`（实测确认，非数组结构）。
fn build_create_custom_field_values(
    custom_fields: &[YunxiaoCustomFieldValue],
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    for field in custom_fields {
        // list 字段取第一个选项的 identifier（模板里 options[].identifier = 真实 option id）作为写入值。
        if let Some(value) = field.values.iter().find_map(|v| v.identifier.clone()) {
            map.insert(field.field_id.clone(), serde_json::Value::String(value));
        }
    }
    map
}

/// 创建「补录议题」：按类别（Req/Bug）取工作项类型，正文由内容段拼装，基础字段经
/// `customFieldValues` 透传（字段 ID / 选项标识由模板配置驱动，避免硬编码）。
#[tauri::command]
pub async fn yunxiao_create_backfill_issue(
    token: String,
    organization_id: String,
    project_id: String,
    request: BackfillIssueRequest,
) -> Result<CreateBackfillIssueResult, String> {
    let token = token.trim().to_string();
    let organization_id = organization_id.trim().to_string();
    let project_id = project_id.trim().to_string();
    if token.is_empty() || organization_id.is_empty() || project_id.is_empty() {
        return Err("缺少云效令牌、组织 ID 或项目 ID".to_string());
    }
    let category = request.category.trim().to_string();
    if category != "Req" && category != "Bug" {
        return Err("议题类别仅支持 Req / Bug".to_string());
    }
    let subject = request.subject.trim().to_string();
    if subject.is_empty() {
        return Err("议题标题不能为空".to_string());
    }
    let description_md = build_backfill_description(&request);
    if description_md.chars().count() > MAX_COMMENT_CHARS {
        return Err(format!("议题描述超过 {MAX_COMMENT_CHARS} 字上限"));
    }
    // description 字段与评论 content 一样要求富文本 JSON 字符串，否则云效把 Markdown 当纯文本显示（## 等裸露）。
    let description = markdown_to_yunxiao_rich_text(&description_md);

    let client = build_client()?;
    let assigned_to = fetch_current_user_id(&client, &token).await?;
    let workitem_type_id =
        fetch_default_workitem_type_id(&client, &token, &organization_id, &project_id, &category)
            .await?;

    let mut body = serde_json::json!({
        "category": category,
        "subject": subject,
        "description": description,
        "spaceId": project_id,
        "assignedTo": assigned_to,
        "workitemTypeId": workitem_type_id,
    });
    if !request.custom_fields.is_empty() {
        let cf = build_create_custom_field_values(&request.custom_fields);
        if !cf.is_empty() {
            body["customFieldValues"] = serde_json::Value::Object(cf);
        }
    }

    let resp = client
        .post(format!(
            "{API_BASE}/oapi/v1/projex/organizations/{organization_id}/workitems"
        ))
        .header("x-yunxiao-token", &token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求云效创建议题失败: {e}"))?;
    let bytes = read_json_body(resp).await?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析云效创建议题响应失败: {e}"))?;
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
    let workitem_id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "创建议题响应中没有工作项 ID".to_string())?
        .to_string();
    let serial_number = value
        .get("serialNumber")
        .and_then(serde_json::Value::as_str)
        .map(|s| s.to_string());
    Ok(CreateBackfillIssueResult {
        created: true,
        workitem_id,
        serial_number,
    })
}

/// 扫描项目草稿根下的补录议题草稿（`.nezha/drafts/*/backfill-issue.json`）。
///
/// 补录侦测用它做全局兜底：不要求目录名等于某个「已知」task id——Agent 即便自造了目录名，
/// 只要文件在 `.nezha/drafts/` 下就能被找到；
/// 目录名（`task_id`）仅作为匹配活跃任务的提示，匹配不到时由前端按项目内唯一活跃任务回落。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackfillDraftEntry {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub request: BackfillIssueRequest,
}

#[tauri::command]
pub async fn list_backfill_drafts(project_path: String) -> Result<Vec<BackfillDraftEntry>, String> {
    let entries = crate::drafts::list_backfill_drafts(&project_path)?;
    let mut out = Vec::new();
    for (task_id, raw) in entries {
        match serde_json::from_str::<BackfillIssueRequest>(&raw) {
            Ok(request) => out.push(BackfillDraftEntry { task_id, request }),
            Err(e) => eprintln!("[backfill] 解析 backfill-issue.json 失败 task_id={task_id}: {e}"),
        }
    }
    Ok(out)
}

/// 补录消费标记：记录已创建的「来源+内容签名」，供前端做幂等去重（防止同一草稿重复建议题）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackfillConsumedMark {
    pub signature: String,
    #[serde(rename = "workitemId")]
    pub workitem_id: String,
}

#[tauri::command]
pub async fn read_backfill_consumed(
    project_path: String,
    task_id: String,
) -> Result<Option<BackfillConsumedMark>, String> {
    let mark = crate::drafts::read_backfill_consumed(&project_path, &task_id)?;
    Ok(mark.map(|(signature, workitem_id)| BackfillConsumedMark {
        signature,
        workitem_id,
    }))
}

#[tauri::command]
pub async fn write_backfill_consumed(
    project_path: String,
    task_id: String,
    signature: String,
    workitem_id: String,
) -> Result<(), String> {
    crate::drafts::write_backfill_consumed(&project_path, &task_id, &signature, &workitem_id)
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
        assert_eq!(
            item.subject,
            "【芒市医共体】试剂出库查询，过滤框输入字符就报错"
        );
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
        let item =
            parse_workitem_response(WORKITEM_JSON.as_bytes()).expect("direct response parses");
        assert_eq!(item.id, "741d91e70b392b65ef95604c1f");
        assert_eq!(item.serial_number, "QHDK-29728");
        assert_eq!(
            item.subject,
            "【芒市医共体】试剂出库查询，过滤框输入字符就报错"
        );
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
    fn extracts_web_file_urls_from_serialized_rich_text_description() {
        // 真实云效 GetWorkitem 返回：description 是序列化 JSON 字符串（htmlValue + jsonMLValue），
        // 内部 HTML 属性引号处于转义态（src=\"...\"），jsonMLValue 是 JSONML 数组节点。
        let description = serde_json::json!(
            r#"{"htmlValue":"<article class=\"4ever-article\"><p><img src=\"https://devops.aliyun.com/projex/api/workitem/file/url?fileIdentifier=abc\" style=\"width:1px\"></p></article>","jsonMLValue":["root",{},["img",{"id":"stmfdb","name":"image.png","size":81580,"src":"https://devops.aliyun.com/projex/api/workitem/file/url?fileIdentifier=abc"},["span"]]]}"#
        );
        let mut urls = Vec::new();
        extract_issue_description_urls(&description, &mut urls);
        assert_eq!(
            urls,
            vec!["https://devops.aliyun.com/projex/api/workitem/file/url?fileIdentifier=abc"]
        );
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
        assert!(is_allowed_image_host(
            "yunxiao.oss-cn-hangzhou.aliyuncs.com"
        ));
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

    #[test]
    fn file_identifier_extracted_from_web_url() {
        assert_eq!(
            extract_file_identifier(
                "https://devops.aliyun.com/projex/api/workitem/file/url?fileIdentifier=a6b8ea78308181bec07771d859"
            ),
            Some("a6b8ea78308181bec07771d859".to_string())
        );
        assert_eq!(
            extract_file_identifier(
                "https://devops.aliyun.com/projex/api/workitem/file/url?foo=1&fileIdentifier=abc&bar=2"
            ),
            Some("abc".to_string())
        );
        assert_eq!(
            extract_file_identifier("https://img.alicdn.com/a.png"),
            None
        );
        assert_eq!(
            extract_file_identifier(
                "https://devops.aliyun.com/projex/api/workitem/file/url?fileIdentifier="
            ),
            None
        );
        assert_eq!(extract_file_identifier(""), None);
    }

    // 来自真实字段配置接口（GET .../workitemTypes/{typeId}/fields）的结构（节选）。
    const FIELDS_JSON: &str = r#"[
      {"name": "标题", "format": "string", "id": "subject"},
      {"name": "优先级", "format": "list", "id": "priority"},
      {"name": "价值评分", "format": "int", "id": "0db46aead43554e949958fff95"}
    ]"#;

    #[test]
    fn finds_value_score_field_by_name() {
        let configs: Vec<YunxiaoFieldConfig> = serde_json::from_str(FIELDS_JSON).unwrap();
        assert_eq!(
            find_value_score_field_id(&configs),
            Some("0db46aead43554e949958fff95")
        );
    }

    #[test]
    fn returns_none_when_value_score_field_missing() {
        let configs: Vec<YunxiaoFieldConfig> =
            serde_json::from_str(r#"[{"name": "标题", "format": "string", "id": "subject"}]"#)
                .unwrap();
        assert_eq!(find_value_score_field_id(&configs), None);
    }

    #[test]
    fn update_payload_uses_field_id_as_top_level_key() {
        let payload = build_update_field_payload("0db46aead43554e949958fff95", 50);
        assert_eq!(
            payload,
            serde_json::json!({"0db46aead43554e949958fff95": "50"})
        );
    }

    #[test]
    fn extracts_project_and_type_ids_from_workitem() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"id": "e9aceaf1424c1560d20bb75250",
                "space": {"name": "Hsp 2.0", "id": "07a763450c8733172523320ab6"},
                "workitemType": {"name": "产品类需求", "id": "9uy29901re573f561d69jn40"}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_workitem_placements(&json),
            Some((
                "07a763450c8733172523320ab6".to_string(),
                "9uy29901re573f561d69jn40".to_string()
            ))
        );
    }

    #[test]
    fn build_backfill_description_joins_sections_and_appends_source() {
        let request = BackfillIssueRequest {
            category: "Bug".to_string(),
            subject: "医保主表合同单位回写不匹配".to_string(),
            content_sections: vec![
                BackfillContentSection {
                    label: "缺陷描述".to_string(),
                    text: "合同单位回写后主表不匹配。".to_string(),
                },
                BackfillContentSection {
                    label: "发生频率".to_string(),
                    text: "必现".to_string(),
                },
                BackfillContentSection {
                    label: "影响范围".to_string(),
                    text: "".to_string(), // 空段落跳过
                },
            ],
            custom_fields: vec![],
            source_note: Some("来源议题：QHDK-29728".to_string()),
        };
        let desc = build_backfill_description(&request);
        assert!(desc.contains("## 缺陷描述\n合同单位回写后主表不匹配。"));
        assert!(desc.contains("## 发生频率\n必现"));
        assert!(!desc.contains("影响范围"));
        assert!(desc.ends_with("来源议题：QHDK-29728"));
    }

    #[test]
    fn build_create_custom_field_values_uses_flat_fieldid_map() {
        let fields = vec![
            YunxiaoCustomFieldValue {
                field_id: "priority".to_string(),
                field_name: "优先级".to_string(),
                values: vec![YunxiaoCustomFieldEntry {
                    identifier: Some("5461a5b1d0ae12fcdf98b048bb".to_string()),
                    display_value: Some("中".to_string()),
                }],
            },
            YunxiaoCustomFieldValue {
                field_id: "12870b90729a20c378a99c9463".to_string(),
                field_name: "来源".to_string(),
                values: vec![YunxiaoCustomFieldEntry {
                    identifier: Some("内部反馈".to_string()),
                    display_value: Some("内部反馈".to_string()),
                }],
            },
            // 空值字段应被跳过
            YunxiaoCustomFieldValue {
                field_id: "empty".to_string(),
                field_name: "空".to_string(),
                values: vec![],
            },
        ];
        let map = build_create_custom_field_values(&fields);
        assert_eq!(
            map.get("priority").and_then(|v| v.as_str()),
            Some("5461a5b1d0ae12fcdf98b048bb")
        );
        assert_eq!(
            map.get("12870b90729a20c378a99c9463")
                .and_then(|v| v.as_str()),
            Some("内部反馈")
        );
        assert!(!map.contains_key("empty"));
    }

    #[test]
    fn create_backfill_issue_result_serializes_workitemid_camelcase() {
        let result = CreateBackfillIssueResult {
            created: true,
            workitem_id: "wi-123".to_string(),
            serial_number: Some("QHDK-123".to_string()),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"workitemId\":\"wi-123\""));
        assert!(json.contains("\"serialNumber\":\"QHDK-123\""));
        assert!(!json.contains("workitem_id"));
    }

    /// 断言 content 是合法的富文本 JSON 字符串，且 jsonMLValue 为非空合法树（root 开头）。
    fn assert_valid_rich_text(md: &str) -> serde_json::Value {
        let rich = markdown_to_yunxiao_rich_text(md);
        let value: serde_json::Value =
            serde_json::from_str(&rich).expect("富文本必须是合法 JSON 字符串");
        let html = value.get("htmlValue").and_then(|v| v.as_str()).expect("有 htmlValue");
        assert!(html.starts_with("<article class=\"4ever-article\">"));
        assert!(html.ends_with("</article>"));
        let jsonml = value.get("jsonMLValue").expect("有 jsonMLValue");
        let arr = jsonml.as_array().expect("jsonMLValue 必须是数组");
        assert!(!arr.is_empty(), "jsonMLValue 绝不能是空数组（会致云效白屏）");
        assert_eq!(arr[0], serde_json::Value::String("root".to_string()));
        value
    }

    #[test]
    fn markdown_to_rich_text_root_has_heading_and_paragraph() {
        let value = assert_valid_rich_text("# 标题\n\n正文段落");
        let jsonml = value.get("jsonMLValue").unwrap().as_array().unwrap();
        let blocks = jsonml[2].as_array().expect("root 第 2 项是 block 数组");
        let value_str = value.to_string();
        // 标题 -> h3，正文 -> p；两者都应存在。
        assert!(blocks.iter().any(|b| b.get(0).and_then(|v| v.as_str()) == Some("h3")),
            "标题应映射为 h3: {value_str}");
        assert!(blocks.iter().any(|b| b.get(0).and_then(|v| v.as_str()) == Some("p")),
            "正文应映射为 p: {value_str}");
        // h3 结构必须与黄金模板一致（children 直接是 span，leaf 带 bold+sz+szUnit，无多余嵌套数组）。
        assert!(value_str.contains("\"bold\":true"), "h3 leaf 应带 bold:true: {value_str}");
        assert!(value_str.contains("\"sz\":14"), "h3 leaf 应带 sz:14: {value_str}");
        assert!(!value_str.contains("\"data-type\":\"text\"},[["), "text children 不得多套数组: {value_str}");
    }

    #[test]
    fn markdown_to_rich_text_inline_bold_uses_golden_leaf() {
        let value = assert_valid_rich_text("这是**加粗**文字");
        let jsonml = value.get("jsonMLValue").unwrap().to_string();
        // 富文本实现应把 **加粗** 转成带 bold+sz 的 leaf（黄金模板），而非剥离。
        assert!(jsonml.contains("\"bold\":true"), "行内加粗应生成 bold leaf: {jsonml}");
        assert!(jsonml.contains("\"sz\":14") && jsonml.contains("\"szUnit\":\"pt\""), "bold leaf 应带 sz/szUnit: {jsonml}");
        assert!(jsonml.contains("加粗"), "应保留加粗文字: {jsonml}");
        assert!(!jsonml.contains("\"data-type\":\"text\"},[["), "不得多套嵌套数组: {jsonml}");
    }

    #[test]
    fn markdown_to_rich_text_list_and_code_downgrade_to_plain_paragraph() {
        // 列表/代码块降级为带前缀的纯文本 p 段落，root 下仅 p。
        let value = assert_valid_rich_text("- 条目一\n- 条目二\n\n```\nlet x = 1;\n```");
        let jsonml = value.get("jsonMLValue").unwrap().to_string();
        assert!(!jsonml.contains("\"ul\"") && !jsonml.contains("\"ol\""));
        assert!(!jsonml.contains("\"li\"") && !jsonml.contains("\"code\""));
        assert!(!jsonml.contains("\"table\"") && !jsonml.contains("\"blockquote\""));
        assert!(jsonml.contains("条目一"));
        assert!(jsonml.contains("let x = 1;"));
    }

    #[test]
    fn markdown_to_rich_text_empty_returns_empty() {
        assert_eq!(markdown_to_yunxiao_rich_text("   "), "");
        assert_eq!(markdown_to_yunxiao_rich_text(""), "");
    }

    #[test]
    fn markdown_to_rich_text_jsonml_matches_known_good_nesting() {
        // 黄金样本：实测在云效议题 3cddd161d3ca59dd3c52e5acc0 上能正常渲染（不白屏）的 p 段落结构。
        // p.children 必须是 `["span",{"data-type":"text"},["span",{"data-type":"leaf"},"文本"]]`，
        // 即 text 的 children 直接是 leaf 节点，**不能**再多套一层数组。
        let value = assert_valid_rich_text("这是普通段落，用于验证渲染。");
        let value_str = value.to_string();
        // 生成结果中不得出现「text 的 children 再套数组」的错误形态：`"text"},[[` 
        assert!(
            !value_str.contains("\"data-type\":\"text\"},[["),
            "jsonMLValue 的 text children 多套了一层数组，会导致云效 jsonMLToValue 崩，生成: {value_str}"
        );
        // 必须存在合法形态：`"text"},["span",{"data-type":"leaf"},"文本"]`
        assert!(
            value_str.contains("\"data-type\":\"text\"},[\"span\",{\"data-type\":\"leaf\"}"),
            "应为合法嵌套（text.children 直接是 leaf），生成: {value_str}"
        );
    }

    #[test]
    fn markdown_to_rich_text_strips_inline_markdown() {
        // 评论只支持纯文本 leaf，因此绝不能把 `**`、`#`、反引号、`|` 等 Markdown 原样带进 jsonMLValue。
        let md = concat!(
            "# 标题\n",
            "这是**加粗**和`行内代码`。\n",
            "| 表头 | 表头2 |\n",
            "| 甲 | 乙 |\n",
            "[链接文字](https://example.com)\n",
            "- 列表项\n",
        );
        let value = assert_valid_rich_text(md);
        let jsonml = value.get("jsonMLValue").unwrap().to_string();
        // 不得残留 Markdown 符号
        assert!(!jsonml.contains("**"), "不应残留 **，jsonMLValue: {jsonml}");
        assert!(!jsonml.contains("\"#\""), "不应残留 #，jsonMLValue: {jsonml}");
        assert!(!jsonml.contains('`'), "不应残留反引号，jsonMLValue: {jsonml}");
        assert!(!jsonml.contains('|'), "不应残留竖线，jsonMLValue: {jsonml}");
        // 链接还原为文字、URL 被去掉
        assert!(jsonml.contains("链接文字"));
        assert!(jsonml.contains("加粗"));
        assert!(jsonml.contains("行内代码"));
    }
    #[test]
    fn markdown_to_rich_text_strips_html_tags_and_checkboxes() {
        let md = "- [x] 已完成**任务**：<u>下划线</u>与`代码`\n- [ ] 待办\n![示例图片](https://example.com/a.png)\n普通 <del>删除</del> 文字";
        let value = assert_valid_rich_text(md);
        let jsonml = value.get("jsonMLValue").unwrap().to_string();
        assert!(!jsonml.contains("<u>"), "不应残留 <u> 标签: {jsonml}");
        assert!(!jsonml.contains("<del>"), "不应残留 <del> 标签: {jsonml}");
        assert!(!jsonml.contains("[x]"), "不应残留 [x]: {jsonml}");
        assert!(!jsonml.contains("!["), "不应残留 ![ 图片语法: {jsonml}");
        assert!(!jsonml.contains("**"), "不应残留 **: {jsonml}");
        assert!(jsonml.contains("下划线"), "应保留下划线文字: {jsonml}");
        assert!(jsonml.contains("已完成任务"), "应保留任务文字: {jsonml}");
    }


    #[test]
    fn backfill_description_converts_to_rich_text_json() {
        // build_backfill_description 产出 Markdown；发送前需经 markdown_to_yunxiao_rich_text 转成
        // 云效可渲染的富文本 JSON 字符串，否则 `## 标题` 会被当纯文本显示。
        let request = BackfillIssueRequest {
            category: "Bug".to_string(),
            subject: "医保主表合同单位回写不匹配".to_string(),
            content_sections: vec![
                BackfillContentSection { label: "缺陷描述".to_string(), text: "合同单位回写后主表不匹配。".to_string() },
                BackfillContentSection { label: "发生频率".to_string(), text: "必现".to_string() },
            ],
            custom_fields: vec![],
            source_note: Some("来源议题：QHDK-29728".to_string()),
        };
        let md = build_backfill_description(&request);
        assert!(md.contains("## 缺陷描述"), "build 应产出 Markdown: {md}");
        let desc = markdown_to_yunxiao_rich_text(&md);
        let value: serde_json::Value = serde_json::from_str(&desc).expect("应为合法 JSON 字符串");
        let jsonml = value.get("jsonMLValue").and_then(|v| v.as_array()).expect("有 jsonMLValue");
        assert!(!jsonml.is_empty(), "jsonMLValue 不能为空");
        let s = value.to_string();
        assert!(!s.contains("\"data-type\":\"text\"},[["), "description jsonML 不得嵌套数组: {s}");
        assert!(s.contains("\"h3\""), "标题应映射为 h3: {s}");
    }

}
