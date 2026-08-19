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
use std::time::Duration;

const API_BASE: &str = "https://openapi-rdc.aliyuncs.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
}
