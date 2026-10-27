//! 任务附件（图片 dataUrl）落盘：PTY 与 codex structured 两条链路共享。
//!
//! 图片以 data URL 从前端传来，解码后按序号写入
//! `<project>/.nezha/attachments/<taskId>/`；任务收尾由
//! `pty.rs::cleanup_task_attachments` 统一清目录（两条链路同目录同清理时点）。
//! 同步文件 I/O —— 调用方必须包 `tokio::task::spawn_blocking`（AGENTS.md）。

use std::fs;
use std::path::Path;

/// 任务附件目录：`<project>/.nezha/attachments/<taskId>/`。
pub fn task_attachments_dir(project_path: &str, task_id: &str) -> std::path::PathBuf {
    Path::new(project_path)
        .join(".nezha")
        .join("attachments")
        .join(task_id)
}

/// 批量落盘图片 dataUrl，按传入顺序编号命名，返回绝对路径（与传入顺序一致）。
pub fn save_task_images(
    project_path: &str,
    task_id: &str,
    images: &[String],
) -> Result<Vec<String>, String> {
    if images.is_empty() {
        return Ok(vec![]);
    }
    let attachments_dir = task_attachments_dir(project_path, task_id);
    fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for (i, data_url) in images.iter().enumerate() {
        let (data, ext) = decode_image_data_url(data_url)?;
        let filename = format!("{}.{}", i, ext);
        let file_path = attachments_dir.join(&filename);
        fs::write(&file_path, &data).map_err(|e| e.to_string())?;
        paths.push(file_path.to_string_lossy().into_owned());
    }
    Ok(paths)
}

/// 解析 "data:image/png;base64,<data>" 格式，返回解码后的字节与扩展名。
pub(crate) fn decode_image_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let comma = data_url.find(',').ok_or("invalid image data URL")?;
    let header = &data_url[..comma];
    let b64 = &data_url[comma + 1..];
    let ext = if header.contains("jpeg") || header.contains("jpg") {
        "jpg"
    } else if header.contains("gif") {
        "gif"
    } else if header.contains("webp") {
        "webp"
    } else {
        "png"
    };
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    Ok((data, ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1x1 红色 PNG 的 dataUrl（标准测试图,base64 固定）。
    const RED_PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn decode_png_data_url() {
        let (data, ext) = decode_image_data_url(RED_PNG_DATA_URL).expect("decode");
        assert_eq!(ext, "png");
        assert_eq!(&data[..4], &[0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn decode_rejects_missing_comma() {
        assert!(decode_image_data_url("data:image/png;base64XXX").is_err());
    }

    #[test]
    fn save_images_empty_returns_no_paths() {
        let dir = std::env::temp_dir().join(format!("nezha-att-empty-{}", std::process::id()));
        let paths = save_task_images(dir.to_str().unwrap(), "t0", &[]).expect("save");
        assert!(paths.is_empty());
        assert!(!dir.join("t0").exists(), "empty input must not create dir");
    }

    #[test]
    fn save_images_writes_numbered_files_in_order() {
        let base = std::env::temp_dir().join(format!("nezha-att-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let paths =
            save_task_images(base.to_str().unwrap(), "t1", &[RED_PNG_DATA_URL.to_string()]).expect("save");
        assert_eq!(paths.len(), 1);
        let p = Path::new(&paths[0]);
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "0.png");
        assert!(p.exists());
        // 任务附件目录结构:attachments/<taskId>/0.png(逐级比对,避开 Windows
        // temp 路径前缀差异)
        let parent = p.parent().unwrap();
        assert_eq!(parent.file_name().unwrap().to_str().unwrap(), "t1");
        assert_eq!(parent.parent().unwrap().file_name().unwrap(), "attachments");
        let _ = fs::remove_dir_all(&base);
    }
}
