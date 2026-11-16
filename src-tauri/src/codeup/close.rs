//! CloseChangeRequest: no branch deletion or local checkout cleanup.
use super::{build_client, change_item_url, load_creds, read_json_body};

fn close_url(org: &str, repository_id: &str, mr_id: &str) -> Result<String, String> {
    if org.is_empty()
        || !org
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("云效组织 ID 无效，请检查应用设置".into());
    }
    for (label, value) in [("仓库 ID", repository_id), ("合并请求局部编号", mr_id)] {
        if !value.bytes().all(|c| c.is_ascii_digit())
            || value.parse::<u64>().map_or(true, |n| n == 0)
        {
            return Err(format!("{label}必须为正整数"));
        }
    }
    Ok(format!(
        "{}/close",
        change_item_url(org, repository_id, mr_id)
    ))
}

fn check_close_response(bytes: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("无法确认关闭结果，请刷新列表核对状态: {e}"))?;
    if value.get("result").and_then(|v| v.as_bool()) != Some(true) {
        return Err("云效未确认关闭成功，请刷新列表核对状态后重试".into());
    }
    Ok(())
}

/// Official: POST .../repositories/{repositoryId}/changeRequests/{localId}/close.
/// https://help.aliyun.com/zh/yunxiao/developer-reference/closechangerequest-close-merge-request
#[tauri::command]
pub async fn codeup_close_mr(repository_id: String, mr_id: String) -> Result<(), String> {
    // Settings I/O already uses spawn_blocking; HTTP stays asynchronous with the
    // shared client's 20s timeout and redirect prohibition. No automatic POST retry.
    tokio::spawn(async move {
        let (token, org) = load_creds().await?;
        let url = close_url(&org, &repository_id, &mr_id)?;
        let client = build_client()?;
        let response = client
            .post(url)
            .header("x-yunxiao-token", token)
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| format!("关闭请求未获确认，请刷新核对状态: {e}"))?;
        let bytes = read_json_body(response).await?;
        check_close_response(&bytes)
    })
    .await
    .map_err(|e| format!("关闭合并请求任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn close_uses_repository_and_local_number() {
        assert_eq!(close_url("org1", "123", "42").unwrap(),
            "https://openapi-rdc.aliyuncs.com/oapi/v1/codeup/organizations/org1/repositories/123/changeRequests/42/close");
        for invalid in ["", "0", "-1", "1/close", "../1", "1?x=y", "mr-biz-id"] {
            assert!(close_url("org1", "123", invalid).is_err());
            assert!(close_url("org1", invalid, "42").is_err());
        }
        assert!(close_url("", "123", "42").is_err());
        assert!(close_url("org/other", "123", "42").is_err());
    }
    #[test]
    fn close_requires_explicit_success() {
        assert!(check_close_response(br#"{"result":true}"#).is_ok());
        for body in [
            br#"{"result":false}"#.as_slice(),
            b"{}",
            b"null",
            b"true",
            b"",
            br#"{"result":"true"}"#,
        ] {
            assert!(check_close_response(body).is_err());
        }
    }
}
