use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let mut taskkill = std::process::Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        crate::subprocess::configure_background_command(&mut taskkill);
        let _ = taskkill.status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

/// 拼装 headless agent 子进程参数（claude -p / codex exec）。
/// 轻量模型与思考深度来自应用级设置：None 时不传对应旗标，跟随 CLI 默认。
fn build_headless_agent_args(
    agent: &str,
    prompt: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    allow_read_tools: bool,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    if agent == "codex" {
        args.extend(
            [
                "exec",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--skip-git-repo-check",
                "-c",
                "approval_policy=\"never\"",
                // headless 提示词自包含（材料全部内联），禁加载 cwd 下的 project doc
                // （AGENTS.md 等）——业务仓库的强指令（如「不确定即提问」）会污染判定。
            ]
            .map(OsString::from),
        );
        args.extend(["-c", "project_doc_max_bytes=0"].map(OsString::from));
        if let Some(model) = model {
            args.push("--model".into());
            args.push(model.into());
        }
        if let Some(effort) = reasoning_effort {
            args.push("-c".into());
            args.push(
                format!(
                    "model_reasoning_effort={}",
                    toml::Value::String(effort.to_string())
                )
                .into(),
            );
        }
        args.push(prompt.into());
    } else {
        args.extend(
            [
                "-p",
                prompt,
                "--output-format",
                "text",
                "--permission-mode",
                "plan",
            ]
            .map(OsString::from),
        );
        // 同上：headless 调用不加载项目 .claude/settings.json 里的 MCP servers
        // （实测 HIS 挂着 oracle-db，门调用会无谓拉起 uvx + 数据库连接）。
        args.push("--strict-mcp-config".into());
        if !allow_read_tools {
            args.extend(["--tools", ""].map(OsString::from));
        }
        args.push("--no-session-persistence".into());
        if let Some(model) = model {
            args.push("--model".into());
            args.push(model.into());
        }
        if let Some(effort) = reasoning_effort {
            args.push("--effort".into());
            args.push(effort.into());
        }
    }
    args
}

/// 可写版 headless agent 参数（用于 Agent 直接修改文件，如解决合并冲突）。
fn build_headless_writer_agent_args(
    agent: &str,
    prompt: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    if agent == "codex" {
        args.extend(
            [
                "exec",
                "--sandbox",
                "workspace-write",
                "-a",
                "on-request",
                "--ephemeral",
                "-c",
                "approval_policy=\"never\"",
            ]
            .map(OsString::from),
        );
        if let Some(model) = model {
            args.push("--model".into());
            args.push(model.into());
        }
        if let Some(effort) = reasoning_effort {
            args.push("-c".into());
            args.push(
                format!(
                    "model_reasoning_effort={}",
                    toml::Value::String(effort.to_string())
                )
                .into(),
            );
        }
        args.push(prompt.into());
    } else {
        args.extend(
            [
                "-p",
                prompt,
                "--output-format",
                "text",
                "--permission-mode",
                "acceptEdits",
            ]
            .map(OsString::from),
        );
        args.push("--no-session-persistence".into());
        if let Some(model) = model {
            args.push("--model".into());
            args.push(model.into());
        }
        if let Some(effort) = reasoning_effort {
            args.push("--effort".into());
            args.push(effort.into());
        }
    }
    args
}

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
pub(crate) async fn run_headless_agent_with_timeout(
    agent: &str,
    project_path: &str,
    prompt: &str,
    timeout_dur: Duration,
    allow_read_tools: bool,
    reasoning_effort_override: Option<&str>,
) -> Result<Output, String> {
    let settings = crate::app_settings::load_settings_internal();
    let launch = crate::app_settings::get_agent_launch_spec_from_settings(&settings, agent);
    let light = crate::app_settings::get_light_model_config_from_settings(&settings, agent);
    let login_env: Vec<(String, String)> = crate::app_settings::get_login_shell_env().to_vec();

    let mut cmd = tokio::process::Command::new(&launch.program);
    crate::subprocess::configure_background_tokio_command(&mut cmd);
    let reasoning = reasoning_effort_override.or(light.reasoning_effort.as_deref());
    cmd.args(build_headless_agent_args(
        agent,
        prompt,
        light.model.as_deref(),
        reasoning,
        allow_read_tools,
    ));
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
            if let Some(pid) = child.id() {
                kill_process_tree(pid);
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("agent 调用超时（{} 秒）", timeout_dur.as_secs()));
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
    let output = run_headless_agent_with_timeout(
        &agent,
        &project_path,
        &full_prompt,
        NAMING_TIMEOUT,
        false,
        None,
    )
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

/// 技能里承载沉淀契约的参考文件（相对技能目录）。
pub(crate) const SEDIMENTATION_CONTRACT_REFERENCE: &str = "references/sedimentation.md";
/// 技能里承载「条目写入模板」的参考文件（相对技能目录）。
///
/// 该文件**正文即模板本体**（不套代码围栏、不写散文），让写入格式有唯一事实源、
/// 随 hub 热更新；散文说明住在 `sedimentation.md` 与 `module-card-guide.md`。
pub(crate) const SEDIMENTATION_TEMPLATE_REFERENCE: &str = "references/sedimentation-template.md";
/// 承载契约的技能名。
pub(crate) const SEDIMENTATION_CONTRACT_SKILL: &str = "knowledge-graph";

/// 条目写入模板的内嵌回退（技能库未配置 / 模板读不到 / 模板不合法时使用）。
///
/// 必须与 SkillHub 的模板等价，否则离线环境下写出的格式会与在线不一致。
/// 对齐 `module-card-guide.md` 的「来源内联」写法（人工条目既有风格），
/// 并保留 `kg:` 标记行以便区分自动/人工条目（回滚与审计依赖它）。
pub(crate) const SEDIMENTATION_ENTRY_TEMPLATE_FALLBACK: &str =
    "- {content}（来源：{evidence}，{date}）\n  <!-- kg:{trace} -->";

/// 渲染一条知识条目的写入文本（按模板替换占位符）。
///
/// `trace` 为空时，含 `{trace}` 的整行会被丢弃——保持「无标记」的既有行为，
/// 而不是写出 `<!-- kg: -->` 这样的空标记。
pub(crate) fn render_entry_template(
    template: &str,
    content: &str,
    evidence: &str,
    date: &str,
    trace: &str,
) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in template.lines() {
        if trace.is_empty() && line.contains("{trace}") {
            continue;
        }
        out.push(
            line.replace("{date}", date)
                .replace("{content}", content)
                .replace("{evidence}", evidence)
                .replace("{trace}", trace),
        );
    }
    out.join("\n")
}

/// 校验技能模板可用；不合格时由调用方回退内嵌默认值（返回 `Err` 而非 panic，
/// 沉淀流程不因模板问题中断）。
///
/// 三条硬约束：
/// - 四个占位符齐备（缺任一则渲染会漏字段）；
/// - 任何行不得以 `## ` 开头（否则条目会伪造出 section 标题，破坏卡片结构）；
/// - 渲染后行数 ≤ 5（防模板失控膨胀卡片）。
pub(crate) fn validate_entry_template(template: &str) -> Result<(), String> {
    for placeholder in ["{date}", "{content}", "{evidence}", "{trace}"] {
        if !template.contains(placeholder) {
            return Err(format!("模板缺少占位符 {placeholder}"));
        }
    }
    if template.lines().any(|line| line.starts_with("## ")) {
        return Err("模板行不得以 `## ` 开头（会伪造 section 标题）".to_string());
    }
    let line_count = template.lines().count();
    if line_count > 5 {
        return Err(format!("模板行数 {line_count} 超出上限 5"));
    }
    Ok(())
}

/// 取条目写入模板：优先技能库热更新版本，读不到 / 不合法时回退内嵌默认。
///
/// 与 [`sedimentation_contract_block`] 同一开关思路——格式的单一事实源在 SkillHub，
/// 但 Nezha 必须能在 hub 缺失时独立工作。
pub(crate) fn sedimentation_entry_template() -> String {
    if let Some(path) = crate::skills::read_skill_reference_path(
        SEDIMENTATION_CONTRACT_SKILL,
        SEDIMENTATION_TEMPLATE_REFERENCE,
    ) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() && validate_entry_template(trimmed).is_ok() {
                return trimmed.to_string();
            }
        }
    }
    SEDIMENTATION_ENTRY_TEMPLATE_FALLBACK.to_string()
}
/// 承载契约文件路径的环境变量名（由 `knowledge::knowledge_env_for_project` 注入）。
pub(crate) const SEDIMENTATION_CONTRACT_ENV: &str = "NEZHA_KNOWLEDGE_SEDIMENTATION_CONTRACT";

/// 取知识沉淀产出契约块（供拼进任务提示词）。
///
/// 首选**技能指针**：契约正文的唯一事实源是 SkillHub 的
/// `knowledge-graph/references/sedimentation.md`，任务提示词只说明「按技能契约产出」
/// 并给出该文件的绝对路径，由 agent 自行按需读取——省下每任务约 1.9KB 的 prompt
/// 体积，且读到的永远是 hub 当前版本（改技能即可热更新、无需发版 Nezha）。
///
/// 技能库未配置 / 该文件读不到时回退到内嵌常量 [`SESSION_SEDIMENTATION_CONTRACT_FALLBACK`]，
/// 避免离线或 hub 未同步时沉淀彻底不可用。
pub fn sedimentation_contract_block() -> String {
    if crate::skills::read_skill_reference_path(
        SEDIMENTATION_CONTRACT_SKILL,
        SEDIMENTATION_CONTRACT_REFERENCE,
    )
    .is_some()
    {
        SEDIMENTATION_CONTRACT_POINTER.to_string()
    } else {
        SESSION_SEDIMENTATION_CONTRACT_FALLBACK.to_string()
    }
}

/// 技能指针块：只点明「按哪份契约、契约文件在哪、产物落在哪」，不复述 schema。
///
/// 正文（字段表、section 清单、提取标准）刻意不内联——两处维护必然漂移；schema 由
/// 契约文件承载，读它就够。产物路径仍在此写死一份，因为「写到哪」是 Nezha 侧的
/// 硬约定（`knowledge.rs` 按 `$NEZHA_TASK_ID` 读回），说清楚能省掉一次误写。
const SEDIMENTATION_CONTRACT_POINTER: &str = r#"知识沉淀产出（必做）：任务收尾时，按 `knowledge-graph` 技能的沉淀契约产出本次会话中确认的、
长期有效的项目知识——契约正文（产出物 schema、提取标准、可写 section 清单、如何表态「本次无新知识」）
在文件 `$NEZHA_KNOWLEDGE_SEDIMENTATION_CONTRACT` 里，动手前先读它。

产物写到 `.nezha/drafts/$NEZHA_TASK_ID/knowledge.json`（与该任务的其它草稿同目录；
不要写到别处、不要用其它文件名）。确实没有新知识时**也必须写这个文件**并显式表态
（`{"version":1,"skipped":true,"skipReason":"…"}`），不要留空、不要省略——文件缺失会被判为漏产出。
只需写入一次；Nezha 消费后可能清理该文件，若随后发现文件消失属正常，不要重复落盘。"#;

/// 会话内知识沉淀**产出契约**：主 agent 在任务收尾时按此写
/// `.nezha/drafts/$NEZHA_TASK_ID/knowledge.json`，随后由 Nezha 侧四层质量门判定并写入图谱。
///
/// 描述**产出物格式与提取标准**（写什么文件、什么字段、什么值得提、如何表态「本次无新知识」）。
///
/// **这是回退文本**：首选是「技能指针 + 契约文件路径」（见 [`sedimentation_contract_block`]），
/// 改技能即可热更新、无需发版；本常量仅在技能库未配置 / 读不到该文件时兜底，
/// 避免沉淀彻底不可用。因此它必须**自带完整正文**（不能只写指针，否则回退后 agent
/// 拿不到 schema）。
///
/// 任务 id 一律取环境变量 `$NEZHA_TASK_ID`（由 Nezha 注入），不让 agent 自造目录名。
pub const SESSION_SEDIMENTATION_CONTRACT_FALLBACK: &str = r#"知识沉淀产出（必做）：任务收尾时，按下面的格式把本次会话中确认的、长期有效的项目知识写入
`.nezha/drafts/$NEZHA_TASK_ID/knowledge.json`（`$NEZHA_TASK_ID` 是本次任务 id，由 Nezha 注入环境变量，
不要自造目录名；与该任务的其它草稿同目录，不要写到别处、不要用其它文件名）。

- 有知识要沉淀时：
{
  "version": 1,
  "skipped": false,
  "candidates": [
    { "module": "<目标图谱中的模块名>", "section": "<该卡片中已存在的段落标题>",
      "content": "<一句话知识>", "evidence": "<可定位的依据>", "confidence": "confirmed" }
  ]
}
- 确实没有新知识时**也必须写这个文件**，用显式标记表态（不要留空、不要省略）：
{ "version": 1, "skipped": true, "skipReason": "<为什么本次没有新知识>" }

提取标准（按价值排序）：业务规则/已知坑 > 关键实体/数据表映射 > 模块职责修正/依赖补充。
排除图谱已有内容；排除纯实现细节（写"代码怎么写的"没价值，要写"项目怎么运行的"）。
与图谱已有内容矛盾时**不要提取该条**（孰对孰错无法在此判定，留给人工）。

字段要求：content 必须是单行（含换行会被拒收）；evidence 要能定位（推荐 `文件路径:行号`）；
confidence 只填 confirmed（可自动写入）或 pending（仅供人工参考，不会自动写入）。
section 必须是该卡片中已存在的标题，且限于：职责 / 关键实体与数据表 / 依赖与相关模块 /
业务规则与已知坑 / UI界面与入口（`定位` 由扫描生成、`验证记录` 是流水记录，均不接受沉淀）。
只需写入一次；Nezha 消费后可能清理该文件，若随后发现文件消失属正常，不要重复落盘。"#;

// ── 多议题联合方案（Plan）指令：讨论定稿 / 按方案执行 ────────────────────────

/// 方案讨论的流程与产物契约由 `yunxiao-plan-discussion` 技能维护（SkillHub 统一管理，
/// 改技能免重编）；此处只注入技能引用与**任务参数**（提问技能、议题类型、plan.md / deps.json
/// 绝对路径）。流程散文一律不内联——两处维护必然漂移，且历史上内联的覆盖指令与技能正文
/// 互相矛盾（技能写「一次只问一个问题」、注入指令写「不要逐条」），导致提问节律间歇失效。
const PLAN_DISCUSSION_SKILL: &str = "yunxiao-plan-discussion";

/// 议题执行的流程与产物契约技能（SkillHub 维护，Nezha 只传参数）。
/// 一个技能覆盖两种「方案来源」：已定稿（讨论产出，按方案直接执行）与自动生成
/// （由议题整理，可按需先澄清/取证）——两者的产物契约与执行动作一致。
const ISSUE_EXECUTION_SKILL: &str = "yunxiao-issue-execution";

/// 默认提问技能：逐条盘问（一次只问一个问题）。技能正文按任务参数取值选择节律。
const GRILLING_SKILL: &str = "grilling";

/// 批量盘问技能（测试技能，SkillHub `batch-grill-me`）：把设计树当前「前沿」的全部问题
/// 一轮一次性抛出。应用设置开关开启时作为「提问技能」参数传入，由技能正文决定节律。
const BATCH_GRILL_SKILL: &str = "batch-grill-me";

/// 按应用设置选择本次会话的提问技能。取值的语义与节律由被引用技能正文定义，
/// Nezha 只负责挑选——不再注入与技能正文并列的流程散文。
fn question_skill(batch_grill: bool) -> &'static str {
    if batch_grill {
        BATCH_GRILL_SKILL
    } else {
        GRILLING_SKILL
    }
}

/// 议题类型参数（是否要求本任务做 Bug 根因取证）。
/// 已定稿方案的执行任务不做取证——根因与方案已在讨论阶段确定，执行阶段重跑会与方案打架。
fn issue_kind(has_bug: bool, from_plan: bool) -> &'static str {
    if from_plan {
        "已定稿方案（根因与修改方案已在讨论阶段确定，本任务不再做 Bug 根因取证）"
    } else if has_bug {
        "含 Bug 缺陷类议题（按技能「Bug 根因诊断」取证后再产出）"
    } else {
        "不含 Bug 类议题（可跳过技能中的「Bug 根因诊断」）"
    }
}

/// 方案讨论任务的完整指令：技能指针 + 任务参数（提问技能 / 议题类型 / 落盘绝对路径）。
pub fn plan_discussion_instructions(
    plan_md_path: &str,
    deps_json_path: &str,
    has_bug: bool,
    batch_grill: bool,
) -> String {
    format!(
        "## 工作流程\n请读取并遵循 `{skill}` 技能，按其中的流程与产物契约完成本次讨论。\n\n\
## 任务参数\n\
- 提问技能：`{question_skill}`\n\
- 议题类型：{issue_kind}\n\
- 方案文档（绝对路径，技能中的落盘指令以此路径为准）：{plan_md_path}（目录不存在就先创建）\n\
- 依赖文件（绝对路径，schema 与产出要求见技能「方案依赖文件」节）：{deps_json_path}",
        skill = PLAN_DISCUSSION_SKILL,
        question_skill = question_skill(batch_grill),
        issue_kind = issue_kind(has_bug, false),
        plan_md_path = plan_md_path,
        deps_json_path = deps_json_path,
    )
}

/// 前端拼「发起讨论」prompt 时调用。has_bug 由方案议题快照的类别推导（categoryId == bug）。
#[tauri::command]
pub async fn get_plan_discussion_instructions(
    project_path: String,
    plan_id: String,
    has_bug: bool,
) -> Result<String, String> {
    let plan_id = plan_id.trim().to_string();
    if plan_id.is_empty() || plan_id.contains('/') || plan_id.contains('\\') || plan_id.contains("..")
    {
        return Err("非法的方案 ID".to_string());
    }
    let project_path_for_dir = project_path;
    let paths = tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
        let canonical = std::path::Path::new(&project_path_for_dir)
            .canonicalize()
            .map_err(|e| format!("项目路径无效: {e}"))?;
        let dir = crate::storage::plan_dir(&canonical, &plan_id);
        let normalize = |path: std::path::PathBuf| {
            path.to_string_lossy().into_owned().replace("\\\\?\\", "")
        };
        Ok((
            normalize(dir.join("plan.md")),
            normalize(dir.join("deps.json")),
        ))
    })
    .await
    .map_err(|e| format!("方案目录解析线程错误: {e}"))??;
    let batch_grill = batch_grill_enabled().await;
    Ok(plan_discussion_instructions(
        &paths.0,
        &paths.1,
        has_bug,
        batch_grill,
    ))
}

/// 读取应用级「批量盘问（测试技能）」开关；读盘放到阻塞线程，避免挡住异步运行时。
async fn batch_grill_enabled() -> bool {
    tokio::task::spawn_blocking(|| crate::app_settings::load_settings_internal().batch_grill_enabled)
        .await
        .unwrap_or(false)
}

/// 议题执行任务的完整指令：**技能指针 + 任务参数**。
///
/// 流程（澄清与取证 / knowledge-graph 认知 / implement 执行 / 冲突停下）与产物契约
/// （discussion.md 三段结构、价值评分、补录议题）全部由 `yunxiao-issue-execution`
/// 技能承载——改技能即可热更新，Nezha 只传本次会话的动态参数。
///
/// `from_plan`（方案来源）：true = 按已定稿方案执行（方案节由前端内联，方案全文路径亦在
/// 提示词里），false = 议题自动整理成方案后执行。
///
/// Bug 路径优先于 clarify_first（Bug 的澄清由 diagnosing-bugs 取证循环承担，两者叠加会
/// 互相打架），故先把 clarify_first 归零再决定「先澄清」与「提问技能」参数。
pub fn issue_execution_instructions(
    task_id: &str,
    has_bug: bool,
    clarify_first: bool,
    batch_grill: bool,
    from_plan: bool,
) -> String {
    // 已定稿方案不重复盘问：方案已由讨论定稿（讨论阶段已问过），执行阶段再澄清会与方案打架。
    let clarify = clarify_first && !has_bug && !from_plan;
    format!(
        "## 工作流程\n请读取并遵循 `{skill}` 技能，按其中的流程与产物契约完成本次改动。\n\n\
## 任务参数\n\
- 方案来源：{plan_source}\n\
- 议题类型：{issue_kind}\n\
- 先澄清：{clarify}\n\
- 提问技能：`{question_skill}`\n\
- 工作产物目录（相对项目根）：.nezha/drafts/{task_id}/",
        skill = ISSUE_EXECUTION_SKILL,
        plan_source = if from_plan {
            "已定稿（讨论产出；修改方案见提示词的「本议题方案」节，方案全文路径亦在提示词里）"
        } else {
            "自动生成（由议题原文整理，未经过讨论；本议题内容即本次改动的 spec）"
        },
        issue_kind = issue_kind(has_bug, from_plan),
        clarify = if clarify { "是" } else { "否" },
        question_skill = question_skill(clarify && batch_grill),
        task_id = task_id,
    )
}

/// 方案执行任务（已定稿方案 → 按方案逐议题执行）。
pub fn plan_execution_instructions(task_id: &str) -> String {
    issue_execution_instructions(task_id, false, false, false, true)
}

/// 前端在「立即运行」方案执行待办前调用（prompt 已在生成待办时定稿，此命令仅供预览/重建）。
#[tauri::command]
pub async fn get_plan_execution_instructions(task_id: String) -> Result<String, String> {
    Ok(plan_execution_instructions(&task_id))
}

// ── 直接执行链路（跳过讨论，议题即 spec）──────────────────────────────────────

/// 直接执行任务（议题自动整理成方案 → 执行）；见 [`issue_execution_instructions`]。
pub fn direct_execution_instructions(
    task_id: &str,
    has_bug: bool,
    clarify_first: bool,
    batch_grill: bool,
) -> String {
    issue_execution_instructions(task_id, has_bug, clarify_first, batch_grill, false)
}

/// 直接执行链路：议题列表 / 绑定待办「直接开始」时由前端调用组装 prompt。
#[tauri::command]
pub async fn get_direct_execution_instructions(
    task_id: String,
    has_bug: Option<bool>,
    clarify_first: Option<bool>,
) -> Result<String, String> {
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() || task_id.contains('/') || task_id.contains('\\') || task_id.contains("..")
    {
        return Err("非法的任务 ID".to_string());
    }
    let batch_grill = batch_grill_enabled().await;
    Ok(direct_execution_instructions(
        &task_id,
        has_bug.unwrap_or(false),
        clarify_first.unwrap_or(false),
        batch_grill,
    ))
}

/// 合并代码审查规则（作为可维护的 `merge-code-review` Skill 的默认文本；前端取用并拼进
/// 审查任务的 prompt，供 Agent 逐项校验批次分支相对 base 的改动）。
const MERGE_CODE_REVIEW_INSTRUCTIONS: &str = r#"你是合并代码审查助手。请对给定批次的改动（相对 base 分支 base...branch 的 diff）做代码审查校验。

必须逐项检查并按固定格式输出结果：
1. 命名规范：分支 / commit 是否符合约定。
2. 提交信息是否带 #议题 编号。
3. 是否引入合并冲突风险。
4. 调试残留、临时文件、日志输出。
5. 改动是否超范围（是否只涉及本批议题）。
6. 依赖 / 引用是否完整。
7. 破坏性变更 / 数据库变更是否有说明。

输出要求：只输出结构化 JSON 数组，用 <REVIEW> 与 </REVIEW> 包裹，标签外不要输出其它内容。每一项：
{"rule": "规则名", "status": "pass|warn|fail", "path": "文件相对路径", "startLine": 数字, "endLine": 数字, "message": "原因/建议"}
status 取值：pass 通过；warn 需修改；fail 阻止合并。"#;

/// 返回合并代码审查规则文本（供前端拼入审查任务 prompt，以及规则维护入口查看）。
#[tauri::command]
pub fn get_merge_code_review_instructions() -> Result<String, String> {
    Ok(MERGE_CODE_REVIEW_INSTRUCTIONS.to_string())
}

/// 合并代码审查的单项结果（对应 Skill 约定的 JSON 输出结构）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReviewFinding {
    pub rule: String,
    pub status: String,
    #[serde(default)]
    pub path: String,
    #[serde(rename = "startLine", default)]
    pub start_line: i32,
    #[serde(rename = "endLine", default)]
    pub end_line: i32,
    pub message: String,
}

fn extract_review_findings(stdout: &str) -> Result<Vec<ReviewFinding>, String> {
    const OPEN: &str = "<REVIEW>";
    const CLOSE: &str = "</REVIEW>";
    if let Some(close_pos) = stdout.rfind(CLOSE) {
        let prefix = &stdout[..close_pos];
        if let Some(open_start) = prefix.rfind(OPEN) {
            let inner = &prefix[open_start + OPEN.len()..];
            let trimmed = inner.trim();
            if !trimmed.is_empty() {
                return serde_json::from_str(trimmed).map_err(|e| format!("解析审查结果失败: {e}"));
            }
        }
    }
    serde_json::from_str(stdout.trim()).map_err(|e| format!("解析审查结果失败: {e}"))
}

const REVIEW_TIMEOUT: Duration = Duration::from_secs(180);

/// 运行 Agent 对 base...branch 的改动做合并代码审查，返回结构化结果（path/startLine 供定位）。
#[tauri::command]
pub async fn run_merge_code_review(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
    base_branch: String,
    branch: String,
    agent: String,
) -> Result<Vec<ReviewFinding>, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {agent}"));
    }
    if base_branch.trim().is_empty() || branch.trim().is_empty() {
        return Err("baseBranch and branch are required".to_string());
    }
    let cwd = crate::git::resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let project = project_path.clone();
    let wt = worktree_path.clone();
    tokio::task::spawn_blocking(move || {
        crate::git::ensure_path_under_worktrees_root(&project, &cwd, &wt)
    })
    .await
    .map_err(|e| format!("校验线程错误: {e}"))??;

    // 让 Agent 在图内自行读取 diff（它有 git 权限），再逐项校验。
    let prompt = format!(
        "{}\n\n──── 本次需审查的改动 ────\n请先在当前工作区运行 `git diff {base_branch}...{branch}` 查看，再按上述规则逐项校验并输出 <REVIEW> JSON。",
        MERGE_CODE_REVIEW_INSTRUCTIONS
    );
    let output = run_headless_agent_with_timeout(
        &agent,
        &worktree_path,
        &prompt,
        REVIEW_TIMEOUT,
        true,
        None,
    )
    .await?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    extract_review_findings(&String::from_utf8_lossy(&output.stdout))
}

/// 可写版 headless agent（Agent 会在 cwd 直接改文件，如解决冲突；带超时与 kill_on_drop）。
async fn run_headless_writer_agent_with_timeout(
    agent: &str,
    cwd: &str,
    prompt: &str,
    timeout_dur: Duration,
) -> Result<Output, String> {
    let settings = crate::app_settings::load_settings_internal();
    let launch = crate::app_settings::get_agent_launch_spec_from_settings(&settings, agent);
    let light = crate::app_settings::get_light_model_config_from_settings(&settings, agent);
    let login_env: Vec<(String, String)> = crate::app_settings::get_login_shell_env().to_vec();

    let mut cmd = tokio::process::Command::new(&launch.program);
    crate::subprocess::configure_background_tokio_command(&mut cmd);
    cmd.args(build_headless_writer_agent_args(
        agent,
        prompt,
        light.model.as_deref(),
        light.reasoning_effort.as_deref(),
    ));
    cmd.current_dir(cwd);
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
            if let Some(pid) = child.id() {
                kill_process_tree(pid);
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("解决冲突超时（{} 秒）", timeout_dur.as_secs()));
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

/// 运行 Agent 在工作区解决合并冲突（草稿式：Agent 修改+add，之后由前端确认才 commit）。
#[tauri::command]
pub async fn run_conflict_resolution(
    project_path: String,
    repo_path: Option<String>,
    worktree_path: String,
    agent: String,
) -> Result<String, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {agent}"));
    }
    let cwd = crate::git::resolve_repo_path(&project_path, repo_path.as_deref()).await?;
    let project = project_path.clone();
    let wt = worktree_path.clone();
    tokio::task::spawn_blocking(move || {
        crate::git::ensure_path_under_worktrees_root(&project, &cwd, &wt)
    })
    .await
    .map_err(|e| format!("校验线程错误: {e}"))??;

    let ctx = crate::git::get_conflict_context(
        project_path.clone(),
        repo_path.clone(),
        worktree_path.clone(),
    )
    .await?;
    if ctx.conflicted_files.is_empty() {
        return Ok("没有需要解决的冲突".to_string());
    }
    let output = run_headless_writer_agent_with_timeout(
        &agent,
        &worktree_path,
        &ctx.prompt,
        Duration::from_secs(300),
    )
    .await?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    // 校验冲突是否已解决：仍有冲突则返回剩余文件。
    let status = crate::git::run_git(&worktree_path, &["status", "--porcelain"])?;
    let remaining = crate::git::parse_conflicted_files(&status.stdout);
    if !remaining.is_empty() {
        return Err(format!("仍有冲突未解决: {}", remaining.join(", ")));
    }
    Ok(format!(
        "已解决 {} 个冲突文件，等你确认后提交",
        ctx.conflicted_files.len()
    ))
}

// ── 云效回写汇总生成（写回闭环）──────────────────────────────────────────────

const WRITEBACK_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_FACTS_CHARS: usize = 8000;

const WRITEBACK_PROMPT_TEMPLATE: &str = r#"你是云效议题回写助手。基于下面的事实（议题信息、修改分支、Git 提交与变更统计），为云效议题撰写两条评论：一条面向开发人员，一条面向测试人员。

规则：
1. 只依据给定事实，不编造事实里没有的信息（commit、文件、结论都不许虚构）。
2. 输出两条评论（Markdown），分别用固定标签包裹，标签外不要输出任何内容：
   - 开发向评论：<DEV_SUMMARY>...</DEV_SUMMARY>，直接回写本次修改方案：
     - 基于提交与变更统计忠实呈现方案本身：改了什么、怎么改（关键改动点与实现方式，可引用 commit 短号/文件）；
     - 不要套用其他模板结构，不要在方案之外额外扩写，事实里没有的内容不要补。
   - 测试向评论：<TEST_SUMMARY>...</TEST_SUMMARY>，面向测试人员，首行固定为标题 `## 影响范围与测试指引`，其后为三个固定字段；**字段名必须加粗**（与开发向评论的小标题一致），不要用列表符号：
     - `**修改分支**`：直接使用下方给定的「修改分支」，不要改动、不要编造；
     - `**修改文件**`：受影响的项目/工程名（从变更统计的文件路径归纳，如 Nto.His.Register.UI），多个用顿号分隔；
     - `**测试步骤**`：给出可执行的测试步骤与回归点。
3. 每条评论语言与议题标题一致（中文议题输出中文），各 200-500 字，控制在 12 行以内。
4. 某条若缺少事实支撑，就写「（无）」占位，不要编造。

──── 议题 ────
编号：{serial_number}
标题：{task_name}

──── 修改分支 ────
{branch}

──── 关联提交 ────
{commits}

──── 变更统计 ────
{diff_stat}
"#;

/// 收集回写汇总的事实骨架（当前分支 + commit 列表 + 变更统计），git 数据保证不幻觉。
fn gather_writeback_facts(cwd: &str, base_branch: Option<&str>) -> (String, String, String) {
    let run = |args: &[&str]| -> Option<String> {
        let mut cmd = std::process::Command::new("git");
        cmd.args(args).current_dir(cwd);
        crate::subprocess::configure_background_command(&mut cmd);
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    let branch = run(&["rev-parse", "--abbrev-ref", "HEAD"])
        .filter(|b| !b.is_empty())
        .or_else(|| base_branch.map(str::to_string))
        .unwrap_or_default();
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
    (branch, truncate(commits), truncate(diff_stat))
}

/// 回写「修改文件」字段的确定性统计上限（超出说明仓库异常，做提示性截断）。
const MAX_MODIFIED_FILE_LABELS: usize = 50;

/// 确定性收集本次改动涉及的工程名（三源并集，fix #106）：
/// 1. 已提交变更 `git diff --name-only {base}...HEAD`；
/// 2. 已暂存 + 未暂存变更 `git diff --name-only HEAD`；
/// 3. 未跟踪文件 `git status --porcelain`（`??` 行）。
///
/// 现状是「修改文件」由 LLM 凭会话记忆/diff stat 归纳，五处系统性漏报
/// （草稿过期、未提交变更不在 diff 事实里、plan.md 预判、base 缺失、8000 字符截断）。
/// 本函数给回写时刻一个不依赖 LLM 的事实基线；git 全部不可用时返回空集（字段保持原样）。
fn collect_writeback_project_names(cwd: &str, base_branch: Option<&str>) -> Vec<String> {
    let run = |args: &[&str]| -> Option<String> {
        let mut cmd = std::process::Command::new("git");
        cmd.args(args).current_dir(cwd);
        crate::subprocess::configure_background_command(&mut cmd);
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    };

    // 已提交：base 缺失时回落最近 20 条提交涉及的文件（口径与 commits 事实一致），
    // 避免非 worktree 任务 baseBranch 为 undefined 时已提交变更整体缺失。
    let committed = base_branch
        .and_then(|b| run(&["diff", "--name-only", &format!("{b}...HEAD")]))
        .or_else(|| run(&["diff", "--name-only", "@{20}..HEAD"]))
        .unwrap_or_default();
    // 已暂存 + 未暂存（对工作区与 HEAD 比较；重命名输出 "to\tpath"，取新路径）。
    let unstaged = run(&["diff", "--name-only", "HEAD"]).unwrap_or_default();
    // 未跟踪：porcelain 里 `?? path`；其余状态行已由上面两路覆盖。
    let untracked = run(&["status", "--porcelain"])
        .map(|out| {
            out.lines()
                .filter(|line| line.starts_with("??"))
                .filter_map(|line| line.get(3..))
                .map(str::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    let mut paths: Vec<String> = Vec::new();
    for chunk in [committed, unstaged, untracked] {
        for line in chunk.lines() {
            let path = line.split('\t').next_back().unwrap_or(line).trim();
            if !path.is_empty() {
                paths.push(path.to_string());
            }
        }
    }
    derive_project_names(&paths)
}

/// 把改动文件路径归并成工程名：默认取一级目录（`src/a/b.ts` → `src`），
/// 根目录散文件保留文件名。同名去重后按字母序稳定输出，超上限截断加提示。
fn derive_project_names(paths: &[String]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for path in paths {
        let name = match path.split(['/', '\\']).next() {
            Some(first) if first.is_empty() => path.to_string(),
            // 一级目录即整个路径（根目录散文件）→ 保留文件名本身。
            Some(first) if first == path => path.to_string(),
            Some(first) => first.to_string(),
            None => continue,
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.sort();
    if names.len() > MAX_MODIFIED_FILE_LABELS {
        names.truncate(MAX_MODIFIED_FILE_LABELS);
        names.push(format!("…等 {} 项（已截断）", names.len()));
    }
    names
}

/// 把确定性工程名清单写进测试向评论的 `**修改文件**` 字段（幂等）：
/// 命中该字段行则替换其值为「A、B、C」；无该字段的评论（草稿缺失字段）不动。
/// 确定性统计为空集时保持原文——宁缺毋错，不用空值覆盖 LLM 可能正确的归纳。
fn apply_deterministic_modified_files(test_comment: &str, project_names: &[String]) -> String {
    if project_names.is_empty() || test_comment.trim().is_empty() {
        return test_comment.to_string();
    }
    let joined = project_names.join("、");
    let mut replaced = false;
    let lines: Vec<String> = test_comment
        .lines()
        .map(|raw| {
            let trimmed = raw.trim_start();
            let stripped = trimmed
                .strip_prefix("- ")
                .or_else(|| trimmed.strip_prefix("* "))
                .or_else(|| trimmed.strip_prefix("+ "))
                .map(str::trim_start)
                .unwrap_or_else(|| trimmed.trim_start_matches('#').trim_start());
            let body = stripped.strip_prefix("**修改文件**").map(|after| {
                after
                    .strip_prefix("**")
                    .unwrap_or(after)
                    .trim_start_matches(['：', ':'])
            });
            match body {
                Some(_) => {
                    replaced = true;
                    // 保留原行的非字段前缀（列表符 `- ` 等），只替换字段内容本身。
                    let prefix_len = raw.find(stripped).unwrap_or(0);
                    format!("{}**修改文件**：{}", &raw[..prefix_len], joined)
                }
                None => raw.to_string(),
            }
        })
        .collect();
    if replaced {
        lines.join("\n")
    } else {
        test_comment.to_string()
    }
}

fn build_writeback_prompt(
    serial_number: &str,
    task_name: &str,
    branch: &str,
    commits: &str,
    diff_stat: &str,
) -> String {
    WRITEBACK_PROMPT_TEMPLATE
        .replace("{serial_number}", serial_number)
        .replace("{task_name}", task_name)
        .replace(
            "{branch}",
            if branch.trim().is_empty() {
                "（无）"
            } else {
                branch.trim()
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

/// 提取 `<open>...</close>` 内文本（取最后一对标签，避开 prompt 回显）。
fn extract_tagged_block(stdout: &str, open: &str, close: &str) -> Option<String> {
    if let Some(close_pos) = stdout.rfind(close) {
        let prefix = &stdout[..close_pos];
        if let Some(open_start) = prefix.rfind(open) {
            let inner = &prefix[open_start + open.len()..];
            let trimmed = inner.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 云效回写草稿：开发向 / 测试向 / 评分三条评论。
/// score_comment 为空表示草稿没有独立评分内容（旧格式草稿评分仍在 dev_comment 正文里）。
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YunxiaoWritebackDraft {
    pub dev_comment: String,
    pub test_comment: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub score_comment: String,
}

/// discussion.md 中「影响范围与测试」小节标题前缀。
const TEST_SECTION_HEADER: &str = "## 影响范围与测试";

/// 测试向评论的固定字段标签——与开发向评论的小标题同位，需要加粗显示。
const TEST_COMMENT_FIELD_LABELS: [&str; 3] = ["修改分支", "修改文件", "测试步骤"];

/// 把测试向评论的固定字段标签统一加粗（`- 修改分支：x` / `### 修改分支` / `修改分支：x`
/// 均归一为 `**修改分支**：x`），与开发向评论的小标题一致。
///
/// 云效富文本只在普通段落内识别 `**…**`（列表项、标题行里的加粗标记会被 `strip_markdown_line`
/// 剥掉），因此这里同时去掉行首的列表 / 标题前缀，落成「加粗标签 + 原内容」的段落。
/// 已是 `**修改分支**：` 写法的行保持幂等，不会被重复包裹。
fn bolden_test_comment_fields(text: &str) -> String {
    /// 识别单个字段标签（兼容已加粗写法），命中则返回归一后的行。
    fn normalize_line(body: &str) -> Option<String> {
        let (bold_wrapped, rest) = match body.strip_prefix("**") {
            Some(rest) => (true, rest),
            None => (false, body),
        };
        for label in TEST_COMMENT_FIELD_LABELS {
            let Some(after) = rest.strip_prefix(label) else {
                continue;
            };
            // 已加粗时吞掉闭合的 `**`，避免生成 `**修改分支****：`。
            let after = if bold_wrapped {
                after.strip_prefix("**").unwrap_or(after)
            } else {
                after
            };
            // 仅当标签后紧跟分隔符或行尾时替换，避免误伤「修改分支说明」这类正文。
            if after.is_empty() || after.starts_with('：') || after.starts_with(':') {
                return Some(format!("**{label}**{after}"));
            }
        }
        None
    }

    if text.trim().is_empty() {
        return text.to_string();
    }
    text.lines()
        .map(|raw| {
            let trimmed = raw.trim_start();
            // 去掉行首列表符（- / * / +）或标题符（#…），保留其后内容。
            let stripped = trimmed
                .strip_prefix("- ")
                .or_else(|| trimmed.strip_prefix("* "))
                .or_else(|| trimmed.strip_prefix("+ "))
                .map(str::trim_start)
                .unwrap_or_else(|| trimmed.trim_start_matches('#').trim_start());
            normalize_line(stripped).unwrap_or_else(|| raw.to_string())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 把 discussion.md 拆成（开发向评论，测试向评论）：
/// - 开发向 = 从开头到 `## 影响范围与测试` 之前（含 `## 修改方案汇总` 与 `## 价值评分`）；
/// - 测试向 = 从 `## 影响范围与测试` 到文档末尾。
/// 找不到测试小节时：整篇归开发向，测试向为空串（由前端补填/走 headless 再生成）。
/// 把 discussion.md 拆成（开发向，测试向，评分）三条评论。
/// - 测试向 = 从 `## 影响范围与测试` 到下一个 `## ` 标题或文末；
/// - 评分 = 从 `## 价值评分` 到下一个 `## ` 标题或文末（位置不限——agent 可能把评分
///   写在测试向之后（QHDK-30560），三分离后顺序自由，各自按标题切片互不干扰）；
/// - 开发向 = 其余内容；评分小节从 dev/test 两侧剥除，不再随任何一条正文评论重复发布。
fn split_discussion_into_comments(text: &str) -> (String, String, String) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new(), String::new());
    }
    let (before_test, test_half, after_test) = match trimmed.find(TEST_SECTION_HEADER) {
        Some(pos) => {
            let rest = &trimmed[pos..];
            let section = match rest.find("\n## ") {
                Some(next) => &rest[..next],
                None => rest,
            };
            // 评分小节常被 agent 排在测试向之后：它属于 rest 里 section 之后的剩余部分，
            // 不属于 before_test，单独作为评分搜索域。
            let after = match rest.find("\n## ") {
                Some(next) => rest[next + 1..].trim(),
                None => "",
            };
            (trimmed[..pos].trim(), section.trim(), after)
        }
        None => (trimmed, "", ""),
    };
    // 评分优先级：测试向之后的剩余段（QHDK-30560 排列）> 测试向段内 > 开发向段内。
    let score_section = crate::value_score::extract_value_score_section(after_test)
        .or_else(|| crate::value_score::extract_value_score_section(test_half))
        .or_else(|| crate::value_score::extract_value_score_section(before_test))
        .unwrap_or_default()
        .to_string();
    let dev = crate::value_score::strip_value_score_section(before_test);
    let test = crate::value_score::strip_value_score_section(test_half);
    (
        dev.trim().to_string(),
        test.trim().to_string(),
        score_section.trim().to_string(),
    )
}

/// AI 生成失败时的纯事实模板回退（用户仍可在预览中编辑后发布）。
fn build_fallback_draft(
    serial_number: &str,
    task_name: &str,
    branch: &str,
    commits: &str,
    diff_stat: &str,
) -> YunxiaoWritebackDraft {
    let mut dev = vec![
        format!("### 修改方案汇总（议题 {serial_number}）"),
        String::new(),
        format!("> 标题：{task_name}"),
        String::new(),
        "> （AI 汇总生成失败，以下为事实记录，可在预览中补充编辑）".to_string(),
        String::new(),
        "#### 关联提交".to_string(),
    ];
    if commits.trim().is_empty() {
        dev.push("（无）".to_string());
    } else {
        for line in commits.lines() {
            if let Some((hash, subject)) = line.split_once(' ') {
                dev.push(format!("- `{hash}` {subject}"));
            } else {
                dev.push(format!("- {line}"));
            }
        }
    }
    dev.push(String::new());
    dev.push("#### 变更统计".to_string());
    if diff_stat.trim().is_empty() {
        dev.push("（无）".to_string());
    } else {
        dev.push(format!("```\n{diff_stat}\n```"));
    }
    let test = format!(
        "## 影响范围与测试指引\n\n**修改分支**：{}\n**修改文件**：（无）\n**测试步骤**：请在预览中补充。",
        if branch.trim().is_empty() {
            "（无）"
        } else {
            branch.trim()
        },
    );
    YunxiaoWritebackDraft {
        dev_comment: dev.join("\n"),
        test_comment: test,
        score_comment: String::new(),
    }
}

/// 方案文档（plan.md）单议题节内的测试小节标题前缀（h3，与 `yunxiao-plan-discussion` 技能约定一致）。
const PLAN_TEST_SECTION_HEADER: &str = "### 影响范围与测试";

/// 把方案文档的单议题节拆成（开发向部分，测试向部分）：
/// - 开发向 = 从节开头到 `### 影响范围与测试` 之前（即「修改方案汇总」）；
/// - 测试向 = 从 `### 影响范围与测试` 到节末尾。
fn split_plan_section(text: &str) -> (String, String) {
    let trimmed = text.trim();
    if let Some(pos) = trimmed.find(PLAN_TEST_SECTION_HEADER) {
        (
            trimmed[..pos].trim().to_string(),
            trimmed[pos..].trim().to_string(),
        )
    } else {
        (trimmed.to_string(), String::new())
    }
}

/// 方案任务回写合并：开发向 = 方案节（修改方案汇总）；测试向 = 任务 drafts 的影响范围
/// （执行修订版）优先，回落方案节的测试小节；评分 = 任务 drafts 的评分小节，独立成评
/// （位置不限，QHDK-30560 排列也能取到；无评分时留空，回写命令回落从 dev 评论解析）。
fn merge_plan_writeback_draft(
    plan_section: &str,
    task_drafts: Option<&str>,
) -> YunxiaoWritebackDraft {
    let (plan_dev, plan_test) = split_plan_section(plan_section);
    let (_drafts_dev, drafts_test, score_comment) = task_drafts
        .map(split_discussion_into_comments)
        .unwrap_or_default();
    let test_comment = if drafts_test.trim().is_empty() {
        plan_test
    } else {
        drafts_test
    };
    // 方案节若内联了评分小节（旧方案文档格式），剥出为独立评分评论，避免重复发布。
    let score_comment = if score_comment.is_empty() {
        crate::value_score::extract_value_score_section(&plan_dev).map(str::to_string)
    } else {
        Some(score_comment)
    }
    .unwrap_or_default();
    YunxiaoWritebackDraft {
        dev_comment: crate::value_score::strip_value_score_section(&plan_dev)
            .trim()
            .to_string(),
        test_comment: bolden_test_comment_fields(&test_comment),
        score_comment,
    }
}

/// 生成云效回写草稿（开发向 + 测试向两条评论）：
/// - 草稿优先：会话中已落盘的 `discussion.md` 直接拆成两条（秒开）；
/// - 无草稿或 force=true 时：git 事实骨架（分支/提交/变更统计）+ headless Agent 生成两条
///   （开发向直接回写修改方案，测试向为修改分支/修改文件/测试步骤）。
/// repo_path 缺省时用 project_path；base_branch 缺省时取最近 20 条提交。
#[tauri::command]
pub async fn generate_yunxiao_writeback_summary(
    project_path: String,
    task_id: String,
    repo_path: Option<String>,
    serial_number: String,
    task_name: String,
    base_branch: Option<String>,
    agent: String,
    force: Option<bool>,
    plan_section: Option<String>,
) -> Result<YunxiaoWritebackDraft, String> {
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

    // 方案任务：方案节（plan.md 切片）+ 任务 drafts（评分/影响范围）确定性合并。
    // 不受 force 影响（无 AI 参与，重新生成只是重读文件）。
    if let Some(plan_section) = plan_section
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let task_drafts = crate::drafts::read_draft_file(&project_path, &task_id, "discussion.md")
            .map_err(|e| format!("读取讨论草稿失败: {e}"))?
            .filter(|s| !s.trim().is_empty());
        let mut draft = merge_plan_writeback_draft(plan_section, task_drafts.as_deref());
        // 「修改文件」用确定性统计覆盖（fix #106）：plan.md 预判 / 草稿归纳都可能漏报。
        let repo_for_names =
            repo_path.as_deref().filter(|r| !r.trim().is_empty()).unwrap_or(&project_path);
        let names = tokio::task::spawn_blocking({
            let cwd = repo_for_names.to_string();
            let base = base_branch.clone();
            move || collect_writeback_project_names(&cwd, base.as_deref())
        })
        .await
        .map_err(|e| format!("收集修改文件线程错误: {e}"))?;
        draft.test_comment =
            apply_deterministic_modified_files(&draft.test_comment, &names);
        return Ok(draft);
    }

    // 草稿优先（force=true 表示用户点了「重新生成」，跳过草稿走 headless）。
    if !force.unwrap_or(false) {
        if let Some(draft) =
            crate::drafts::read_draft_file(&project_path, &task_id, "discussion.md")
                .map_err(|e| format!("读取讨论草稿失败: {e}"))?
                .filter(|s| !s.trim().is_empty())
        {
            let (dev_comment, test_comment, score_comment) =
                split_discussion_into_comments(&draft);
            // 草稿里的「修改文件」是执行 agent 会话中凭记忆归纳的，可能漏报（fix #106）。
            // 先 bolden 归一字段名（未加粗的「修改文件：」apply 不识别），再确定性覆盖字段值。
            let test_comment = bolden_test_comment_fields(&test_comment);
            let repo_for_names =
                repo_path.as_deref().filter(|r| !r.trim().is_empty()).unwrap_or(&project_path);
            let names = tokio::task::spawn_blocking({
                let cwd = repo_for_names.to_string();
                let base = base_branch.clone();
                move || collect_writeback_project_names(&cwd, base.as_deref())
            })
            .await
            .map_err(|e| format!("收集修改文件线程错误: {e}"))?;
            return Ok(YunxiaoWritebackDraft {
                dev_comment,
                test_comment: apply_deterministic_modified_files(&test_comment, &names),
                score_comment,
            });
        }
    }

    // 重新生成（force=true）会跳过草稿走 headless 润色，这里先把草稿里的
    // 「价值评分」小节保留下来（位置不限），生成后作为独立的评分评论返回。
    let preserved_score_section =
        crate::drafts::read_draft_file(&project_path, &task_id, "discussion.md")
            .ok()
            .flatten()
            .and_then(|draft| {
                crate::value_score::extract_value_score_section(&draft).map(str::to_string)
            });

    let cwd = if let Some(repo) = repo_path.as_deref().filter(|r| !r.trim().is_empty()) {
        let repo_trim = repo.trim();
        let repo_for_validation = repo_trim.to_string();
        tokio::task::spawn_blocking(move || validate_project_path_for_naming(&repo_for_validation))
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
    let (branch, commits, diff_stat, project_names) = tokio::task::spawn_blocking(move || {
        let names = collect_writeback_project_names(&cwd_for_facts, base_for_facts.as_deref());
        let (branch, commits, diff_stat) =
            gather_writeback_facts(&cwd_for_facts, base_for_facts.as_deref());
        (branch, commits, diff_stat, names)
    })
    .await
    .map_err(|e| format!("收集 git 事实线程错误: {e}"))?;

    let prompt = build_writeback_prompt(
        &serial_number,
        task_name.trim(),
        &branch,
        &commits,
        &diff_stat,
    );
    let output = run_headless_agent_with_timeout(
        &agent,
        &project_path,
        &prompt,
        WRITEBACK_TIMEOUT,
        false,
        None,
    )
    .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Agent failed: {}{}", stderr, stdout));
    }
    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    let fallback =
        build_fallback_draft(&serial_number, task_name.trim(), &branch, &commits, &diff_stat);
    let dev = extract_tagged_block(&raw, "<DEV_SUMMARY>", "</DEV_SUMMARY>")
        .unwrap_or(fallback.dev_comment);
    let test = extract_tagged_block(&raw, "<TEST_SUMMARY>", "</TEST_SUMMARY>")
        .unwrap_or(fallback.test_comment);
    // headless 产出不含评分小节（prompt 不要求），评分一律来自草稿保留值，独立成评发布；
    // 无保留值时 score_comment 留空（回写命令回落从 dev 评论解析，兼容旧草稿）。
    let dev_comment = crate::value_score::strip_value_score_section(&dev);
    // 先 bolden 归一字段名，再确定性覆盖「修改文件」字段值（fix #106）；
    // fallback 路径的「（无）」占位也会被真实统计替换。
    let test_comment =
        apply_deterministic_modified_files(&bolden_test_comment_fields(&test), &project_names);
    Ok(YunxiaoWritebackDraft {
        dev_comment: dev_comment.trim().to_string(),
        test_comment,
        score_comment: preserved_score_section.unwrap_or_default(),
    })
}

// ── 知识沉淀（云效议题讨论完成后，提取图谱增量并生成审核议题候选）──────────────

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
    /// 生成候选时绑定的知识图谱，防止配置切换后旧草稿跨库写入。
    #[serde(default)]
    pub knowledge_graph_id: String,
}

/// 会话内沉淀产物的读取结论。
#[derive(Debug, Clone)]
pub enum SedimentationDraft {
    /// agent 显式表态「本次没有新知识」。
    Skipped { reason: String },
    /// 候选列表（可能为空数组，等价于没有候选但未显式 skipped）。
    Candidates(Vec<KnowledgeSuggestion>),
}

impl SedimentationDraft {
    pub fn candidates(&self) -> &[KnowledgeSuggestion] {
        match self {
            SedimentationDraft::Skipped { .. } => &[],
            SedimentationDraft::Candidates(list) => list,
        }
    }

    pub fn is_skipped(&self) -> bool {
        matches!(self, SedimentationDraft::Skipped { .. })
    }

    /// 把候选的图谱绑定兜底为 `graph_id`（agent 不再负责写该字段）。
    fn bind_graph(mut self, graph_id: &str) -> Self {
        if let SedimentationDraft::Candidates(list) = &mut self {
            for suggestion in list.iter_mut() {
                if suggestion.knowledge_graph_id.trim().is_empty() {
                    suggestion.knowledge_graph_id = graph_id.to_string();
                }
            }
        }
        self
    }
}

/// 读取会话内沉淀产物（`.nezha/drafts/<taskId>/knowledge.json`）。
///
/// 兼容三种形态：
/// - 显式表态：`{"version":1,"skipped":true,"skipReason":"…"}`
/// - 带壳候选：`{"version":1,"skipped":false,"candidates":[…]}`（多余字段忽略，前向兼容）
/// - 裸数组：`[{…}]`（历史草稿 / headless 输出）
///
/// `knowledgeGraphId` **不再要求 agent 写**：缺失时由本函数兜底填成当前绑定图谱，
/// 避免「agent 写错图谱 id ⇒ 整份草稿被丢弃」这一纯失败源。
pub fn parse_knowledge_draft(raw: &str, graph_id: &str) -> Result<SedimentationDraft, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(SedimentationDraft::Candidates(Vec::new()));
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("解析知识沉淀产物失败: {e}"))?;

    // 裸数组：直接按候选列表处理
    if value.is_array() {
        return Ok(SedimentationDraft::Candidates(parse_suggestions_value(
            value.as_array().cloned().unwrap_or_default(),
        )?)
        .bind_graph(graph_id));
    }

    if !value.is_object() {
        return Err("知识沉淀产物既不是对象也不是数组".to_string());
    }

    let skipped = value
        .get("skipped")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if skipped {
        let reason = value
            .get("skipReason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        return Ok(SedimentationDraft::Skipped { reason });
    }

    let candidates = value
        .get("candidates")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(SedimentationDraft::Candidates(parse_suggestions_value(candidates)?).bind_graph(graph_id))
}

/// 从已解析的 JSON 值列表规范化候选（模块/段落缺失的条目丢弃）。
fn parse_suggestions_value(parsed: Vec<serde_json::Value>) -> Result<Vec<KnowledgeSuggestion>, String> {
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
        let knowledge_graph_id = item
            .get("knowledgeGraphId")
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
                t.chars()
                    .take(MAX_SUGGESTION_FIELD_CHARS)
                    .collect::<String>()
                    + "…"
            } else {
                t.to_string()
            }
        };
        out.push(KnowledgeSuggestion {
            module,
            section,
            content: truncate(
                item.get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            ),
            evidence: truncate(
                item.get("evidence")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            ),
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
            knowledge_graph_id,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_discussion_references_skill_and_dynamic_params() {
        let prompt = plan_discussion_instructions(
            "H:/proj/.nezha/plans/p1/plan.md",
            "H:/proj/.nezha/plans/p1/deps.json",
            false,
            false,
        );
        // 技能引用 + plan.md 动态路径必须齐备；流程与文档契约文本由技能承载，不再内联。
        assert!(prompt.contains("yunxiao-plan-discussion"));
        assert!(prompt.contains("H:/proj/.nezha/plans/p1/plan.md"));
        // deps.json 绝对路径由宿主注入，schema 由技能承载。
        assert!(prompt.contains("H:/proj/.nezha/plans/p1/deps.json"));
        // 图谱 id 不能被当成技能名；知识认知与补录细节由技能/执行路径承载，讨论提示词不内联。
        assert!(!prompt.contains("使用 `ICUCIS` 技能"));
        assert!(!prompt.contains("knowledge-graph"));
        assert!(!prompt.contains("NEZHA_TASK_ID"));
    }

    #[test]
    fn direct_execution_instructions_compose_flow_and_drafts() {
        let prompt = direct_execution_instructions("9001", true, false, false);
        // 技能指针 + 任务参数：流程与产物契约由技能承载，不在提示词里复述。
        assert!(prompt.contains("`yunxiao-issue-execution` 技能"));
        assert!(prompt.contains("## 任务参数"));
        assert!(prompt.contains("方案来源：自动生成"));
        assert!(prompt.contains("议题类型：含 Bug 缺陷类议题"));
        assert!(prompt.contains(".nezha/drafts/9001/"));
        // 流程散文已外移：不再内联技能引用与产物小节标题。
        assert!(!prompt.contains("diagnosing-bugs"));
        assert!(!prompt.contains("## 修改方案汇总"));
        assert!(!prompt.contains("backfill-issue.json"));
    }

    #[test]
    fn direct_execution_instructions_bug_hint_conditional() {
        let no_bug = direct_execution_instructions("9002", false, false, false);
        assert!(no_bug.contains("议题类型：不含 Bug 类议题"));
        assert!(!no_bug.contains("含 Bug 缺陷类议题"));
    }

    #[test]
    fn direct_execution_instructions_clarify_first() {
        let clarify = direct_execution_instructions("9003", false, true, false);
        assert!(clarify.contains("先澄清：是"));
        assert!(clarify.contains("提问技能：`grilling`"));
        // 未勾选时不进入澄清。
        let plain = direct_execution_instructions("9004", false, false, false);
        assert!(plain.contains("先澄清：否"));
        // Bug 路径优先：has_bug 为真时忽略 clarify_first，避免两个技能各问一轮。
        let bug_with_clarify = direct_execution_instructions("9005", true, true, false);
        assert!(bug_with_clarify.contains("议题类型：含 Bug 缺陷类议题"));
        assert!(bug_with_clarify.contains("先澄清：否"));
    }

    #[test]
    fn direct_execution_instructions_batch_grill_swaps_question_skill() {
        // 开关开启且进入澄清：「提问技能」参数改为 batch-grill-me。
        let batch = direct_execution_instructions("9006", false, true, true);
        assert!(batch.contains("提问技能：`batch-grill-me`"));
        assert!(!batch.contains("提问技能：`grilling`"));
        // 未勾选澄清时开关不改变参数取值（澄清不发生，节律无意义）。
        let plain = direct_execution_instructions("9007", false, false, true);
        assert!(plain.contains("提问技能：`grilling`"));
        // Bug 路径仍优先：开了批量盘问也不进入澄清，参数保持默认。
        let bug = direct_execution_instructions("9008", true, true, true);
        assert!(bug.contains("议题类型：含 Bug 缺陷类议题"));
        assert!(bug.contains("先澄清：否"));
        assert!(bug.contains("提问技能：`grilling`"));
    }

    /// 两个执行入口共用同一技能指针与参数块，只差「方案来源」等取值——收敛的核心保证。
    #[test]
    fn execution_entries_share_one_skill_pointer() {
        let from_plan = plan_execution_instructions("9010");
        let auto = direct_execution_instructions("9010", false, false, false);
        assert!(from_plan.contains("`yunxiao-issue-execution` 技能"));
        assert!(auto.contains("`yunxiao-issue-execution` 技能"));
        assert!(from_plan.contains("方案来源：已定稿"));
        assert!(auto.contains("方案来源：自动生成"));
        // 已定稿方案不重复盘问、不重跑 Bug 取证（讨论阶段已定）。
        assert!(from_plan.contains("先澄清：否"));
        assert!(from_plan.contains("已定稿方案（根因与修改方案已在讨论阶段确定"));
        // 两条路径都不内联旧的流程散文。
        for prompt in [&from_plan, &auto] {
            assert!(!prompt.contains("方案优先：本议题的修改方案"));
            assert!(!prompt.contains("此外，在讨论/执行过程中"));
            assert!(!prompt.contains("── 工作产物落盘"));
        }
    }

    #[test]
    fn plan_discussion_passes_question_skill_param() {
        let batch = plan_discussion_instructions(
            "H:/proj/.nezha/plans/p1/plan.md",
            "H:/proj/.nezha/plans/p1/deps.json",
            false,
            true,
        );
        assert!(batch.contains("`yunxiao-plan-discussion` 技能"));
        assert!(batch.contains("## 任务参数"));
        assert!(batch.contains("提问技能：`batch-grill-me`"));
        assert!(batch.contains("H:/proj/.nezha/plans/p1/deps.json"));
        // 技能引用与产物契约不受影响；不再内联任何流程散文。
        assert!(!batch.contains("一轮一次性全部抛出"));
        assert!(!batch.contains("一次只问一个问题"));
        // 关闭时参数退回逐条盘问。
        let plain = plan_discussion_instructions(
            "H:/proj/.nezha/plans/p1/plan.md",
            "H:/proj/.nezha/plans/p1/deps.json",
            false,
            false,
        );
        assert!(plain.contains("提问技能：`grilling`"));
        assert!(!plain.contains("batch-grill-me"));
        // Bug 议题类型随参数传递。
        let bug = plan_discussion_instructions(
            "H:/proj/.nezha/plans/p1/plan.md",
            "H:/proj/.nezha/plans/p1/deps.json",
            true,
            false,
        );
        assert!(bug.contains("议题类型：含 Bug 缺陷类议题"));
    }

    #[test]
    fn writeback_prompt_includes_facts_and_dev_plan_sections() {
        let prompt = build_writeback_prompt(
            "HJWE-65",
            "测试议题",
            "master",
            "abc123 压缩图片资源",
            "1 file changed, 10 insertions(+)",
        );
        assert!(prompt.contains("修改方案"));
        assert!(prompt.contains("修改分支"));
        assert!(prompt.contains("master"));
        assert!(prompt.contains("修改文件"));
        assert!(prompt.contains("abc123 压缩图片资源"));
        // 开发向不再套 PR 三段结构，直接回写修改方案；不再注入会话过程。
        assert!(!prompt.contains("What（改动方案）"));
        assert!(!prompt.contains("Why（动机与取舍）"));
        assert!(!prompt.contains("Scope（影响面）"));
        assert!(!prompt.contains("会话过程"));
    }

    #[test]
    fn writeback_prompt_falls_back_to_no_facts_markers() {
        let prompt = build_writeback_prompt("HJWE-65", "测试议题", "", "", "");
        assert!(prompt.contains("（无）"));
    }

    #[test]
    fn split_discussion_splits_dev_test_and_score() {
        let text = "## 修改方案汇总（开发向）\n\nWhat…\n\n## 价值评分\n\n- 核心指数：**50** = (4 × 5 × 5) ÷ 2\n\n## 影响范围与测试（测试向）\n\n- 影响范围：模块A\n- 测试步骤：1. …";
        let (dev, test, score) = split_discussion_into_comments(text);
        assert!(dev.contains("修改方案汇总"));
        assert!(!dev.contains("价值评分"), "评分必须独立成评，不留在 dev：{dev}");
        assert!(!dev.contains("影响范围与测试"));
        assert!(test.contains("影响范围与测试"));
        assert!(test.contains("模块A"));
        assert!(score.starts_with("## 价值评分"));
        assert!(score.contains("核心指数"));
    }

    #[test]
    fn split_discussion_finds_score_after_test_section() {
        // QHDK-30560 排列：评分写在测试向之后。三分离下两条正文评论各自切片，
        // 评分从 test 半区抽出，位置无关。
        let text = "## 修改方案汇总\n\n内容\n\n## 影响范围与测试（测试向）\n\n**修改分支** fix/x\n\n## 价值评分\n\n- 优先指数：**31.5**";
        let (dev, test, score) = split_discussion_into_comments(text);
        assert!(dev.contains("修改方案汇总"));
        assert!(test.contains("影响范围与测试"));
        assert!(test.contains("修改分支"));
        assert!(!test.contains("价值评分"), "评分不留在 test：{test}");
        assert!(score.starts_with("## 价值评分"));
        assert!(score.contains("31.5"));
    }

    #[test]
    fn split_discussion_without_test_section_keeps_all_in_dev() {
        let text = "## 修改方案汇总\n\n内容";
        let (dev, test, score) = split_discussion_into_comments(text);
        assert_eq!(dev, "## 修改方案汇总\n\n内容");
        assert!(test.is_empty());
        assert!(score.is_empty());
    }

    #[test]
    fn merge_plan_writeback_extracts_score_as_standalone_comment() {
        // 回归（QHDK-30560）：草稿里「## 价值评分」被 agent 写在「## 影响范围与测试」之后时，
        // 评分必须独立成评返回（score_comment），不再依赖拼进开发向评论——
        // 否则 yunxiao_writeback_with_score 解析不到评分，字段不写（评论有评分、字段无值）。
        let task_drafts = "\
            ## 影响范围与测试（测试向）\n\
            \n\
            **修改分支** fix/x\n\
            **修改文件** A、B\n\
            **测试步骤** 1. …\n\
            \n\
            ## 价值评分（issue-value-scoring · 2026-09-28）\n\
            \n\
            - 议题类别：Bug\n\
            - 优先指数：**31.5** = 严重 3 × 频率 5 × 范围 3 × 折减 0.7\n";
        let plan_section = "## 修改方案汇总\n\n方案内容。\n\n### 影响范围与测试\n\n- 影响范围：模块A";
        let draft = merge_plan_writeback_draft(plan_section, Some(task_drafts));
        assert!(
            !draft.dev_comment.contains("价值评分"),
            "评分不再拼进开发向评论：{}",
            draft.dev_comment
        );
        assert!(draft.dev_comment.contains("方案内容"));
        assert!(
            draft.score_comment.contains("## 价值评分"),
            "评分必须独立成评：{}",
            draft.score_comment
        );
        assert!(draft.score_comment.contains("31.5"));
        assert!(draft.test_comment.contains("修改分支"));
        assert!(!draft.test_comment.contains("价值评分"));
    }

    #[test]
    fn merge_plan_writeback_prefers_draft_score_over_plan_inline() {
        // drafts 评分（执行后实际值）优先于方案节内联评分（讨论期预评），且 plan 内联
        // 评分被剥出时不得重复出现在 dev 评论里。
        let task_drafts = "\
            ## 价值评分\n\
            \n\
            - 核心指数：**50**\n\
            \n\
            ## 影响范围与测试（测试向）\n\
            \n\
            **修改分支** fix/x\n";
        let plan_section = "## 修改方案汇总\n\n方案。\n\n## 价值评分\n\n- 核心指数：**40**";
        let draft = merge_plan_writeback_draft(plan_section, Some(task_drafts));
        assert!(draft.score_comment.contains("50"), "drafts 评分优先：{}", draft.score_comment);
        assert!(!draft.score_comment.contains("40"));
        assert!(!draft.dev_comment.contains("价值评分"));
    }

    #[test]
    fn merge_plan_writeback_extracts_inline_plan_score_when_no_drafts() {
        // 旧方案文档把评分内联在方案节里、无任务草稿时：剥出为独立评分评论。
        let plan_section = "## 修改方案汇总\n\n方案。\n\n## 价值评分\n\n- 核心指数：**40**";
        let draft = merge_plan_writeback_draft(plan_section, None);
        assert!(draft.score_comment.contains("40"));
        assert!(!draft.dev_comment.contains("价值评分"));
    }

    #[test]
    fn bolden_test_comment_fields_bolds_list_labels_and_keeps_heading() {
        // 真实草稿样式：三字段为无序列表项，测试步骤含多行编号内容（缩进）。
        let text = "## 影响范围与测试（测试向）\n\n- 修改分支：v2.20260901.0.0-rc\n- 修改文件：Nto.His.Order.UI（Hsp 主解决方案）\n- 测试步骤：\n  1. 打开中草药开立窗口\n  2. 点击「上次处方」";
        let out = bolden_test_comment_fields(text);
        // 标题行不参与字段加粗，保持原样（开发向小标题同级）。
        assert!(out.starts_with("## 影响范围与测试（测试向）"));
        assert!(out.contains("**修改分支**：v2.20260901.0.0-rc"));
        assert!(out.contains("**修改文件**：Nto.His.Order.UI（Hsp 主解决方案）"));
        assert!(out.contains("**测试步骤**："));
        // 列表前缀被去掉了（列表项里的 `**` 会被云效转换器剥掉）。
        assert!(!out.contains("\n- 修改分支"));
        // 测试步骤正文不受影响。
        assert!(out.contains("1. 打开中草药开立窗口"));
    }

    #[test]
    fn bolden_test_comment_fields_is_idempotent() {
        let text = "**修改分支**：master\n**修改文件**：Nto.X\n**测试步骤**：1. 复现";
        assert_eq!(bolden_test_comment_fields(text), text);
    }

    #[test]
    fn bolden_test_comment_fields_handles_colon_and_bare_labels() {
        let out = bolden_test_comment_fields("修改分支: master\n修改文件：Nto.X");
        assert!(out.contains("**修改分支**: master"));
        assert!(out.contains("**修改文件**：Nto.X"));
        // 非字段行不受影响。
        let other = bolden_test_comment_fields("修改分支说明：这里不是字段行");
        assert_eq!(other, "修改分支说明：这里不是字段行");
    }

    #[test]
    fn fallback_draft_test_comment_uses_bold_labels() {
        let draft = build_fallback_draft("HJWE-65", "标题", "master", "", "");
        assert!(draft.test_comment.contains("**修改分支**：master"));
        assert!(draft.test_comment.contains("**修改文件**：（无）"));
        assert!(draft.test_comment.contains("**测试步骤**："));
    }

    #[test]
    fn extract_tagged_block_takes_last_block() {
        let stdout =
            "user\n<DEV_SUMMARY>回显</DEV_SUMMARY>\ncodex\n<DEV_SUMMARY>真答案</DEV_SUMMARY>\ntokens used\n";
        assert_eq!(
            extract_tagged_block(stdout, "<DEV_SUMMARY>", "</DEV_SUMMARY>").as_deref(),
            Some("真答案")
        );
        assert_eq!(
            extract_tagged_block(stdout, "<TEST_SUMMARY>", "</TEST_SUMMARY>"),
            None
        );
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
    fn plan_instructions_inject_bug_diagnosing_only_with_bug() {
        let with_bug = plan_discussion_instructions(
            "C:/p/.nezha/plans/1/plan.md",
            "C:/p/.nezha/plans/1/deps.json",
            true,
            false,
        );
        assert!(with_bug.contains("议题类型：含 Bug 缺陷类议题"));
        assert!(with_bug.contains("Bug 根因诊断"));

        let without_bug = plan_discussion_instructions(
            "C:/p/.nezha/plans/1/plan.md",
            "C:/p/.nezha/plans/1/deps.json",
            false,
            false,
        );
        assert!(without_bug.contains("议题类型：不含 Bug 类议题"));
        // 「Bug 根因诊断」只作为技能小节名出现在参数说明里，取证方法论本身由技能承载。
        assert!(!without_bug.contains("diagnosing-bugs"));
    }

    // ── 会话内沉淀产出契约（ticket 04 / 11）──────────────────────────

    #[test]
    fn draft_parses_wrapped_candidates() {
        let raw = r#"{"version":1,"skipped":false,"candidates":[
            {"module":"Nto.His.Register","section":"职责","content":"内容","evidence":"X.cs:1","confidence":"confirmed"}]}"#;
        let draft = parse_knowledge_draft(raw, "HIS").expect("解析成功");
        let list = draft.candidates();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].module, "Nto.His.Register");
        assert!(!draft.is_skipped());
    }

    #[test]
    fn draft_parses_explicit_skip() {
        let raw = r#"{"version":1,"skipped":true,"skipReason":"本次只是改样式，无新知识"}"#;
        let draft = parse_knowledge_draft(raw, "HIS").expect("解析成功");
        assert!(draft.is_skipped());
        assert!(draft.candidates().is_empty());
        // skipped 的 reason 必须保留下来，供指标统计（§9）。
        match draft {
            SedimentationDraft::Skipped { reason } => assert!(reason.contains("改样式")),
            _ => panic!("应为 Skipped"),
        }
    }

    #[test]
    fn draft_backfills_graph_id_when_agent_omits_it() {
        // agent 不再负责写 knowledgeGraphId：缺失时兜底填当前绑定图谱，
        // 避免「写错图谱 id ⇒ 整份草稿被丢弃」这一纯失败源。
        let raw = r#"[{"module":"M","section":"职责","content":"c","evidence":"e","confidence":"confirmed"}]"#;
        let draft = parse_knowledge_draft(raw, "HIS").expect("解析成功");
        assert_eq!(draft.candidates()[0].knowledge_graph_id, "HIS");
    }

    #[test]
    fn draft_keeps_agent_supplied_graph_id() {
        let raw = r#"[{"module":"M","section":"职责","content":"c","evidence":"e","confidence":"confirmed","knowledgeGraphId":"ICUCIS"}]"#;
        let draft = parse_knowledge_draft(raw, "HIS").expect("解析成功");
        assert_eq!(draft.candidates()[0].knowledge_graph_id, "ICUCIS");
    }

    #[test]
    fn draft_accepts_legacy_bare_array_and_ignores_unknown_fields() {
        // 裸数组（历史草稿 / headless 输出）与多余字段都要能读，保证前向兼容。
        let raw = r#"[{"module":"M","section":"职责","content":"c","evidence":"e","confidence":"confirmed","someFutureField":123}]"#;
        let draft = parse_knowledge_draft(raw, "HIS").expect("解析成功");
        assert_eq!(draft.candidates().len(), 1);
    }

    #[test]
    fn draft_empty_input_is_candidates_not_skip() {
        // 空文本按「无候选」处理（不是 skipped），调用方据此判「漏了」。
        let draft = parse_knowledge_draft("   ", "HIS").expect("解析成功");
        assert!(!draft.is_skipped());
        assert!(draft.candidates().is_empty());
    }

    #[test]
    fn draft_rejects_malformed_json() {
        assert!(parse_knowledge_draft("{not json", "HIS").is_err());
        assert!(parse_knowledge_draft("42", "HIS").is_err());
    }

    /// 契约块：技能文件可读时给**指针**（不复述 schema，正文交给 agent 按路径读）；
    /// 读不到时回退内嵌常量——两条路都必须让 agent 知道写哪、以及「无新知识也要显式表态」。
    #[test]
    fn contract_block_is_pointer_or_full_fallback() {
        let block = sedimentation_contract_block();
        // 两条路共同的可执行约定：产物文件名、显式 skipped 表态、任务 id 取环境变量。
        assert!(block.contains("knowledge.json"), "应指明产物文件");
        assert!(block.contains("skipped"), "应要求显式表态无新知识");
        assert!(block.contains("$NEZHA_TASK_ID"), "任务 id 应由环境变量给出");
        // 不得残留任何未被替换的占位符。
        assert!(!block.contains("{TASK_ID}"), "不应残留字面占位符");
        // 指针或正文二选一：指针必须指明契约文件路径；回退必须自带 schema。
        if block == SEDIMENTATION_CONTRACT_POINTER {
            assert!(block.contains(SEDIMENTATION_CONTRACT_ENV));
        } else {
            assert_eq!(block, SESSION_SEDIMENTATION_CONTRACT_FALLBACK);
            assert!(block.contains("confidence"), "回退需自带字段说明");
        }
    }

    /// 技能文件真的可读时，必须走**指针**分支、而不是悄悄回退——否则「省 prompt 体积」
    /// 这个目的会在没人察觉的情况下失效（回退正文照常工作，只是又变长了）。
    /// 未配置 hub / 未装该技能时跳过：那时回退是正确行为（见上一测试）。
    #[test]
    fn contract_block_prefers_pointer_when_hub_available() {
        let Some(_) = crate::skills::read_skill_reference_path(
            SEDIMENTATION_CONTRACT_SKILL,
            SEDIMENTATION_CONTRACT_REFERENCE,
        ) else {
            return; // 本机没有 hub / 该技能：回退分支，跳过
        };
        assert_eq!(
            sedimentation_contract_block(),
            SEDIMENTATION_CONTRACT_POINTER,
            "技能文件可读时必须用指针块"
        );
    }

    /// 指针块本身不能省掉「无新知识也必须显式表态」——这是区分「忘了」与「确实没有」
    /// 的唯一依据，漏了就会把正常任务判成漏产出。
    #[test]
    fn pointer_block_keeps_skip_marker_and_path() {
        let p = SEDIMENTATION_CONTRACT_POINTER;
        assert!(p.contains("skipReason"));
        assert!(p.contains("$NEZHA_TASK_ID"));
        assert!(p.contains(SEDIMENTATION_CONTRACT_ENV));
        assert!(p.contains(SEDIMENTATION_CONTRACT_SKILL));
        // 刻意不内联 schema：两处维护必然漂移。
        assert!(!p.contains("\"candidates\""), "指针不应复述 schema");
    }

    /// 回退文本必须与技能文本承载同样的**可执行约束**：回退只应在读不到契约文件时兜底，
    /// 若它比技能少几条硬约束，agent 会产出注定被门拒掉的候选（白费一次模型调用）。
    /// 这里逐条钉住「门会强制、且 agent 能事先遵守」的那些约束。
    #[test]
    fn fallback_contract_covers_actionable_constraints() {
        let fb = SESSION_SEDIMENTATION_CONTRACT_FALLBACK;
        let required = [
            ("跳过表态", "skipped"),
            ("跳过理由", "skipReason"),
            ("产物文件名", "knowledge.json"),
            ("任务 id 环境变量", "$NEZHA_TASK_ID"),
            ("单行要求", "单行"),
            ("冲突不提", "不要提取"),
            ("可写段样例", "业务规则与已知坑"),
            ("不可写段", "定位"),
            ("排除实现细节", "实现细节"),
            ("依据要可定位", "evidence"),
            ("置信度取值", "confirmed"),
        ];
        for (label, needle) in required {
            assert!(fb.contains(needle), "回退文本缺少「{label}」（{needle}）");
        }
    }

    #[test]
    fn contract_requires_task_scoped_path_and_skip_marker() {
        // 契约文本必须含任务级路径与显式 skipped 表态，否则「忘了」与「确实没有」无法区分。
        assert!(SESSION_SEDIMENTATION_CONTRACT_FALLBACK.contains("$NEZHA_TASK_ID"));
        assert!(SESSION_SEDIMENTATION_CONTRACT_FALLBACK.contains("skipped"));
        assert!(SESSION_SEDIMENTATION_CONTRACT_FALLBACK.contains("skipReason"));
    }

    /// 内嵌回退模板必须自带全部占位符且自身合法——它是 hub 缺失时的唯一格式来源。
    #[test]
    fn fallback_entry_template_is_valid_and_has_all_placeholders() {
        validate_entry_template(SEDIMENTATION_ENTRY_TEMPLATE_FALLBACK).expect("回退模板应合法");
        for placeholder in ["{date}", "{content}", "{evidence}", "{trace}"] {
            assert!(
                SEDIMENTATION_ENTRY_TEMPLATE_FALLBACK.contains(placeholder),
                "回退模板缺少 {placeholder}"
            );
        }
    }

    /// 渲染：占位符替换到位，且 `trace` 为空时丢弃整条标记行（不写空标记）。
    #[test]
    fn render_entry_template_substitutes_and_drops_empty_trace_line() {
        let rendered = render_entry_template(
            SEDIMENTATION_ENTRY_TEMPLATE_FALLBACK,
            "缓存键必须带租户前缀",
            "CacheService.cs:42",
            "2026-09-28",
            "HIS@20260928T000000.000Z.abcd1234",
        );
        assert!(rendered.contains("缓存键必须带租户前缀"));
        assert!(rendered.contains("来源：CacheService.cs:42，2026-09-28"));
        assert!(rendered.contains("<!-- kg:HIS@20260928T000000.000Z.abcd1234 -->"));
        // 占位符不得残留。
        assert!(!rendered.contains('{'), "占位符未替换：{rendered}");

        let untraced = render_entry_template(
            SEDIMENTATION_ENTRY_TEMPLATE_FALLBACK,
            "某规则",
            "X.cs",
            "2026-09-28",
            "",
        );
        assert!(!untraced.contains("<!-- kg:"), "空 trace 不应产生标记行：{untraced}");
        assert!(!untraced.contains('{'), "占位符未替换：{untraced}");
    }

    /// 模板校验：缺占位符 / 含 `## ` 抬头 / 行数超限都必须被拒，避免坏模板破坏卡片结构。
    #[test]
    fn validate_entry_template_rejects_malformed_templates() {
        assert!(validate_entry_template("- {content}（来源：{evidence}，{date}）").is_err());
        assert!(validate_entry_template(
            "- {content}\n## 伪造标题\n{evidence}{date}{trace}"
        )
        .is_err());
        let too_many = ["{content}{evidence}{date}{trace}"]
            .iter()
            .chain(std::iter::repeat(&"x").take(6))
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        assert!(validate_entry_template(&too_many).is_err());
        // 合法模板应通过。
        assert!(validate_entry_template(SEDIMENTATION_ENTRY_TEMPLATE_FALLBACK).is_ok());
    }


    #[test]
    fn headless_args_claude_include_light_model_and_effort() {
        let args = build_headless_agent_args(
            "claude",
            "prompt text",
            Some("fast-model"),
            Some("low"),
            false,
        );
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(args.windows(2).any(|w| w == ["--model", "fast-model"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "low"]));
        assert!(args.contains(&"prompt text"));
    }

    #[test]
    fn headless_args_codex_include_light_model_and_effort() {
        let args = build_headless_agent_args(
            "codex",
            "prompt text",
            Some("fast-model"),
            Some("high"),
            false,
        );
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(args.windows(2).any(|w| w == ["--model", "fast-model"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["-c", "model_reasoning_effort=\"high\""]));
        // 轻量模型旗标必须位于 positional prompt 之前
        let model_pos = args.iter().position(|a| *a == "fast-model").unwrap();
        let prompt_pos = args.iter().position(|a| *a == "prompt text").unwrap();
        assert!(model_pos < prompt_pos);
    }

    #[test]
    fn headless_args_without_light_config_match_previous_flags() {
        let args = build_headless_agent_args("claude", "prompt text", None, None, false);
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(
            args,
            vec![
                "-p",
                "prompt text",
                "--output-format",
                "text",
                "--permission-mode",
                "plan",
                // 项目上下文隔离：headless 提示词自包含，不加载项目 MCP。
                "--strict-mcp-config",
                "--tools",
                "",
                "--no-session-persistence",
            ]
        );

        let args = build_headless_agent_args("codex", "prompt text", None, None, false);
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(
            args,
            vec![
                "exec",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--skip-git-repo-check",
                "-c",
                "approval_policy=\"never\"",
                // 项目上下文隔离：禁加载 cwd 下的 project doc（AGENTS.md 等）。
                "-c",
                "project_doc_max_bytes=0",
                "prompt text",
            ]
        );
    }

    /// 项目上下文隔离（HIS 实测误拒的缓解）：无论轻量模型配置如何，claude 必须
    /// 带 `--strict-mcp-config`、codex 必须带 `-c project_doc_max_bytes=0`，
    /// 防止业务仓库的 AGENTS.md 强指令 / MCP servers 进入判定上下文。
    #[test]
    fn headless_args_isolate_from_project_context() {
        for model in [None, Some("fast-model")] {
            let claude = build_headless_agent_args("claude", "p", model, None, true);
            assert!(
                claude.contains(&OsString::from("--strict-mcp-config")),
                "claude 缺 --strict-mcp-config：{claude:?}"
            );
            let codex = build_headless_agent_args("codex", "p", model, None, true);
            let pos = codex
                .windows(2)
                .position(|w| w == [OsString::from("-c"), OsString::from("project_doc_max_bytes=0")]);
            assert!(pos.is_some(), "codex 缺 project_doc_max_bytes=0：{codex:?}");
        }
    }

    #[test]
    fn extracts_review_findings_from_tagged_json() {
        let stdout = "前言\n<REVIEW>[{\"rule\":\"命名规范\",\"status\":\"fail\",\"path\":\"src/main.rs\",\"startLine\":12,\"endLine\":12,\"message\":\"分支命名不符合约定\"},{\"rule\":\"议题编号\",\"status\":\"pass\",\"path\":\"\",\"startLine\":0,\"endLine\":0,\"message\":\"提交信息含 #123\"}]</REVIEW>\n后记";
        let findings = extract_review_findings(stdout).unwrap();
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].rule, "命名规范");
        assert_eq!(findings[0].path, "src/main.rs");
        assert_eq!(findings[0].start_line, 12);
        assert_eq!(findings[1].status, "pass");
    }

    #[test]
    fn extract_review_findings_falls_back_to_raw_json() {
        let findings =
            extract_review_findings("[{\"rule\":\"x\",\"status\":\"warn\",\"message\":\"m\"}]")
                .unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].message, "m");
    }

    #[test]
    fn derive_project_names_groups_by_first_segment() {
        let names = derive_project_names(&[
            "src/a/b.ts".to_string(),
            "src/deep/c.rs".to_string(),
            "Nto.His.Foo/Bar.cs".to_string(),
            "README.md".to_string(),
        ]);
        assert_eq!(names, vec!["Nto.His.Foo", "README.md", "src"]);
    }

    #[test]
    fn derive_project_names_dedupes_and_stays_sorted() {
        let names = derive_project_names(&[
            "b/x".to_string(),
            "a/y".to_string(),
            "b/z".to_string(),
            "a/w".to_string(),
        ]);
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn derive_project_names_truncates_at_cap() {
        let paths: Vec<String> = (0..(MAX_MODIFIED_FILE_LABELS + 10))
            .map(|i| format!("dir{i}/file"))
            .collect();
        let names = derive_project_names(&paths);
        assert_eq!(names.len(), MAX_MODIFIED_FILE_LABELS + 1);
        assert!(names.last().unwrap().contains("已截断"));
    }

    #[test]
    fn deterministic_modified_files_replaces_field_value() {
        let comment = "## 影响范围与测试指引\n\n**修改分支**：feat-x\n**修改文件**：Nto.Old（草稿归纳）\n**测试步骤**：回归登录";
        let out = apply_deterministic_modified_files(comment, &["src".to_string(), "docs".to_string()]);
        assert!(out.contains("**修改分支**：feat-x"));
        assert!(out.contains("**修改文件**：src、docs"));
        assert!(out.contains("**测试步骤**：回归登录"));
        assert!(!out.contains("Nto.Old"));
    }

    #[test]
    fn deterministic_modified_files_preserves_list_prefix() {
        // 已加粗的列表行：替换字段值并保留行首列表符。
        let listed = "- **修改文件**：Nto.X\n- **测试步骤**：1";
        assert!(apply_deterministic_modified_files(listed, &["a".to_string()])
            .starts_with("- **修改文件**：a"));
        // 未加粗行不在本函数契约内——由 bolden_test_comment_fields 先行归一（调用链上
        // headless 路径 apply 在 bolden 之前，草稿路径同样），这里只验证不误伤。
        let plain = "修改文件：Nto.X";
        assert_eq!(
            apply_deterministic_modified_files(plain, &["a".to_string()]),
            plain
        );
    }

    #[test]
    fn deterministic_modified_files_idempotent_and_keeps_text_when_empty() {
        let once = apply_deterministic_modified_files(
            "**修改文件**：a、b",
            &["a".to_string(), "b".to_string()],
        );
        let twice = apply_deterministic_modified_files(&once, &["a".to_string(), "b".to_string()]);
        assert_eq!(once, twice);
        // 空集（git 不可用）不覆盖，宁缺毋错。
        assert_eq!(
            apply_deterministic_modified_files("**修改文件**：Nto.X", &[]),
            "**修改文件**：Nto.X"
        );
        // 无该字段的评论不动。
        assert_eq!(
            apply_deterministic_modified_files("## 其他内容", &["a".to_string()]),
            "## 其他内容"
        );
    }

    #[test]
    fn collect_writeback_project_names_includes_uncommitted_and_untracked() {
        let dir = std::env::temp_dir().join(format!("nezha-wb-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let mut cmd = std::process::Command::new("git");
            cmd.args(args).current_dir(&dir);
            cmd.env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t");
            cmd.env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t");
            assert!(cmd.status().unwrap().success(), "git {:?} failed", args);
        };
        git(&["init", "-q", "-b", "base"]);
        std::fs::write(dir.join("Committed.cs"), "a").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        git(&["checkout", "-q", "-b", "feat"]);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("Committed2.cs"), "b").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "feat: c2"]);
        // 已暂存未提交
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(dir.join("lib").join("Staged.cs"), "c").unwrap();
        git(&["add", "."]);
        // 未跟踪
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("docs").join("Untracked.md"), "d").unwrap();

        let names = collect_writeback_project_names(dir.to_str().unwrap(), Some("base"));
        let _ = std::fs::remove_dir_all(&dir);
        // 已提交（src）+ 已暂存未提交（lib）+ 未跟踪（docs）三类都在。
        assert_eq!(names, vec!["docs", "lib", "src"]);
    }
}
