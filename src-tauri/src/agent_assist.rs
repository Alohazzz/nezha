use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
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

const KNOWLEDGE_GRAPH_INSTRUCTION: &str = "另外，开始前先使用 his-knowledge-graph 技能：按技能说明打开数据目录（data/index.md 与 modules/），建立对相关 HIS 模块的认知（职责、代码位置、关键实体、跨模块依赖），并用实际代码验证。";

/// 云效类别 → Skill 指令：Req → grilling，Bug → diagnosing-bugs，其余无；
/// Req 与 Bug 都会追加 his-knowledge-graph 技能指令（结合项目知识图谱）。
pub fn issue_discussion_instructions(category: &str) -> Option<String> {
    let flow = match category.trim().to_lowercase().as_str() {
        "req" => GRILLING_INSTRUCTIONS,
        "bug" => DIAGNOSING_BUGS_INSTRUCTIONS,
        _ => return None,
    };
    Some(format!("{flow}\n{KNOWLEDGE_GRAPH_INSTRUCTION}"))
}

/// 前端在拼「发起讨论」prompt 时调用，取对应 Skill 的流程指令文本（无则为空串）。
#[tauri::command]
pub fn get_issue_discussion_instructions(category: String) -> Result<String, String> {
    Ok(issue_discussion_instructions(&category).unwrap_or_default())
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
        "\"subject\": 标题, \"problem\": 问题描述, \"expectation\": 期望行为, \"repro\": 复现步骤, \"regression\": 回归信息, \"solution\": 解决方案, \"notes\": 补充说明"
    } else {
        "\"subject\": 标题, \"pain\": 当前痛点, \"expectation\": 期望行为, \"alternative\": 备选方案, \"solution\": 解决方案, \"notes\": 补充说明"
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

// ── 云效回写汇总生成（写回闭环）──────────────────────────────────────────────

const WRITEBACK_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_FACTS_CHARS: usize = 8000;
const WRITEBACK_SESSION_BUDGET: usize = 8000;

const WRITEBACK_PROMPT_TEMPLATE: &str = r#"你是代码修改总结助手。基于下面的会话过程与事实（议题信息、补充信息、Git 提交与变更统计），为云效议题撰写一段「修改方案汇总」评论，供团队阅读。请按本仓库 PR 描述规范（AGENTS.md 提交与 PR 规范）组织内容。

规则：
1. 只依据给定事实与会话过程，不编造事实里没有的信息（commit、文件、结论都不许虚构）。
2. 按 PR 规范的三段结构输出 Markdown：
   - What（改动方案）：做了什么、关键改动点（可引用 commit 短号/文件）；
   - Why（动机与取舍）：当前问题/痛点是什么、为什么这样改、相对其他方案的取舍（仅当会话/事实中有依据，不编造）；
   - Scope（影响面）：涉及哪些模块/文件、是否触碰现有功能或风险点。
   会话中若有验证/测试过程，最后追加「验证情况」小节。
3. 语言与议题标题一致（中文议题输出中文）。
4. 长度 200-500 字，控制在 12 行以内。
5. 输出放在 <SUMMARY> 与 </SUMMARY> 标签内，标签外不要输出任何内容。

──── 议题 ────
编号：{serial_number}
标题：{task_name}

──── 补充信息 ────
{fields_text}

──── 会话过程 ────
{session_text}

──── 关联提交 ────
{commits}

──── 变更统计 ────
{diff_stat}
"#;

/// 收集回写汇总的事实骨架（commit 列表 + 变更统计），git 数据保证不幻觉。
fn gather_writeback_facts(cwd: &str, base_branch: Option<&str>) -> (String, String) {
    let run = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    let commits = base_branch
        .and_then(|b| run(&["log", "--format=%h %s", &format!("{b}..HEAD")]))
        .or_else(|| run(&["log", "--format=%h %s", "-n", "20"]))
        .unwrap_or_default();
    let diff_stat = base_branch
        .and_then(|b| run(&["diff", "--stat", &format!("{b}...HEAD")]))
        .unwrap_or_default();

    let truncate = |s: String| -> String {
        if s.chars().count() > MAX_FACTS_CHARS {
            s.chars().take(MAX_FACTS_CHARS).collect::<String>() + "…（已截断）"
        } else {
            s
        }
    };
    (
        truncate(commits),
        truncate(diff_stat),
    )
}

fn build_writeback_prompt(
    serial_number: &str,
    task_name: &str,
    fields_text: &str,
    session_text: &str,
    commits: &str,
    diff_stat: &str,
) -> String {
    WRITEBACK_PROMPT_TEMPLATE
        .replace("{serial_number}", serial_number)
        .replace("{task_name}", task_name)
        .replace(
            "{fields_text}",
            if fields_text.trim().is_empty() {
                "（无）"
            } else {
                fields_text.trim()
            },
        )
        .replace(
            "{session_text}",
            if session_text.trim().is_empty() {
                "（无）"
            } else {
                session_text.trim()
            },
        )
        .replace(
            "{commits}",
            if commits.trim().is_empty() {
                "（无）"
            } else {
                commits.trim()
            },
        )
        .replace(
            "{diff_stat}",
            if diff_stat.trim().is_empty() {
                "（无）"
            } else {
                diff_stat.trim()
            },
        )
}

/// 提取 `<SUMMARY>...</SUMMARY>` 内文本（取最后一对标签，避开 prompt 回显）。
fn extract_summary(stdout: &str) -> Option<String> {
    const OPEN: &str = "<SUMMARY>";
    const CLOSE: &str = "</SUMMARY>";
    if let Some(close_pos) = stdout.rfind(CLOSE) {
        let prefix = &stdout[..close_pos];
        if let Some(open_start) = prefix.rfind(OPEN) {
            let inner = &prefix[open_start + OPEN.len()..];
            let trimmed = inner.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// AI 汇总失败时的纯事实模板回退（用户仍可在预览中编辑后发布）。
fn build_fallback_summary(
    serial_number: &str,
    task_name: &str,
    commits: &str,
    diff_stat: &str,
) -> String {
    let mut lines = vec![
        format!("### 修改方案汇总（议题 {serial_number}）"),
        String::new(),
        format!("> 标题：{task_name}"),
        String::new(),
        "> （AI 汇总生成失败，以下为事实记录，可在预览中补充编辑）".to_string(),
        String::new(),
        "#### 关联提交".to_string(),
    ];
    if commits.trim().is_empty() {
        lines.push("（无）".to_string());
    } else {
        for line in commits.lines() {
            if let Some((hash, subject)) = line.split_once(' ') {
                lines.push(format!("- `{hash}` {subject}"));
            } else {
                lines.push(format!("- {line}"));
            }
        }
    }
    lines.push(String::new());
    lines.push("#### 变更统计".to_string());
    if diff_stat.trim().is_empty() {
        lines.push("（无）".to_string());
    } else {
        lines.push(format!("```\n{diff_stat}\n```"));
    }
    lines.join("\n")
}

/// 生成云效回写「修改方案汇总」：会话摘要 + git 事实骨架 + headless Agent 按 PR 规范润色。
/// repo_path 缺省时用 project_path；base_branch 缺省时取最近 20 条提交；
/// session_path 缺省或不可读时降级为仅事实模式。
#[tauri::command]
pub async fn generate_yunxiao_writeback_summary(
    project_path: String,
    repo_path: Option<String>,
    serial_number: String,
    task_name: String,
    fields_text: String,
    session_path: Option<String>,
    base_branch: Option<String>,
    agent: String,
) -> Result<String, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {}", agent));
    }
    let serial_number = serial_number.trim().to_string();
    if serial_number.is_empty() {
        return Err("缺少议题编号".to_string());
    }
    let project_for_validation = project_path.clone();
    tokio::task::spawn_blocking(move || validate_project_path_for_naming(&project_for_validation))
        .await
        .map_err(|e| format!("project_path 校验线程错误: {e}"))??;

    let cwd = if let Some(repo) = repo_path.as_deref().filter(|r| !r.trim().is_empty()) {
        let repo_trim = repo.trim();
        let repo_for_validation = repo_trim.to_string();
        tokio::task::spawn_blocking(move || {
            validate_project_path_for_naming(&repo_for_validation)
        })
        .await
        .map_err(|e| format!("repo_path 校验线程错误: {e}"))??;
        repo_trim.to_string()
    } else {
        project_path.clone()
    };

    let base_branch = base_branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    let cwd_for_facts = cwd.clone();
    let base_for_facts = base_branch.clone();
    let (commits, diff_stat) = tokio::task::spawn_blocking(move || {
        gather_writeback_facts(&cwd_for_facts, base_for_facts.as_deref())
    })
    .await
    .map_err(|e| format!("收集 git 事实线程错误: {e}"))?;

    // 会话摘要：供「基于会话」撰写汇总；校验失败/文件超限时降级为无会话模式。
    let session_text = match session_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let project_for_session = project_path.clone();
            let is_codex = agent == "codex";
            let raw_for_session = raw.to_string();
            let summary = tokio::task::spawn_blocking(move || {
                match crate::session::validate_session_path(
                    &raw_for_session,
                    &project_for_session,
                    is_codex,
                ) {
                    Ok(canonical) => crate::session::extract_session_summary_text(
                        &canonical.to_string_lossy(),
                        WRITEBACK_SESSION_BUDGET,
                    ),
                    Err(e) => {
                        eprintln!("[writeback] session_path 校验失败：{e}");
                        None
                    }
                }
            })
            .await
            .map_err(|e| format!("会话摘要线程错误: {e}"))?;
            summary.unwrap_or_default()
        }
        None => String::new(),
    };

    let prompt = build_writeback_prompt(
        &serial_number,
        task_name.trim(),
        &fields_text,
        &session_text,
        &commits,
        &diff_stat,
    );
    let output = run_headless_agent_with_timeout(&agent, &project_path, &prompt, WRITEBACK_TIMEOUT)
        .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Agent failed: {}{}", stderr, stdout));
    }
    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok(extract_summary(&raw).unwrap_or_else(|| {
        build_fallback_summary(&serial_number, task_name.trim(), &commits, &diff_stat)
    }))
}

// ── 知识沉淀（云效议题讨论完成后，提取图谱增量并生成审核议题候选）──────────────

const SEDIMENTATION_TIMEOUT: Duration = Duration::from_secs(120);
const SEDIMENTATION_SESSION_BUDGET: usize = 8000;
const MAX_SUGGESTION_FIELD_CHARS: usize = 4000;

/// 一条候选知识（对应一个云效审核议题）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSuggestion {
    pub module: String,
    pub section: String,
    pub content: String,
    pub evidence: String,
    pub confidence: String,
    pub suggested_title: String,
}

const SEDIMENTATION_PROMPT_TEMPLATE: &str = r#"你是知识沉淀助手。基于下面的会话过程与云效议题信息，对照 HIS 知识图谱，识别「有价值且图谱中没有」的知识，按给定格式输出候选。

先完整阅读下方 <SKILL> 内的技能内容，并严格遵循其判定标准、比对方法与输出格式。

<SKILL>
{skill_content}
</SKILL>

──── 云效议题 ────
编号：{serial_number}
标题：{task_name}
链接：{link}
补充信息：
{fields_text}

──── 会话过程 ────
{session_text}

──── 知识图谱数据目录 ────
{graph_data_dir}

──── 项目根目录 ────
{project_path}

只输出 <SUGGESTIONS> 与 </SUGGESTIONS> 之间的 JSON 数组，标签外不要输出任何内容。
"#;

fn build_sedimentation_prompt(
    skill_content: &str,
    serial_number: &str,
    task_name: &str,
    link: &str,
    fields_text: &str,
    session_text: &str,
    graph_data_dir: &str,
    project_path: &str,
) -> String {
    let placeholder = |s: &str| -> String {
        if s.trim().is_empty() {
            "（无）".to_string()
        } else {
            s.trim().to_string()
        }
    };
    SEDIMENTATION_PROMPT_TEMPLATE
        .replace("{skill_content}", skill_content.trim())
        .replace("{serial_number}", serial_number.trim())
        .replace("{task_name}", &placeholder(task_name))
        .replace("{link}", &placeholder(link))
        .replace("{fields_text}", &placeholder(fields_text))
        .replace("{session_text}", &placeholder(session_text))
        .replace("{graph_data_dir}", graph_data_dir.trim())
        .replace("{project_path}", project_path.trim())
}

/// 提取 `<SUGGESTIONS>...</SUGGESTIONS>` 内的 JSON 数组并规范化字段。
fn extract_suggestions(stdout: &str) -> Result<Vec<KnowledgeSuggestion>, String> {
    const OPEN: &str = "<SUGGESTIONS>";
    const CLOSE: &str = "</SUGGESTIONS>";
    let inner = stdout
        .rfind(CLOSE)
        .and_then(|close_pos| {
            let prefix = &stdout[..close_pos];
            prefix.rfind(OPEN).map(|open_pos| {
                prefix[open_pos + OPEN.len()..].trim().to_string()
            })
        })
        .ok_or_else(|| "未找到 <SUGGESTIONS> 输出标签".to_string())?;
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&inner)
        .map_err(|e| format!("解析候选知识 JSON 失败: {e}"))?;
    let mut out = Vec::new();
    for item in parsed {
        let module = item
            .get("module")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let section = item
            .get("section")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if module.is_empty() || section.is_empty() {
            continue; // 缺关键字段的条目丢弃
        }
        let truncate = |s: &str| -> String {
            let t = s.trim();
            if t.chars().count() > MAX_SUGGESTION_FIELD_CHARS {
                t.chars().take(MAX_SUGGESTION_FIELD_CHARS).collect::<String>() + "…"
            } else {
                t.to_string()
            }
        };
        out.push(KnowledgeSuggestion {
            module,
            section,
            content: truncate(item.get("content").and_then(serde_json::Value::as_str).unwrap_or("")),
            evidence: truncate(item.get("evidence").and_then(serde_json::Value::as_str).unwrap_or("")),
            confidence: item
                .get("confidence")
                .and_then(serde_json::Value::as_str)
                .filter(|c| *c == "confirmed" || *c == "pending")
                .unwrap_or("pending")
                .to_string(),
            suggested_title: truncate(
                item.get("suggestedTitle")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            ),
        });
    }
    Ok(out)
}

/// 生成知识沉淀候选：读取 `knowledge-sedimentation` 技能内容注入 headless prompt，
/// 基于会话摘要 + 议题信息 + 图谱目录（现场比对）输出结构化候选，供前端预览后创建审核议题。
#[tauri::command]
pub async fn generate_knowledge_sedimentation(
    project_path: String,
    serial_number: String,
    task_name: String,
    fields_text: String,
    link: String,
    session_path: Option<String>,
    agent: String,
) -> Result<Vec<KnowledgeSuggestion>, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {}", agent));
    }
    let project_for_validation = project_path.clone();
    tokio::task::spawn_blocking(move || validate_project_path_for_naming(&project_for_validation))
        .await
        .map_err(|e| format!("project_path 校验线程错误: {e}"))??;

    // 读取 knowledge-sedimentation 技能内容（来自技能库；缺失时提示先同步/安装）
    let (skill_content, graph_data_dir) =
        tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
            let hub = crate::skills::configured_hub_path()
                .ok_or_else(|| "技能库尚未配置".to_string())?;
            let skill_md = Path::new(&hub)
                .join("knowledge-sedimentation")
                .join("SKILL.md");
            let content = fs::read_to_string(&skill_md).map_err(|_| {
                "未找到 knowledge-sedimentation 技能（请先同步技能仓库并安装该项目技能）".to_string()
            })?;
            let graph_dir = Path::new(&hub)
                .join("his-knowledge-graph")
                .join("data");
            Ok((content, graph_dir.to_string_lossy().into_owned()))
        })
        .await
        .map_err(|e| e.to_string())??;

    // 会话摘要（校验失败/超限时降级为无会话模式）
    let session_text = match session_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let project_for_session = project_path.clone();
            let is_codex = agent == "codex";
            let raw_for_session = raw.to_string();
            let summary = tokio::task::spawn_blocking(move || {
                match crate::session::validate_session_path(
                    &raw_for_session,
                    &project_for_session,
                    is_codex,
                ) {
                    Ok(canonical) => crate::session::extract_session_summary_text(
                        &canonical.to_string_lossy(),
                        SEDIMENTATION_SESSION_BUDGET,
                    ),
                    Err(e) => {
                        eprintln!("[sedimentation] session_path 校验失败：{e}");
                        None
                    }
                }
            })
            .await
            .map_err(|e| format!("会话摘要线程错误: {e}"))?;
            summary.unwrap_or_default()
        }
        None => String::new(),
    };

    let prompt = build_sedimentation_prompt(
        &skill_content,
        &serial_number,
        task_name.trim(),
        &link,
        &fields_text,
        &session_text,
        &graph_data_dir,
        &project_path,
    );
    let output = run_headless_agent_with_timeout(
        &agent,
        &project_path,
        &prompt,
        SEDIMENTATION_TIMEOUT,
    )
    .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Agent failed: {}{}", stderr, stdout));
    }
    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    extract_suggestions(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writeback_prompt_includes_session_and_pr_sections() {
        let prompt = build_writeback_prompt(
            "HJWE-65",
            "测试议题",
            "痛点：图片加载慢",
            "会话摘要：复现了加载慢的问题，定位到资源未压缩",
            "abc123 压缩图片资源",
            "1 file changed, 10 insertions(+)",
        );
        assert!(prompt.contains("会话过程"));
        assert!(prompt.contains("会话摘要：复现了加载慢的问题"));
        assert!(prompt.contains("Why（动机与取舍）"));
        assert!(prompt.contains("Scope（影响面）"));
        assert!(prompt.contains("abc123 压缩图片资源"));
    }

    #[test]
    fn writeback_prompt_falls_back_to_no_session_markers() {
        let prompt = build_writeback_prompt("HJWE-65", "测试议题", "", "", "", "");
        assert!(prompt.contains("（无）"));
    }

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
        assert!(text.contains("his-knowledge-graph"));
    }

    #[test]
    fn issue_instructions_map_bug_to_diagnosing_bugs() {
        let text = issue_discussion_instructions("Bug").expect("Bug has instructions");
        assert!(text.contains("diagnosing-bugs"));
        assert!(text.contains("变红"));
        assert!(text.contains("his-knowledge-graph"));
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

    #[test]
    fn extracts_suggestions_from_tagged_json() {
        let stdout = "prefix\n<SUGGESTIONS>\n[{\"module\":\"Nto.His.Register\",\"section\":\"业务规则与已知坑\",\"content\":\"规则内容\",\"evidence\":\"代码 Hsp/X.cs 2026-08-21\",\"confidence\":\"confirmed\",\"suggestedTitle\":\"挂号排班占用规则\"}]\n</SUGGESTIONS>\nsuffix";
        let list = extract_suggestions(stdout).expect("parses");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].module, "Nto.His.Register");
        assert_eq!(list[0].confidence, "confirmed");
        assert_eq!(list[0].suggested_title, "挂号排班占用规则");
    }

    #[test]
    fn extracts_suggestions_drops_invalid_entries() {
        let stdout = r#"<SUGGESTIONS>[{"module":"","section":"职责","content":"x"},{"module":"Nto.His.Order","section":"职责","content":"y","confidence":"weird","suggestedTitle":"t"}]</SUGGESTIONS>"#;
        let list = extract_suggestions(stdout).expect("parses");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].module, "Nto.His.Order");
        assert_eq!(list[0].confidence, "pending");
    }

    #[test]
    fn extract_suggestions_errors_without_tag() {
        assert!(extract_suggestions("no tags here").is_err());
    }

    #[test]
    fn sedimentation_prompt_includes_skill_and_inputs() {
        let prompt = build_sedimentation_prompt(
            "技能规则",
            "QHDK-1",
            "议题",
            "链接",
            "字段",
            "会话",
            "C:/data",
            "C:/proj",
        );
        assert!(prompt.contains("技能规则"));
        assert!(prompt.contains("QHDK-1"));
        assert!(prompt.contains("C:/data"));
        assert!(prompt.contains("C:/proj"));
    }
}
