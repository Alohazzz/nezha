use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::app_settings::load_settings_internal;
use crate::TaskManager;

/// 同一任务同一类别两次系统通知之间的最小间隔，防止 ask 模式审批循环刷屏。
const COOLDOWN_SECS: u64 = 10;

/// 通知类别（冷却按「任务 × 类别」计数）。
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum NotifyCategory {
    /// input_required / awaiting_review —— Agent 需要用户确认。
    Confirm,
    /// done —— 任务完成。
    Complete,
    /// failed —— 任务失败（附失败原因）。
    Failed,
}

static COOLDOWN: OnceLock<Mutex<HashMap<(String, NotifyCategory), Instant>>> = OnceLock::new();

fn cooldown_map() -> &'static Mutex<HashMap<(String, NotifyCategory), Instant>> {
    COOLDOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 命中冷却返回 true 并**不**更新时间戳；未命中则记录本次时间戳并返回 false。
fn check_and_mark(task_id: &str, category: NotifyCategory) -> bool {
    let now = Instant::now();
    let mut map = cooldown_map().lock();
    let key = (task_id.to_string(), category);
    if let Some(last) = map.get(&key) {
        if now.duration_since(*last) < Duration::from_secs(COOLDOWN_SECS) {
            return true;
        }
    }
    map.insert(key, now);
    false
}

fn is_window_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

fn task_name(app: &AppHandle, task_id: &str) -> String {
    app.state::<TaskManager>()
        .task_names
        .lock()
        .get(task_id)
        .cloned()
        .unwrap_or_default()
}

/// 按设置/聚焦/冷却三层过滤后发送 OS 系统通知；任何一步失败都静默，
/// 不阻塞任务状态机（通知是尽力而为的附加行为）。
pub fn notify_task_event(
    app: &AppHandle,
    task_id: &str,
    category: NotifyCategory,
    detail: Option<&str>,
) {
    // 1. 总开关（~/.nezha/settings.json，后端可读）。
    if !load_settings_internal().system_notifications {
        return;
    }
    // 2. 窗口聚焦时不打扰（应用内角标足够）；聚焦期间的触发不消耗冷却，
    //    切走后第一次真实触发仍能通知。
    if is_window_focused(app) {
        return;
    }
    // 3. 60s 冷却：同任务同类别去重，冷却后恢复。
    if check_and_mark(task_id, category) {
        return;
    }

    let name = task_name(app, task_id);
    let subject = if name.is_empty() { task_id } else { name.as_str() };
    let body = match category {
        NotifyCategory::Confirm => format!("任务《{subject}》需要你的确认"),
        NotifyCategory::Complete => format!("任务《{subject}》已完成"),
        NotifyCategory::Failed => {
            let reason = detail.unwrap_or("").trim();
            if reason.is_empty() {
                format!("任务《{subject}》执行失败")
            } else {
                format!("任务《{subject}》执行失败：{reason}")
            }
        }
    };

    // macOS 首次使用需请求通知权限（幂等，已授权/已拒绝后直接返回现状）。
    #[cfg(target_os = "macos")]
    {
        let _ = app.notification().permission().request();
    }
    // 显式指定默认通知音：Windows 下映射为 ms-winsoundevent:Notification.Default，
    // 避免依赖系统/应用默认行为（部分场景 toast 无声音）。
    let _ = app
        .notification()
        .builder()
        .title("Nezha")
        .body(body)
        .sound("Default")
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_blocks_immediate_retry_and_recovers() {
        assert!(!check_and_mark("t-1", NotifyCategory::Confirm));
        assert!(check_and_mark("t-1", NotifyCategory::Confirm));
        // 不同类别互不影响。
        assert!(!check_and_mark("t-1", NotifyCategory::Complete));
        // 不同任务互不影响。
        assert!(!check_and_mark("t-2", NotifyCategory::Confirm));
        // 冷却窗口直接缩短为 0（测试专用路径：手动改表里的时间戳）。
        cooldown_map()
            .lock()
            .insert(
                ("t-1".to_string(), NotifyCategory::Confirm),
                Instant::now() - Duration::from_secs(COOLDOWN_SECS + 1),
            );
        assert!(!check_and_mark("t-1", NotifyCategory::Confirm));
    }
}
