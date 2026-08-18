use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::ShellCommand;

static LOGIN_SHELL_ENV: OnceLock<Vec<(String, String)>> = OnceLock::new();
static LOGIN_SHELL_PATH: OnceLock<String> = OnceLock::new();

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| match (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
            (Some(drive), Some(path)) => {
                let mut full = PathBuf::from(drive);
                full.push(PathBuf::from(path));
                Some(full)
            }
            _ => None,
        })
}

pub(crate) fn login_shell_env() -> &'static [(String, String)] {
    LOGIN_SHELL_ENV
        .get_or_init(|| {
            let mut env: Vec<(String, String)> = std::env::vars().collect();
            if !env.iter().any(|(key, _)| key.eq_ignore_ascii_case("HOME")) {
                if let Some(home) = home_dir() {
                    env.push(("HOME".to_string(), home.to_string_lossy().into_owned()));
                }
            }
            env
        })
        .as_slice()
}

pub(crate) fn login_shell_path() -> &'static str {
    LOGIN_SHELL_PATH.get_or_init(|| {
        login_shell_env()
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    })
}

pub(crate) fn default_shell_command() -> ShellCommand {
    if !detect_path("pwsh").is_empty() {
        return ShellCommand {
            program: "pwsh".to_string(),
            args: vec!["-NoLogo".to_string()],
        };
    }

    if !detect_path("powershell").is_empty() {
        return ShellCommand {
            program: "powershell".to_string(),
            args: vec!["-NoLogo".to_string()],
        };
    }

    ShellCommand {
        program: std::env::var("ComSpec")
            .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string()),
        args: Vec::new(),
    }
}

pub(crate) fn detect_path(binary: &str) -> String {
    if binary.contains('\\') || binary.contains('/') {
        let candidate = PathBuf::from(binary);
        return if candidate.exists() {
            candidate.to_string_lossy().into_owned()
        } else {
            String::new()
        };
    }

    let path_value = login_shell_path();
    if path_value.is_empty() {
        return String::new();
    }

    let has_extension = Path::new(binary).extension().is_some();
    find_on_path(binary, &path_value, has_extension).unwrap_or_default()
}

fn find_on_path(binary: &str, path_value: &str, has_extension: bool) -> Option<String> {
    let path_exts = if has_extension {
        vec![String::new()]
    } else {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| ext.to_string())
            .collect::<Vec<_>>()
    };

    for dir in path_value.split(';').filter(|segment| !segment.is_empty()) {
        if has_extension {
            let candidate = Path::new(dir).join(binary);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
            continue;
        }

        for ext in &path_exts {
            let candidate = Path::new(dir).join(format!("{binary}{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }

    None
}

// ---------- 侧载 ConPTY 预加载 ----------
//
// 部分 Windows build 的系统内置 ConPTY 不把全屏 TUI(Claude/Codex)的输出送入
// scrollback,表现为终端滚轮无法回滚。随包分发新版 conpty.dll + OpenConsole.exe
// 统一运行时行为(Windows Terminal / VS Code / wezterm 同款方案)。
//
// portable-pty 的 `load_conpty()` 原生支持侧载:创建 PTY 时优先
// `LoadLibrary("conpty.dll")`,命中则用侧载版,否则回退 kernel32。Windows loader
// 对裸基名加载会先复用进程内已加载的同名模块,因此这里在任何 PTY 创建之前用
// 完整路径预加载,即可让后续裸名加载命中随包版本。
//
// 预加载在 setup 里 spawn 到后台线程执行(读 settings + LoadLibrary + 拉起
// OpenConsole.exe 自检共 50-150ms,不能阻塞窗口首帧);pty.rs 在首次 openpty 前
// 通过 wait_conpty_preload() 屏障等待其完成,保证时序仍然是「预加载先于首个 PTY」。
//
// 回退层次(详见 resources/conpty/README.md):
// 1. 资源缺失 / LoadLibrary 失败 → 模块不入表,portable-pty 自动回退系统版;
// 2. 加载成功但导出缺失 / host 拉不起来 → 下方自检失败即 FreeLibrary 卸载,同样回退;
// 3. 预加载/自检挂死 → crash-loop 标记:下次启动检测到残留标记即跳过侧载,
//    最多损失一次「首个任务无法启动」的会话,不会被永久卡死;
// 4. 手动兜底 → 设置开关(use_sideloaded_conpty=false)跳过预加载,重启生效。

type WinHandle = *mut core::ffi::c_void;

#[repr(C)]
struct Coord {
    x: i16,
    y: i16,
}

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(lp_lib_file_name: *const u16, h_file: WinHandle, dw_flags: u32) -> WinHandle;
    fn FreeLibrary(h_lib_module: WinHandle) -> i32;
    fn GetProcAddress(h_module: WinHandle, lp_proc_name: *const u8) -> *mut core::ffi::c_void;
    fn CreatePipe(
        h_read_pipe: *mut WinHandle,
        h_write_pipe: *mut WinHandle,
        lp_pipe_attributes: *mut core::ffi::c_void,
        n_size: u32,
    ) -> i32;
    fn CloseHandle(h_object: WinHandle) -> i32;
    fn GetLastError() -> u32;
}

type CreatePseudoConsoleFn =
    unsafe extern "system" fn(Coord, WinHandle, WinHandle, u32, *mut WinHandle) -> i32;
type ClosePseudoConsoleFn = unsafe extern "system" fn(WinHandle);

// 与 portable-pty 0.8.1 实际调用完全一致的 flags(psuedocon.rs:86),
// 保证自检走的是与真实任务相同的 host 初始化路径。
const PSEUDOCONSOLE_RESIZE_QUIRK: u32 = 0x2;
const PSEUDOCONSOLE_WIN32_INPUT_MODE: u32 = 0x4;

/// 预加载线程句柄:setup 时 spawn,首次 openpty 前 join(见 wait_conpty_preload)。
static CONPTY_PRELOAD_THREAD: parking_lot::Mutex<Option<std::thread::JoinHandle<()>>> =
    parking_lot::Mutex::new(None);

/// 在后台线程执行侧载 ConPTY 预加载(读 settings、LoadLibrary、自检拉起
/// OpenConsole.exe 共 50-150ms,不能阻塞 setup/窗口首帧)。setup 时调用一次。
pub(crate) fn spawn_conpty_preload(resource_dir: PathBuf) {
    *CONPTY_PRELOAD_THREAD.lock() = Some(std::thread::spawn(move || {
        if !crate::app_settings::use_sideloaded_conpty_enabled() {
            eprintln!("[conpty] use_sideloaded_conpty=false,使用系统内置 ConPTY");
            return;
        }
        preload_sideloaded_conpty(&resource_dir);
    }));
}

/// 首次 openpty 前的一次性屏障:等待预加载线程完成。portable-pty 的 CONPTY 是
/// lazy_static,首次创建 PTY 后进程内无法再切换实现,所以必须先完成预加载。
/// join 期间故意持锁:并发到达的其他 openpty 调用同样需要等待;join 过一次后
/// 恒为 None,零成本直通。
pub(crate) fn wait_conpty_preload() {
    if let Some(handle) = CONPTY_PRELOAD_THREAD.lock().take() {
        let _ = handle.join();
    }
}

/// 预加载随包侧载的新版 ConPTY。必须先于任何 `openpty` 完成(由上方屏障保证)。
fn preload_sideloaded_conpty(resource_dir: &Path) {
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        return;
    };

    let dll_path = resource_dir
        .join("resources")
        .join("conpty")
        .join(arch)
        .join("conpty.dll");
    if !dll_path.is_file() {
        // 资源未随包分发(如 tauri dev):静默回退系统 ConPTY
        return;
    }
    // conpty.dll 从自身所在目录拉起 OpenConsole.exe 作为 host,两者必须成对存在
    let host_path = dll_path.with_file_name("OpenConsole.exe");
    if !host_path.is_file() {
        eprintln!(
            "[conpty] 侧载目录缺少 OpenConsole.exe({}),回退系统 ConPTY",
            host_path.display()
        );
        return;
    }

    // crash-loop 防护:预加载前落盘标记,正常返回(无论命中/回退)后删除;
    // 启动时残留标记与当前指纹一致则跳过侧载。指纹 = 应用版本 + dll 长度:
    // dll 只随应用版本更新,升级后指纹必变、自动重试一次;纯长度会在
    // 不同版本恰好等长时碰撞,导致修复版 dll 永远不被重试。
    let fingerprint = format!(
        "{}:{}",
        env!("CARGO_PKG_VERSION"),
        std::fs::metadata(&dll_path)
            .map(|m| m.len().to_string())
            .unwrap_or_default()
    );
    let marker = crate::app_settings::conpty_preload_marker_path();
    if let Some(path) = &marker {
        if let Ok(stale) = std::fs::read_to_string(path) {
            if stale == fingerprint {
                eprintln!(
                    "[conpty] 上次启动在 ConPTY 预加载阶段异常退出,本次跳过侧载,回退系统 ConPTY(切换设置开关或升级后自动重试)"
                );
                return;
            }
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // 写失败(如目录只读)只损失 crash-loop 防护,预加载本身照常;但要留痕,
        // 否则「反复挂死却无标记可查」会变成无线索问题。
        if let Err(err) = std::fs::write(path, &fingerprint) {
            eprintln!("[conpty] crash-loop 标记写入失败({err}),预加载挂死时将失去自动跳过保护");
        }
    }

    // LOAD_WITH_ALTERED_SEARCH_PATH:以 DLL 所在目录解析依赖;模块以基名进入
    // 进程模块表,portable-pty 后续 LoadLibrary("conpty.dll") 直接复用本模块。
    const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = dll_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let module = unsafe {
        LoadLibraryExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_WITH_ALTERED_SEARCH_PATH,
        )
    };
    if module.is_null() {
        eprintln!(
            "[conpty] 预加载侧载 conpty.dll 失败(GetLastError={}),回退系统 ConPTY",
            unsafe { GetLastError() }
        );
    } else {
        match unsafe { self_check(module) } {
            Ok(()) => {
                eprintln!("[conpty] 已启用侧载 ConPTY: {}", dll_path.display());
            }
            Err(reason) => {
                eprintln!("[conpty] 侧载 ConPTY 自检失败({reason}),回退系统 ConPTY");
                unsafe {
                    FreeLibrary(module);
                }
            }
        }
    }

    // 走到这里说明预加载/自检没有挂死,清除 crash-loop 标记
    if let Some(path) = &marker {
        let _ = std::fs::remove_file(path);
    }
}

/// 用侧载 DLL 真实创建并销毁一次 PseudoConsole(会拉起同目录的 OpenConsole.exe),
/// 拦截「加载成功但不可用」的场景(如老 build 缺依赖 API、host 起不来)。
unsafe fn self_check(module: WinHandle) -> Result<(), String> {
    let create = GetProcAddress(module, b"CreatePseudoConsole\0".as_ptr());
    let close = GetProcAddress(module, b"ClosePseudoConsole\0".as_ptr());
    // portable-pty 的 shared_library! 宏要求 Create/Resize/Close 三个导出齐全,
    // 任一缺失整库回退系统版——自检必须验同一符号集,否则会出现「日志称已启用
    // 侧载、实际 portable-pty 静默回退」的误导状态。Resize 只验导出不调用。
    let resize = GetProcAddress(module, b"ResizePseudoConsole\0".as_ptr());
    if create.is_null() || close.is_null() || resize.is_null() {
        return Err(
            "缺少 CreatePseudoConsole/ResizePseudoConsole/ClosePseudoConsole 导出".to_string(),
        );
    }
    let create: CreatePseudoConsoleFn = std::mem::transmute(create);
    let close: ClosePseudoConsoleFn = std::mem::transmute(close);

    let mut input_read: WinHandle = std::ptr::null_mut();
    let mut input_write: WinHandle = std::ptr::null_mut();
    if CreatePipe(&mut input_read, &mut input_write, std::ptr::null_mut(), 0) == 0 {
        return Err("CreatePipe(input) 失败".to_string());
    }
    let mut output_read: WinHandle = std::ptr::null_mut();
    let mut output_write: WinHandle = std::ptr::null_mut();
    if CreatePipe(&mut output_read, &mut output_write, std::ptr::null_mut(), 0) == 0 {
        CloseHandle(input_read);
        CloseHandle(input_write);
        return Err("CreatePipe(output) 失败".to_string());
    }

    let mut hpc: WinHandle = std::ptr::null_mut();
    let hr = create(
        Coord { x: 80, y: 25 },
        input_read,
        output_write,
        PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE,
        &mut hpc,
    );

    // CreatePseudoConsole 内部会 duplicate 所需句柄,我方句柄可立即关闭。
    // 先关我方管道端再 ClosePseudoConsole,避免 host 阻塞在写满的管道上。
    CloseHandle(input_read);
    CloseHandle(input_write);
    CloseHandle(output_read);
    CloseHandle(output_write);

    if hr < 0 {
        return Err(format!("CreatePseudoConsole HRESULT=0x{:08X}", hr as u32));
    }
    if !hpc.is_null() {
        close(hpc);
    }
    Ok(())
}
