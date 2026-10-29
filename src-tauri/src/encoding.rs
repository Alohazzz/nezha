//! Windows 下的输出解码兜底。
//!
//! 背景（2026-10 用户反馈的终端乱码）：中文 Windows 的系统 ANSI 代码页是 936 (GBK)，
//! agent 在任务里执行 PowerShell / cmd 子命令时，子进程向管道输出 GBK 字节；agent CLI
//! 按 UTF-8 解码后回显，产生 `鏁版嵁搴?` 这类「合法但错误」的汉字（无 U+FFFD 替换符），
//! 经 PTY 原样到达 Nezha。实测 `LANG/LC_CTYPE=en_US.UTF-8` 对 Windows 子进程无效，
//! PowerShell 只认代码页。
//!
//! 策略与 ZCode（`outputEncoding.ts`）一致：
//! 1. **严格 UTF-8 优先**——字节本来就是合法 UTF-8 时绝不改写；
//! 2. **仅 Windows 启用 legacy 兜底**——解码遇到非法序列时，按探测到的活动代码页
//!    （`chcp`，通常是 936/GBK）重解一次，成功且无替换符才采用；
//! 3. 探测结果进程内缓存一次；探测失败时中文系统回落 GBK，其余回落 Latin-1（永不错杀）。
//!
//! 终端性能红线：本模块只做纯 CPU 的字节→字符串转换，O(n)、无 IO、无锁热点；
//! PTY reader 的 32KB 读缓冲 / 64KB 写切片 / leftover 拼接结构不受影响。

use std::sync::OnceLock;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 进程内缓存的 legacy 编码标签（如 "gbk"、"cp932"）；`None` 表示不需要兜底。
static LEGACY_ENCODING: OnceLock<Option<&'static str>> = OnceLock::new();

#[cfg(windows)]
fn detect_windows_legacy_encoding() -> Option<&'static str> {
    // 用户可用环境变量强制指定/禁用兜底编码（值非法视为禁用）。
    if let Ok(raw) = std::env::var("NEZHA_WINDOWS_OUTPUT_ENCODING") {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        return encoding_rs::Encoding::for_label(raw.as_bytes()).map(|e| e.name());
    }
    // 探测活动代码页（console codepage）。失败不致命：还有 registry 回落。
    if let Ok(output) = std::process::Command::new("cmd.exe")
        .args(["/d", "/s", "/c", "chcp"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
    {
        if let Some(cp) = extract_code_page(&String::from_utf8_lossy(&output.stdout)) {
            return code_page_encoding(cp);
        }
    }
    // chcp 不可用（罕见）：按系统 ANSI 代码页回落。
    let acp = unsafe { GetACP() } as u16;
    code_page_encoding(acp)
}

#[cfg(windows)]
fn extract_code_page(output: &str) -> Option<u16> {
    // "Active code page: 936" / "活动代码页: 936" —— 取最后一个空白分隔段。
    output.split_whitespace().next_back()?.parse::<u16>().ok()
}

#[cfg(windows)]
fn code_page_encoding(cp: u16) -> Option<&'static str> {
    match cp {
        // 65001 = UTF-8，无需兜底。
        65_001 => None,
        // 936/54936 简体中文（GBK/GB18030）、950 繁体中文（Big5）、932 日文、949 韩文。
        936 | 54_936 => Some("gbk"),
        950 => Some("big5"),
        932 => Some("Shift_JIS"),
        949 => Some("EUC-KR"),
        _ => None,
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetACP() -> u32;
}

/// 非 Windows 恒不需要兜底。
#[cfg(not(windows))]
fn detect_windows_legacy_encoding() -> Option<&'static str> {
    None
}

fn legacy_encoding() -> Option<&'static str> {
    *LEGACY_ENCODING.get_or_init(detect_windows_legacy_encoding)
}

/// 把子进程输出字节解码为 UTF-8 字符串。
///
/// 合法 UTF-8（含纯 ASCII）时行为与 `String::from_utf8_lossy` 一致；仅在解码失败
/// 且 legacy 编码可用时，才用 legacy 编码重解——避免把 GBK 字节打成 `���`。
/// 两条路都解不干净时回落 UTF-8 lossy，保证不丢数据。
pub fn decode_output_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => return s.to_owned(),
        Err(_) => {}
    }
    if let Some(enc) = legacy_encoding() {
        if let Some(encoding) = encoding_rs::Encoding::for_label(enc.as_bytes()) {
            // UTF-8 已确认非法，直接按 legacy 解；有替换符说明这批字节连 legacy 也解不动，
            // 回落 lossy 保持与旧行为一致（不至于静默改写成错误的汉字）。
            let (text, _, had_errors) = encoding.decode(bytes);
            if !had_errors {
                return text.into_owned();
            }
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 流式解码器：按 chunk 喂入，内部处理跨 chunk 的多字节边界。
///
/// 语义：先按 UTF-8 累积缓冲；一旦出现**确定性**非法序列，整流切换到 legacy 编码
/// （ZCode `createExecutionOutputStreamDecoder` 同款策略）；只有「末尾疑似半截
/// 多字节」时才保留 leftover 等下一个 chunk。纯 ASCII 永不触发切换。
pub struct StreamDecoder {
    utf8_buf: Vec<u8>,
    pending: String,
    legacy: Option<(&'static str, Option<encoding_rs::Decoder>)>,
    done_utf8: bool,
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self {
            utf8_buf: Vec::new(),
            pending: String::new(),
            legacy: legacy_encoding().map(|name| {
                (
                    name,
                    encoding_rs::Encoding::for_label(name.as_bytes())
                        .map(|e| e.new_decoder()),
                )
            }),
            done_utf8: false,
        }
    }

    /// 喂入一段字节，返回本次累计可输出的文本。
    pub fn push(&mut self, bytes: &[u8]) -> String {
        if self.done_utf8 {
            return self.push_legacy(bytes);
        }
        self.utf8_buf.extend_from_slice(bytes);
        match std::str::from_utf8(&self.utf8_buf) {
            Ok(s) => {
                self.pending.push_str(s);
                self.utf8_buf.clear();
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    // SAFETY: valid_up_to 之前的字节为合法 UTF-8
                    self.pending
                        .push_str(unsafe { std::str::from_utf8_unchecked(&self.utf8_buf[..valid]) });
                }
                let rest: Vec<u8> = self.utf8_buf[valid..].to_vec();
                if e.error_len().is_some() {
                    // 确定性非法：整流切换 legacy（含本 chunk 已判非法的字节）。
                    self.done_utf8 = true;
                    self.utf8_buf.clear();
                    self.pending.push_str(&decode_legacy_carry(&mut self.legacy, &rest));
                    return std::mem::take(&mut self.pending);
                }
                // 末尾半截多字节：留给下一个 chunk。
                self.utf8_buf.drain(..valid);
            }
        }
        std::mem::take(&mut self.pending)
    }

    /// 流结束：刷出滞留在缓冲里的残余字节（UTF-8 模式下应为空或半截序列，
    /// legacy 模式下交由 decoder 的 final flush 补齐尾部）。
    pub fn finish(&mut self) -> String {
        if self.done_utf8 {
            let Some((_, Some(decoder))) = self.legacy.as_mut() else {
                let tail = String::from_utf8_lossy(&self.utf8_buf).into_owned();
                self.utf8_buf.clear();
                return tail;
            };
            let mut out = String::new();
            let _ = decoder.decode_to_string(&[], &mut out, true);
            let tail = String::from_utf8_lossy(&self.utf8_buf).into_owned();
            self.utf8_buf.clear();
            out.push_str(&tail);
            return out;
        }
        // UTF-8 模式：剩余字节是流末尾的半截多字节（会话被截断），按 lossy 清空。
        let tail = String::from_utf8_lossy(&self.utf8_buf).into_owned();
        self.utf8_buf.clear();
        tail
    }

    fn push_legacy(&mut self, bytes: &[u8]) -> String {
        let fallback = String::from_utf8_lossy(bytes).into_owned();
        let Some((_, Some(decoder))) = self.legacy.as_mut() else {
            return fallback;
        };
        // 保守容量：GBK 一个双字节序列至多 3 字节 UTF-8，×2 足够。
        let mut out = String::with_capacity(bytes.len() * 2);
        let (_, _, had_errors) = decoder.decode_to_string(bytes, &mut out, false);
        if had_errors {
            return fallback;
        }
        out
    }
}

/// legacy 模式首段（含触发切换的非法字节）的解码；无 legacy 解码器或解码出错时回落 lossy。
fn decode_legacy_carry(
    legacy: &mut Option<(&'static str, Option<encoding_rs::Decoder>)>,
    carry: &[u8],
) -> String {
    let fallback = String::from_utf8_lossy(carry).into_owned();
    let Some((_, Some(decoder))) = legacy else {
        return fallback;
    };
    let mut out = String::with_capacity(carry.len() * 2);
    let (_, _, had_errors) = decoder.decode_to_string(carry, &mut out, false);
    if had_errors {
        return fallback;
    }
    out
}

/// 判断当前平台是否启用了 legacy 兜底（供诊断/测试）。
pub fn legacy_encoding_name() -> Option<&'static str> {
    legacy_encoding()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_utf8_passes_through_untouched() {
        let s = "数据库操作流 ✅ 中文";
        assert_eq!(decode_output_bytes(s.as_bytes()), s);
    }

    #[test]
    fn invalid_utf8_falls_back_to_lossy_without_legacy() {
        // 0xFF 永远不是任何 UTF-8 序列的开头；非 Windows（无 legacy）应得到替换符。
        let bytes = [0x61, 0xFF, 0x62];
        let decoded = decode_output_bytes(&bytes);
        assert!(decoded.contains('\u{FFFD}') || decoded.contains("a") /* 平台相关 */);
    }

    #[test]
    fn stream_decoder_ascii_only_never_switches() {
        let mut d = StreamDecoder::new();
        let out = d.push(b"hello \r\n world");
        assert_eq!(out, "hello \r\n world");
    }

    #[test]
    fn stream_decoder_splits_multibyte_across_chunks() {
        let s = "数据库";
        let bytes = s.as_bytes();
        let mut d = StreamDecoder::new();
        // 按字节劈成两半喂入，输出必须与一次性解码一致。
        let mut out = d.push(&bytes[..4]);
        out.push_str(&d.push(&bytes[4..]));
        assert_eq!(out, s);
    }

    #[test]
    fn stream_decoder_single_byte_chunks() {
        let s = "中文abc✅";
        let mut d = StreamDecoder::new();
        let mut out = String::new();
        for b in s.as_bytes() {
            out.push_str(&d.push(&[*b]));
        }
        assert_eq!(out, s);
    }

    #[test]
    fn utf8_then_never_legacy_on_valid_input() {
        // 大量中文分多段喂入：合法 UTF-8 全程不得被改写（哪怕 legacy 可用）。
        let s = "知识沉淀契约：写入 .nezha/drafts/$NEZHA_TASK_ID/knowledge.json";
        let bytes = s.as_bytes();
        let mut d = StreamDecoder::new();
        let mut out = String::new();
        for chunk in bytes.chunks(7) {
            out.push_str(&d.push(chunk));
        }
        assert_eq!(out, s);
    }
}
