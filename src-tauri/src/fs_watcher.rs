//! 文件树的文件系统事件监听,替代前端固定间隔轮询。
//!
//! 工作机制:
//! - 前端把「项目根 + 当前可见的已展开目录」注册进来(`watch_dir` / `unwatch_dir`),
//!   每个目录一个**非递归** watch。绝不对项目根做递归 watch:Linux 的 inotify
//!   递归模式会给 node_modules 里数万个子目录各挂一个 watch,直接撞
//!   `max_user_watches` 上限(VS Code 需要 files.watcherExclude 正是这个原因)。
//!   非递归按展开目录挂 watch 与文件树的懒加载天然对齐:折叠后重新展开时
//!   前端本来就会整层重新拉取,不依赖折叠期间的事件。
//! - notify 事件按「所属被监听目录」归并,防抖窗口(DEBOUNCE)内合并成一批,
//!   再逐目录 emit `fs-changed { dir }`;npm install / 构建这类事件风暴被压成
//!   每目录每窗口最多一次刷新。
//! - watcher 初始化失败(平台不支持等)时 `watch_dir` 返回 false,
//!   前端据此回退到旧的固定间隔轮询,防御纵深不减。
//!
//! 路径口径:watch 的 key 用前端传来的原始路径字符串(仅校验在项目内,不做
//! canonicalize),emit 时原样带回,保证前端能与 TreeNode.path 精确对得上。
//! 项目路径中含符号链接时 FSEvents 可能回报解析后的真实路径导致匹配不上——
//! 此时该目录收不到事件,由前端保留的手动刷新 / focus 刷新兜底。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::Watcher;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// 防抖窗口:窗口内同一目录的多次变更合并为一次 `fs-changed`。
/// 固定窗口而非「静默才发」——持续写入(长构建)时也能以此频率持续送达,不会饿死。
const DEBOUNCE: Duration = Duration::from_millis(200);

pub struct FsWatcherState {
    watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    /// 目录 -> 引用计数(多个项目/多个 FileExplorer 实例可能 watch 同一目录)。
    watched: Arc<Mutex<HashMap<PathBuf, usize>>>,
}

/// 在 Tauri setup 阶段调用:创建 watcher、注册托管状态、启动防抖 emit 线程。
pub fn init(app: &tauri::App) {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let watched: Arc<Mutex<HashMap<PathBuf, usize>>> = Arc::new(Mutex::new(HashMap::new()));

    let handler_watched = watched.clone();
    // notify 的回调跑在 watcher 自己的线程上;这里只做 watched 集合查询 + 投递,
    // 不做 I/O,不碰 watcher 自身的锁,不会与 watch_dir/unwatch_dir 死锁。
    let watcher = notify::RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let watched = handler_watched.lock();
            for path in &event.paths {
                // 非递归 watch 的事件路径要么是被监听目录的直接子项,要么是目录自身。
                let mut dirty = HashSet::new();
                if watched.contains_key(path.as_path()) {
                    dirty.insert(path.clone());
                }
                if let Some(parent) = path.parent() {
                    if watched.contains_key(parent) {
                        dirty.insert(parent.to_path_buf());
                    }
                }
                for dir in dirty {
                    let _ = tx.send(dir);
                }
            }
        },
        notify::Config::default(),
    )
    .ok();

    app.manage(FsWatcherState {
        watcher: Arc::new(Mutex::new(watcher)),
        watched,
    });

    let handle = app.handle().clone();
    std::thread::spawn(move || run_debounce_loop(handle, rx));
}

fn run_debounce_loop(app: AppHandle, rx: mpsc::Receiver<PathBuf>) {
    loop {
        // 空闲时阻塞等第一条,零唤醒;sender 全部销毁(仅进程退出)时结束线程。
        let Ok(first) = rx.recv() else { return };
        let mut dirty: HashSet<PathBuf> = HashSet::new();
        dirty.insert(first);

        let deadline = Instant::now() + DEBOUNCE;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok(path) => {
                    dirty.insert(path);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        for dir in dirty {
            let _ = app.emit(
                "fs-changed",
                serde_json::json!({ "dir": dir.to_string_lossy() }),
            );
        }
    }
}

/// 开始监听一个目录(非递归)。返回 false 表示 watcher 不可用,
/// 前端应回退到固定间隔轮询。
#[tauri::command]
pub async fn watch_dir(
    path: String,
    project_path: String,
    state: tauri::State<'_, FsWatcherState>,
) -> Result<bool, String> {
    let watcher = state.watcher.clone();
    let watched = state.watched.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::fs::validate_path_within(&path, &project_path, true)?;
        let key = PathBuf::from(&path);

        // watcher 初始化失败(启动时确定,之后不变)则所有注册都返回 false,
        // 必须在加引用计数之前判断——否则第二个注册者会拿到 count>1 的 true,
        // 误以为 watch 生效而不启用轮询兜底。
        if watcher.lock().is_none() {
            return Ok(false);
        }

        // 先占引用计数,再在锁外考虑真正挂 watch;同目录并发重复注册只会加计数。
        {
            let mut map = watched.lock();
            let count = map.entry(key.clone()).or_insert(0);
            *count += 1;
            if *count > 1 {
                return Ok(true);
            }
        }

        let mut guard = watcher.lock();
        let Some(w) = guard.as_mut() else {
            return Ok(false);
        };
        // watch() 是一次快速 syscall(inotify_add_watch / FSEvents 流更新),
        // 已经在 spawn_blocking 里,短暂持锁可接受。
        if w.watch(&key, notify::RecursiveMode::NonRecursive).is_err() {
            // 挂载失败(目录刚被删等):回收计数,让前端走轮询兜底。
            drop(guard);
            release_watch_count(&watched, &key);
            return Ok(false);
        }
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 停止监听一个目录(引用计数归零时才真正摘除)。
#[tauri::command]
pub async fn unwatch_dir(
    path: String,
    state: tauri::State<'_, FsWatcherState>,
) -> Result<(), String> {
    let watcher = state.watcher.clone();
    let watched = state.watched.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = PathBuf::from(&path);
        if !release_watch_count(&watched, &key) {
            return Ok(());
        }
        let mut guard = watcher.lock();
        if let Some(w) = guard.as_mut() {
            // 目录已被删除时 unwatch 返回错误(内核已自动摘除),忽略即可。
            let _ = w.unwatch(&key);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 引用计数减一;返回 true 表示计数归零、调用方需要真正摘除 watch。
fn release_watch_count(watched: &Mutex<HashMap<PathBuf, usize>>, key: &PathBuf) -> bool {
    let mut map = watched.lock();
    let Some(count) = map.get_mut(key) else {
        return false;
    };
    *count -= 1;
    if *count == 0 {
        map.remove(key);
        return true;
    }
    false
}
