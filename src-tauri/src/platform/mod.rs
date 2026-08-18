use std::path::PathBuf;

#[cfg(not(windows))]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use self::unix as imp;
#[cfg(windows)]
use self::windows as imp;

pub(crate) struct ShellCommand {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    imp::home_dir()
}

pub(crate) fn login_shell_env() -> &'static [(String, String)] {
    imp::login_shell_env()
}

pub(crate) fn login_shell_path() -> &'static str {
    imp::login_shell_path()
}

pub(crate) fn default_shell_command() -> ShellCommand {
    imp::default_shell_command()
}

pub(crate) fn detect_path(binary: &str) -> String {
    imp::detect_path(binary)
}

/// Windows:后台线程预加载随包侧载的新版 ConPTY(其余平台无此概念,无对应实现)。
#[cfg(windows)]
pub(crate) fn spawn_conpty_preload(resource_dir: PathBuf) {
    imp::spawn_conpty_preload(resource_dir);
}

/// 首次 openpty 前的屏障:等待侧载 ConPTY 预加载完成(非 Windows 为 no-op)。
pub(crate) fn wait_conpty_preload() {
    #[cfg(windows)]
    imp::wait_conpty_preload();
}
