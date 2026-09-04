use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::TaskManager;

// ── Remotes & guards ─────────────────────────────────────────────────────────

// 发布物源与仓库保持一致（git remote / Cargo.toml / notifications feed 都在 Alohazzz/nezha）。
const RELEASE_URL: &str = "https://api.github.com/repos/Alohazzz/nezha/releases/latest";
const DOWNLOAD_PREFIX: &str = "https://github.com/Alohazzz/nezha/releases/download/";
const API_HOST: &str = "api.github.com";
const REQUEST_TIMEOUT_SECS: u64 = 15;
const DOWNLOAD_TIMEOUT_SECS: u64 = 600;
const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024; // 安装包大小上限
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// ── GitHub API types ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize, Clone)]
struct GhAsset {
    name: String,
    size: u64,
    #[serde(default)]
    digest: Option<String>,
    browser_download_url: String,
}

// ── Frontend-facing types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub name: String,
    pub size: u64,
    pub digest: Option<String>,
    pub url: String,
    /// 是否可安全自动安装（Windows + 匹配架构 + 带 sha256 digest）。
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub tag: String,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub current_version: String,
    /// 当前平台是否走自动升级完整闭环（仅 Windows）。
    pub supported: bool,
    /// 当前平台匹配到的安装包资产；非 Windows 或未匹配时为 None。
    pub asset: Option<UpdateAsset>,
}

// ── Version helpers ──────────────────────────────────────────────────────────

fn parse_version(s: &str) -> Vec<u64> {
    s.trim_start_matches('v')
        .split(|c: char| c == '.' || c == '-' || c == '+')
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let va = parse_version(a);
    let vb = parse_version(b);
    for i in 0..3 {
        match va.get(i).copied().unwrap_or(0).cmp(&vb.get(i).copied().unwrap_or(0)) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// 只允许纯文件名字符，杜绝从 URL / 远端注入目录穿越。
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_' || *c == ' ')
        .collect()
}

// ── Asset selection ──────────────────────────────────────────────────────────

/// 根据当前 OS + 架构挑选 Windows 安装器（NSIS -setup.exe）。
/// 目前仅 Windows 支持自动升级；其他平台返回 None（前端降级为跳转 releases 页）。
fn select_windows_asset(assets: &[GhAsset]) -> Option<GhAsset> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let suffix = match std::env::consts::ARCH {
        "aarch64" => "_arm64-setup.exe",
        _ => "_x64-setup.exe",
    };
    assets.iter().find(|a| a.name.ends_with(suffix)).cloned()
}

/// 判断 URL 是否落在 GitHub 官方域名内（含资产 CDN）。
/// 允许 `github.com`、`*.github.com`、`githubusercontent.com`、`*.githubusercontent.com`，
/// 用于替代“只能停留在下载前缀/API 前缀”的字符串判断，避免重定向到第三方域名
/// 造成域名绕过，同时兼容 GitHub 下载实际跳往的 `release-assets.githubusercontent.com`。
fn is_trusted_github_url(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some(host) => {
            host == "github.com"
                || host == "githubusercontent.com"
                || host.ends_with(".github.com")
                || host.ends_with(".githubusercontent.com")
        }
        None => false,
    }
}

/// 判断 `child` 是否位于 `parent` 目录内。
/// Windows 下 `fs::canonicalize()` 会返回带 `\\?\` 前缀的 verbatim path，
/// 直接与普通路径做 `starts_with` 会失败；这里统一去掉该前缀，并在 Windows 上
/// 做大小写不敏感的组件级前缀比较（同时兼容通过 junction/symlink 解析后的真实路径）。
fn path_is_within(parent: &Path, child: &Path) -> bool {
    fn strip_verbatim(p: &Path) -> PathBuf {
        let s = p.to_string_lossy();
        s.strip_prefix(r"\\?\")
            .map(PathBuf::from)
            .unwrap_or_else(|| p.to_path_buf())
    }
    let parent = strip_verbatim(parent);
    let child = strip_verbatim(child);
    let parent_parts: Vec<String> = parent
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let child_parts: Vec<String> = child
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if child_parts.len() < parent_parts.len() {
        return false;
    }
    parent_parts
        .iter()
        .zip(child_parts.iter())
        .all(|(p, c)| {
            if cfg!(target_os = "windows") {
                p.eq_ignore_ascii_case(c)
            } else {
                p == c
            }
        })
}

fn build_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    crate::http::add_system_proxy(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            // 仅跟随 GitHub 官方域名内的重定向；跳转到第三方域名即停止，
            // 配合下方 resp.url() 域名校验，避免通过重定向绕过校验/伪造。
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if is_trusted_github_url(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .user_agent(format!("Nezha-Update/{APP_VERSION}")),
    )
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// 检查是否有更新的正式版本。返回 None 表示已是最新。
/// success + latest tag 仅在「latest > 当前版本」时返回 Some。
#[tauri::command]
pub async fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    let client = build_http_client(REQUEST_TIMEOUT_SECS)?;
    let resp = client
        .get(RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {e}"))?;

    // 校验响应域名，防重定向/伪造。
    if !is_trusted_github_url(resp.url()) {
        return Err(format!("Unexpected response URL: {}", resp.url()));
    }
    if resp.status().is_redirection() {
        return Err(format!(
            "Update check was redirected (HTTP {}), likely caused by a proxy rerouting the GitHub API. Please allow {API_HOST} through your proxy.",
            resp.status()
        ));
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let release: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("Invalid JSON: {e}"))?;

    // 仅当最新版严格大于当前版本时才提示；否则视为已最新。
    if compare_versions(&release.tag_name, APP_VERSION) != std::cmp::Ordering::Greater {
        return Ok(None);
    }

    let asset = select_windows_asset(&release.assets);
    let supported_windows = cfg!(target_os = "windows");
    let asset = asset.map(|a| UpdateAsset {
        name: a.name,
        size: a.size,
        digest: a.digest.clone(),
        url: a.browser_download_url,
        supported: a.digest.is_some(),
    });

    Ok(Some(UpdateInfo {
        version: release.tag_name.trim_start_matches('v').to_string(),
        tag: release.tag_name,
        body: release.body,
        published_at: release.published_at,
        current_version: APP_VERSION.to_string(),
        supported: supported_windows && asset.as_ref().map_or(false, |a| a.supported),
        asset,
    }))
}

/// 下载指定安装包到应用缓存目录，流式写文件并逐步回传进度（0..1）。
/// 下载完成后用 GitHub asset 的 sha256 digest 校验，校验失败删除文件并报错。
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    url: String,
    digest: Option<String>,
    filename: String,
    on_progress: Channel<f64>,
) -> Result<String, String> {
    if !url.starts_with(DOWNLOAD_PREFIX) {
        return Err("Invalid download URL".into());
    }
    let filename = sanitize_filename(&filename);
    if filename.is_empty() {
        return Err("Invalid filename".into());
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| e.to_string())?;
    let install_path = cache_dir.join(format!("nezha-update-{filename}"));

    let client = build_http_client(DOWNLOAD_TIMEOUT_SECS)?;
    let resp = client
        .get(&url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !is_trusted_github_url(resp.url()) {
        return Err("Unexpected download URL".into());
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err("Installer exceeds size limit".into());
    }

    use futures_util::StreamExt;
    let mut file = tokio::fs::File::create(&install_path)
        .await
        .map_err(|e| format!("Create file failed: {e}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download failed: {e}"))?;
        if downloaded + chunk.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err("Installer exceeds size limit".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write failed: {e}"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if total > 0 {
            let _ = on_progress.send(downloaded as f64 / total as f64);
        }
    }
    file.flush().await.map_err(|e| format!("Flush failed: {e}"))?;
    drop(file);

    let actual = hex::encode(hasher.finalize());
    if let Some(expected) = digest {
        let expected = expected.trim().to_lowercase();
        let expected = expected.strip_prefix("sha256:").unwrap_or(&expected).to_string();
        if actual != expected {
            let _ = tokio::fs::remove_file(&install_path).await;
            return Err(format!("Checksum mismatch: expected {expected}, got {actual}"));
        }
    }

    Ok(install_path.to_string_lossy().into_owned())
}

/// 拉起已下载并校验通过的安装器。
/// 若存在运行中的任务且未传 force=true，则返回错误让前端先弹确认；
/// 确认后先终止所有子进程（与托盘退出同路径，避免孤儿），再启动安装器并退出应用。
#[tauri::command]
pub async fn launch_update_installer(
    task_manager: tauri::State<'_, TaskManager>,
    app: tauri::AppHandle,
    installer_path: String,
    force: bool,
) -> Result<(), String> {
    let active: Vec<String> = task_manager.child_handles.lock().keys().cloned().collect();
    if !active.is_empty() && !force {
        return Err(format!("Active tasks: {}", active.len()));
    }

    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let install = PathBuf::from(&installer_path);
    let canonical_cache = cache_dir
        .canonicalize()
        .unwrap_or_else(|_| cache_dir.clone());
    let canonical_install = install
        .canonicalize()
        .map_err(|_| "Installer not found".to_string())?;
    if !path_is_within(&canonical_cache, &canonical_install) {
        return Err("Installer path outside cache directory".into());
    }
    if canonical_install.extension().and_then(|e| e.to_str()) != Some("exe") {
        return Err("Only .exe installers are supported".into());
    }

    // 终止正在运行的 agent/shell 子进程，避免升级后留孤儿。仅 Windows。
    #[cfg(target_os = "windows")]
    task_manager.kill_all_children();

    // 防止并发/重复触发导致安装器被拉起两次（app.exit 前存在短暂窗口期）。
    use std::sync::atomic::{AtomicBool, Ordering};
    static INSTALLER_SPAWNING: AtomicBool = AtomicBool::new(false);
    if INSTALLER_SPAWNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    // 进程创建是阻塞操作，放进 spawn_blocking 避免阻塞 async runtime。
    let spawned = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&canonical_install).spawn()
    })
    .await;
    match spawned {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            INSTALLER_SPAWNING.store(false, Ordering::SeqCst);
            return Err(format!("Failed to launch installer: {e}"));
        }
        Err(e) => {
            INSTALLER_SPAWNING.store(false, Ordering::SeqCst);
            return Err(format!("Spawn task failed: {e}"));
        }
    }

    app.exit(0);
    Ok(())
}

/// 推送「发现新版本」的系统通知（仅 Windows）。点击通知 → 唤起窗口 + 打开升级弹窗。
/// 窗口在前台时不再发系统通知（App 内横幅已足够），避免打扰。
#[tauri::command]
pub async fn notify_update_available(app: tauri::AppHandle, version: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let focused = app
            .get_webview_window("main")
            .map(|w| w.is_focused().unwrap_or(false))
            .unwrap_or(false);
        if focused {
            return Ok(());
        }

        use tauri_winrt_notification::{Sound, Toast};
        let handle = app.clone();
        let title_text = format!("Nezha v{version} available");
        let toast = Toast::new(Toast::POWERSHELL_APP_ID)
            .title(&title_text)
            .text1("点击即可下载并升级")
            .sound(Some(Sound::Default))
            .on_activated(move |_| {
                crate::show_main_window(&handle);
                let _ = handle.emit("open_update_dialog", ());
                Ok(())
            });
        let _ = toast.show();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, version);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_versions_respects_v_prefix_and_patch() {
        assert_eq!(compare_versions("v0.8.2", "0.8.3"), std::cmp::Ordering::Less);
        assert_eq!(compare_versions("0.8.3", "0.8.3"), std::cmp::Ordering::Equal);
        assert_eq!(compare_versions("0.8.4", "0.8.3"), std::cmp::Ordering::Greater);
        assert_eq!(compare_versions("v0.9.0", "0.8.10"), std::cmp::Ordering::Greater);
    }

    #[test]
    fn sanitize_filename_strips_path_separators() {
        assert_eq!(
            sanitize_filename("NeZha_0.8.3_x64-setup.exe"),
            "NeZha_0.8.3_x64-setup.exe"
        );
        // 路径分隔符被剔除；仅剩的点号只是普通文件名，不会构成目录穿越。
        assert_eq!(sanitize_filename("../../evil.exe"), "....evil.exe");
        assert_eq!(sanitize_filename("a/b\\c"), "abc");
    }

    #[test]
    fn parse_version_strips_prefix_and_suffix() {
        let v = parse_version("v1.2.3-beta.1");
        // 比较只取前三个数值段；后缀段归一为 0，不影响大小比较。
        assert_eq!(&v[..3], &[1, 2, 3]);
    }
}
