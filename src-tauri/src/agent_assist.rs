use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

const NAMING_PROMPT_TEMPLATE: &str = r#"You are a task title generator. Given the original task prompt below and (when available) the session execution summary, produce a single short title for this task.

Rules:
1. The output language MUST match the primary language of the task content. Chinese in -> Chinese out. English in -> English out. For mixed input, follow the dominant language.
2. Strictly 120 characters or fewer.
3. Start with a verb. Describe the core work that was actually performed or is being performed (e.g. "Fix login token expiration", "Refactor PTY read buffer", "修复登录页 token 过期").
4. If the session execution summary is present and diverges from the original prompt, follow what was actually done — not what was originally asked.
5. No surrounding quotes, no trailing punctuation, no emoji, no Markdown, no prefixes such as "Task:" or "Title:", no explanations.
6. CRITICAL: Output a single line wrapped exactly in <TITLE> and </TITLE> tags. Example: <TITLE>Fix login token expiration</TITLE>
   Output nothing outside these tags — no extra text, blank lines, code fences, or commentary.

──── Original Task Prompt ────
{prompt}

──── Session Execution Summary ────
{summary}
"#;

const NAMING_FALLBACK_SUMMARY: &str =
    "(No session summary available — generate the title based on the original prompt alone.)";

const NAMING_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TITLE_CHARS: usize = 120;
const MAX_PROMPT_CHARS: usize = 4000;

fn build_naming_prompt(original_prompt: &str, summary: Option<&str>) -> String {
    let summary_text = summary.unwrap_or(NAMING_FALLBACK_SUMMARY);
    NAMING_PROMPT_TEMPLATE
        .replace("{prompt}", original_prompt)
        .replace("{summary}", summary_text)
}

/// 校验 project_path：必须 absolute、可 canonicalize、且确实是个目录。
/// 避免将任意目录作为 cwd 启动 agent 进程（M-3 修复）。
fn validate_project_path_for_naming(project_path: &str) -> Result<(), String> {
    let path = Path::new(project_path);
    if !path.is_absolute() {
        return Err("project_path must be absolute".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project_path: {}", e))?;
    if !canonical.is_dir() {
        return Err("project_path is not a directory".into());
    }
    Ok(())
}

async fn read_pipe_to_end<R: AsyncRead + Unpin>(
    mut pipe: R,
    stream_name: &str,
) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    pipe.read_to_end(&mut data)
        .await
        .map_err(|e| format!("Failed to read agent {}: {}", stream_name, e))?;
    Ok(data)
}

/// 异步启动 headless agent 子进程（任务命名 / 议题补充共用）。
/// 超时后通过 `start_kill()` 终止子进程，避免阻塞线程和后台 agent 持续运行（M-2 修复）。
async fn run_headless_agent_with_timeout(
    agent: &str,
    project_path: &str,
    prompt: &str,
    timeout_dur: Duration,
) -> Result<Output, String> {
    let launch = crate::app_settings::get_agent_launch_spec(agent);
    let login_env: Vec<(String, String)> = crate::app_settings::get_login_shell_env().to_vec();

    let mut cmd = tokio::process::Command::new(&launch.program);
    crate::subprocess::configure_background_tokio_command(&mut cmd);
    if agent == "codex" {
        cmd.args([
            "exec",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "-c",
            "approval_policy=\"never\"",
            prompt,
        ]);
    } else {
        cmd.args([
            "-p",
            prompt,
            "--output-format",
            "text",
            "--permission-mode",
            "plan",
            "--tools",
            "",
            "--no-session-persistence",
        ]);
    }
    cmd.current_dir(project_path);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    for (key, value) in &login_env {
        cmd.env(key, value);
    }
    for (key, value) in &launch.extra_env {
        cmd.env(key, value);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {agent}: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture agent stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture agent stderr".to_string())?;

    let stdout_task = tokio::spawn(read_pipe_to_end(stdout, "stdout"));
    let stderr_task = tokio::spawn(read_pipe_to_end(stderr, "stderr"));

    let status = match tokio::time::timeout(timeout_dur, child.wait()).await {
        Ok(result) => result.map_err(|e| format!("Agent wait error: {}", e))?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("生成任务名称超时（{} 秒）", timeout_dur.as_secs()));
        }
    };

    let stdout_data = stdout_task
        .await
        .map_err(|e| format!("Agent stdout task failed: {}", e))??;
    let stderr_data = stderr_task
        .await
        .map_err(|e| format!("Agent stderr task failed: {}", e))??;

    Ok(Output {
        status,
        stdout: stdout_data,
        stderr: stderr_data,
    })
}

/// 优先在 stdout 中提取被 `<TITLE>...</TITLE>` 包裹的标题。
/// 取最后一对 `<TITLE>...</TITLE>`，避免同一输出段内更早的示例或解释文本干扰。
fn extract_titled_answer(stdout: &str) -> Option<String> {
    const OPEN: &str = "<TITLE>";
    const CLOSE: &str = "</TITLE>";
    let close_pos = stdout.rfind(CLOSE)?;
    let prefix = &stdout[..close_pos];
    let open_start = prefix.rfind(OPEN)? + OPEN.len();
    let inner = stdout[open_start..close_pos].trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.split_whitespace().collect::<Vec<_>>().join(" "))
    }
}

/// Codex 非交互模式可能先回显 user prompt，prompt 内也包含 `<TITLE>` 示例。
/// 因此只在最后一个 `codex` 输出段中接受标题标签，避免把 prompt 示例当作答案。
fn extract_codex_titled_answer(stdout: &str) -> Option<String> {
    let mut section_start = None;
    let mut offset = 0;

    for line in stdout.split_inclusive('\n') {
        if line.trim() == "codex" {
            section_start = Some(offset + line.len());
        }
        offset += line.len();
    }

    extract_titled_answer(&stdout[section_start?..])
}

/// Codex 非交互模式 stdout 中包含 banner、user/codex 标签和 token 计数等噪音，
/// 取最后一行非噪音文本作为模型实际答复。
fn extract_codex_final_message(stdout: &str) -> String {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if matches!(trimmed, "user" | "codex" | "thinking") {
            continue;
        }
        if trimmed.chars().all(|c| c == '-') {
            continue;
        }
        if trimmed.starts_with("OpenAI Codex") {
            continue;
        }
        if trimmed.starts_with("hook:") {
            continue;
        }
        if trimmed.starts_with("workdir:")
            || trimmed.starts_with("model:")
            || trimmed.starts_with("provider:")
            || trimmed.starts_with("approval:")
            || trimmed.starts_with("sandbox:")
            || trimmed.starts_with("session id:")
            || trimmed.starts_with("reasoning effort:")
            || trimmed.starts_with("reasoning summaries:")
            || trimmed.starts_with("tokens used")
        {
            continue;
        }
        // 跳过纯数字（含逗号）的 token 计数行，例如 "16,330"
        if trimmed
            .chars()
            .all(|c| c.is_ascii_digit() || c == ',' || c.is_whitespace())
        {
            continue;
        }
        return trimmed.to_string();
    }
    String::new()
}

fn sanitize_title(raw: &str) -> String {
    let trimmed = raw.trim();
    let trimmed = trimmed
        .strip_prefix("<TITLE>")
        .and_then(|value| value.strip_suffix("</TITLE>"))
        .unwrap_or(trimmed)
        .trim();
    let stripped = trimmed.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\''
                | '`'
                | '\u{201C}'
                | '\u{201D}'
                | '\u{2018}'
                | '\u{2019}'
                | '《'
                | '》'
                | '【'
                | '】'
                | '「'
                | '」'
                | '『'
                | '』'
        )
    });
    let stripped = stripped
        .trim_end_matches(|c: char| matches!(c, '.' | '。' | '!' | '！' | '?' | '？'))
        .trim();
    stripped
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn truncate_prompt(prompt: String) -> String {
    if prompt.chars().count() <= MAX_PROMPT_CHARS {
        prompt
    } else {
        prompt.chars().take(MAX_PROMPT_CHARS).collect::<String>() + "…"
    }
}

#[tauri::command]
pub async fn generate_task_name(
    project_path: String,
    agent: String,
    session_path: Option<String>,
    original_prompt: String,
) -> Result<String, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {}", agent));
    }
    let is_codex = agent == "codex";

    // 1. 校验 project_path 合法（M-3）
    let project_for_validation = project_path.clone();
    tokio::task::spawn_blocking(move || validate_project_path_for_naming(&project_for_validation))
        .await
        .map_err(|e| format!("project_path 校验线程错误: {}", e))??;

    // 2. session 摘要提取在 spawn_blocking 中完成（避免阻塞 Tokio）
    let summary = if let Some(raw_path) = session_path {
        let project_for_summary = project_path.clone();
        tokio::task::spawn_blocking(move || {
            match crate::session::validate_session_path(&raw_path, &project_for_summary, is_codex) {
                Ok(canonical) => {
                    crate::session::extract_session_summary_text(&canonical.to_string_lossy(), 7000)
                }
                Err(e) => {
                    eprintln!("[generate_task_name] session_path 校验失败：{}", e);
                    None
                }
            }
        })
        .await
        .map_err(|e| format!("摘要线程错误: {}", e))?
    } else {
        None
    };

    // 3. 拼装命名 prompt
    let truncated_prompt = truncate_prompt(original_prompt);
    let full_prompt = build_naming_prompt(&truncated_prompt, summary.as_deref());

    // 4. 调用 agent 子进程（kill-on-timeout）
    let output =
        run_headless_agent_with_timeout(&agent, &project_path, &full_prompt, NAMING_TIMEOUT)
            .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Agent failed: {}{}", stderr, stdout));
    }

    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    // Codex 只接受最后一个 `codex` 输出段里的 <TITLE>，避免命中 prompt 回显里的示例；
    // 未命中再回退到 banner 过滤。
    let answer = if is_codex {
        extract_codex_titled_answer(&raw).unwrap_or_else(|| extract_codex_final_message(&raw))
    } else {
        extract_titled_answer(&raw).unwrap_or_else(|| raw.trim().to_string())
    };

    let sanitized = sanitize_title(&answer);
    if sanitized.is_empty() {
        return Err("Agent returned empty response.".to_string());
    }
    Ok(sanitized)
}

// ── 议题讨论 Skill 指令（云效 v2 详情页「发起讨论」用）────────────────────────

const GRILLING_INSTRUCTIONS: &str = "请用 grilling 流程走完决策树：一次只问一个问题，等用户回答后再问下一个；每个问题先给出你的推荐答案；能用环境/代码查证的事实先去查证而不是问用户；把每条决策分支走完，依赖关系逐条解决；达成共享理解后产出符合 What/Why/Scope 的 issue 提案；先不要写代码。";

const DIAGNOSING_BUGS_INSTRUCTIONS: &str = "请用 diagnosing-bugs 流程走：先搭一条能变红的命令，再复现、最小化、提假设，别急着猜原因；每个结论都要有可复现的证据，不凭感觉猜。";

/// 云效类别 → Skill 指令：Req → grilling，Bug → diagnosing-bugs，其余无。
pub fn issue_discussion_instructions(category: &str) -> Option<&'static str> {
    match category.trim().to_lowercase().as_str() {
        "req" => Some(GRILLING_INSTRUCTIONS),
        "bug" => Some(DIAGNOSING_BUGS_INSTRUCTIONS),
        _ => None,
    }
}

/// 前端在拼「发起讨论」prompt 时调用，取对应 Skill 的流程指令文本（无则为空串）。
#[tauri::command]
pub fn get_issue_discussion_instructions(category: String) -> Result<String, String> {
    Ok(issue_discussion_instructions(&category).unwrap_or("").to_string())
}

// ── 议题补充表单预填（轻量 headless 调用）────────────────────────────────────

const SUPPLEMENT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_SUPPLEMENT_INPUT_CHARS: usize = 8000;

const SUPPLEMENT_TEMPLATE: &str = r#"你是议题澄清助手。根据下面的原始议题内容，按固定格式把字段补全。

规则：
1. 只输出一个 JSON 对象，键严格如下（缺失的信息留空字符串 ""，不要编造）：
   {fields}
2. JSON 用 <SUPPLEMENT> 与 </SUPPLEMENT> 标签包裹，标签外不要输出任何内容。
3. 保留原始议题中的事实，不要添加原文没有的信息。

──── 原始议题内容 ────
{issue_text}

──── 云效链接 ────
{link}
"#;

/// 补充表单预填结果：字段 key → 文本值（与前端 issueForms 字段 key 对齐）。
#[derive(Serialize, Clone, Debug, Default)]
pub struct IssueSupplement {
    pub fields: HashMap<String, String>,
}

fn build_supplement_prompt(kind: &str, issue_text: &str, link: &str) -> String {
    let fields = if kind == "缺陷类" {
        "\"subject\": 标题, \"problem\": 问题描述, \"expectation\": 期望行为, \"repro\": 复现步骤, \"regression\": 回归信息, \"notes\": 补充说明"
    } else {
        "\"subject\": 标题, \"pain\": 当前痛点, \"expectation\": 期望行为, \"alternative\": 备选方案, \"notes\": 补充说明"
    };
    SUPPLEMENT_TEMPLATE
        .replace("{fields}", fields)
        .replace("{issue_text}", issue_text)
        .replace("{link}", link)
}

fn truncate_supplement_input(text: String) -> String {
    if text.chars().count() <= MAX_SUPPLEMENT_INPUT_CHARS {
        text
    } else {
        text.chars().take(MAX_SUPPLEMENT_INPUT_CHARS).collect::<String>() + "…"
    }
}

/// 提取 `<SUPPLEMENT>...</SUPPLEMENT>` 内 JSON（取最后一对标签，避开 prompt 回显）；
/// 无标签时回退到整个 stdout 当作 JSON 文本。
fn extract_supplement_json(stdout: &str) -> String {
    const OPEN: &str = "<SUPPLEMENT>";
    const CLOSE: &str = "</SUPPLEMENT>";
    if let Some(close_pos) = stdout.rfind(CLOSE) {
        let prefix = &stdout[..close_pos];
        if let Some(open_start) = prefix.rfind(OPEN) {
            let inner = &prefix[open_start + OPEN.len()..];
            let trimmed = inner.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    stdout.trim().to_string()
}

/// 解析补充结果：仅收集字符串值，跳过 null / 数字 / 嵌套对象（防御模型输出漂移）。
fn parse_issue_supplement(stdout: &str) -> Result<IssueSupplement, String> {
    let json_text = extract_supplement_json(stdout);
    let value: serde_json::Value =
        serde_json::from_str(&json_text).map_err(|e| format!("解析议题补充结果失败: {e}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "解析议题补充结果失败：响应不是 JSON 对象".to_string())?;
    let mut fields = HashMap::new();
    for (key, value) in object {
        if let Some(text) = value.as_str() {
            fields.insert(key.clone(), text.to_string());
        }
    }
    Ok(IssueSupplement { fields })
}

/// 轻量 AI 预填议题补充表单：按类型模板生成结构化字段草稿。
/// project_path 仅作为 headless 进程 cwd，校验规则与 generate_task_name 同级。
#[tauri::command]
pub async fn generate_issue_supplement(
    project_path: String,
    agent: String,
    category: String,
    issue_text: String,
    link: String,
) -> Result<IssueSupplement, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {}", agent));
    }
    let project_for_validation = project_path.clone();
    tokio::task::spawn_blocking(move || validate_project_path_for_naming(&project_for_validation))
        .await
        .map_err(|e| format!("project_path 校验线程错误: {}", e))??;

    let kind = if category.trim().eq_ignore_ascii_case("bug") {
        "缺陷类"
    } else {
        "需求类"
    };
    let truncated = truncate_supplement_input(issue_text);
    let prompt = build_supplement_prompt(kind, &truncated, link.trim());

    let output =
        run_headless_agent_with_timeout(&agent, &project_path, &prompt, SUPPLEMENT_TIMEOUT)
            .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Agent failed: {}{}", stderr, stdout));
    }
    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    parse_issue_supplement(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_titled_answer_from_wrapped_output() {
        let stdout = "OpenAI Codex v0.128\nuser\n...\ncodex\n<TITLE>修复登录页 token 过期</TITLE>\ntokens used\n12,345\n";
        assert_eq!(
            extract_titled_answer(stdout).as_deref(),
            Some("修复登录页 token 过期")
        );
    }

    #[test]
    fn extract_titled_takes_last_match_avoiding_prompt_echo() {
        // 模拟 Codex stdout 中 prompt 被回显（含 prompt 内嵌示例标签），随后才是模型实际答复
        let stdout = "user\n...例如：<TITLE>修复登录页 token 过期</TITLE> 是示例\nhook: SessionStart\ncodex\n<TITLE>重构 PTY 缓冲区到 64KB</TITLE>\ntokens used\n";
        assert_eq!(
            extract_titled_answer(stdout).as_deref(),
            Some("重构 PTY 缓冲区到 64KB")
        );
        assert_eq!(
            extract_codex_titled_answer(stdout).as_deref(),
            Some("重构 PTY 缓冲区到 64KB")
        );
    }

    #[test]
    fn extract_codex_titled_answer_ignores_prompt_echo_sample() {
        let stdout = "OpenAI Codex v0.128\nuser\n正确示例：<TITLE>修复登录页 token 过期</TITLE>\nhook: SessionStart\ncodex\n重命名任务标题生成逻辑\ntokens used\n1,234\n";
        assert_eq!(
            extract_titled_answer(stdout).as_deref(),
            Some("修复登录页 token 过期")
        );
        assert_eq!(extract_codex_titled_answer(stdout), None);
        assert_eq!(
            extract_codex_final_message(stdout),
            "重命名任务标题生成逻辑"
        );
    }

    #[test]
    fn extract_titled_answer_collapses_internal_whitespace() {
        let stdout = "<TITLE>  Fix\n  login\tbug  </TITLE>";
        assert_eq!(
            extract_titled_answer(stdout).as_deref(),
            Some("Fix login bug")
        );
    }

    #[test]
    fn extract_titled_answer_returns_none_when_tag_missing() {
        assert_eq!(extract_titled_answer("plain output without tags"), None);
        assert_eq!(extract_titled_answer("<TITLE></TITLE>"), None);
        assert_eq!(extract_titled_answer("<TITLE>  </TITLE>"), None);
    }

    #[test]
    fn extracts_codex_final_message_skipping_banner_and_tokens() {
        let stdout = "OpenAI Codex v0.128.0 (research preview)\n--------\nworkdir: /tmp\nmodel: gpt-5.5\nprovider: openai\nsession id: 019e\n--------\nuser\nReply with hi\nhook: SessionStart\nhook: SessionStart Completed\ncodex\n修复登录页 token 过期问题\ntokens used\n16,330\n";
        assert_eq!(
            extract_codex_final_message(stdout),
            "修复登录页 token 过期问题"
        );
    }

    #[test]
    fn sanitize_strips_quotes_and_trailing_punct() {
        assert_eq!(
            sanitize_title("\"Fix login token expiration!\""),
            "Fix login token expiration"
        );
        assert_eq!(
            sanitize_title("「修复登录 token 过期。」"),
            "修复登录 token 过期"
        );
    }

    #[test]
    fn sanitize_strips_wrapping_title_tags() {
        assert_eq!(
            sanitize_title("<TITLE>熟悉项目 README 和 AGENTS 规范</TITLE>"),
            "熟悉项目 README 和 AGENTS 规范"
        );
    }

    #[test]
    fn sanitize_truncates_to_120_chars() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_title(&long).chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn build_naming_prompt_with_summary() {
        let p = build_naming_prompt("修一下登录 bug", Some("[用户] 登录失败 [AI] 看看 auth.ts"));
        assert!(p.contains("修一下登录 bug"));
        assert!(p.contains("[用户] 登录失败"));
    }

    #[test]
    fn build_naming_prompt_without_summary_uses_fallback() {
        let p = build_naming_prompt("写个 hello world", None);
        assert!(p.contains(NAMING_FALLBACK_SUMMARY));
    }

    #[test]
    fn issue_instructions_map_req_to_grilling() {
        let text = issue_discussion_instructions("Req").expect("Req has instructions");
        assert!(text.contains("grilling"));
        assert!(text.contains("What/Why/Scope"));
    }

    #[test]
    fn issue_instructions_map_bug_to_diagnosing_bugs() {
        let text = issue_discussion_instructions("Bug").expect("Bug has instructions");
        assert!(text.contains("diagnosing-bugs"));
        assert!(text.contains("变红"));
    }

    #[test]
    fn issue_instructions_none_for_task_and_unknown() {
        assert!(issue_discussion_instructions("Task").is_none());
        assert!(issue_discussion_instructions("").is_none());
        assert!(issue_discussion_instructions("  ").is_none());
    }

    #[test]
    fn parses_supplement_from_tagged_json() {
        let stdout = "<SUPPLEMENT>\n{\"subject\": \"x\", \"pain\": \"y\"}\n</SUPPLEMENT>";
        let fields = parse_issue_supplement(stdout).expect("parses").fields;
        assert_eq!(fields.get("subject").map(String::as_str), Some("x"));
        assert_eq!(fields.get("pain").map(String::as_str), Some("y"));
    }

    #[test]
    fn parses_supplement_from_noisy_stdout_using_last_tag() {
        let stdout = "user\n...echo...\ncodex\n<SUPPLEMENT>{\"subject\":\"a\",\"expectation\":\"b\"}</SUPPLEMENT>\ntokens used\n12,345\n";
        let fields = parse_issue_supplement(stdout).expect("parses").fields;
        assert_eq!(fields.get("subject").map(String::as_str), Some("a"));
        assert_eq!(fields.get("expectation").map(String::as_str), Some("b"));
    }

    #[test]
    fn parses_supplement_raw_json_fallback() {
        let stdout = "{\"subject\": \"raw\"}";
        let fields = parse_issue_supplement(stdout).expect("parses").fields;
        assert_eq!(fields.get("subject").map(String::as_str), Some("raw"));
    }

    #[test]
    fn supplement_skips_non_string_values() {
        let stdout = "<SUPPLEMENT>{\"subject\":\"s\", \"pain\": 123, \"notes\": null}</SUPPLEMENT>";
        let fields = parse_issue_supplement(stdout).expect("parses").fields;
        assert_eq!(fields.get("subject").map(String::as_str), Some("s"));
        assert!(!fields.contains_key("pain"));
        assert!(!fields.contains_key("notes"));
    }
}
