//! HTTP 客户端共用工具：读取 Windows 系统代理并应用到 reqwest 客户端。
//!
//! 背景：reqwest 默认只认 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，不会自动读取
//! Windows「设置 → 网络和 Internet → 代理」里配置的系统代理。而本项目的离线
//! vendor（`.dsh-offline/vendor`）没有 reqwest `system-proxy` 特性所需的
//! macOS 依赖（`system-configuration`），无法直接启用该特性。因此这里用已有
//! 的 `winreg` 读注册表拿到系统代理，再显式应用到客户端。

use reqwest::ClientBuilder;

/// 读取 Windows 系统代理。
/// 返回形如 `http://127.0.0.1:7890` 的代理 URL；未启用或非 Windows 时返回 `None`。
#[cfg(target_os = "windows")]
pub(crate) fn system_proxy_url() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    if server.trim().is_empty() {
        return None;
    }

    // ProxyServer 可能是 "host:port"，也可能是 "http=h:p;https=h:p"（分协议）。
    let host_port = server
        .split(';')
        .map(str::trim)
        .find_map(|part| {
            if let Some((scheme, addr)) = part.split_once('=') {
                if scheme.eq_ignore_ascii_case("http")
                    || scheme.eq_ignore_ascii_case("https")
                    || scheme.eq_ignore_ascii_case("all")
                {
                    let addr = addr.trim();
                    return if addr.is_empty() { None } else { Some(addr) };
                }
                None
            } else if !part.is_empty() {
                Some(part)
            } else {
                None
            }
        })?;

    if host_port.is_empty() {
        return None;
    }
    if host_port.contains("://") {
        Some(host_port.to_string())
    } else {
        Some(format!("http://{host_port}"))
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn system_proxy_url() -> Option<String> {
    None
}

/// 若系统代理已启用，则给 builder 应用该代理；否则原样返回。
pub(crate) fn add_system_proxy(builder: ClientBuilder) -> ClientBuilder {
    match system_proxy_url() {
        Some(url) => match reqwest::Proxy::all(&url) {
            Ok(proxy) => builder.proxy(proxy),
            Err(_) => builder,
        },
        None => builder,
    }
}
