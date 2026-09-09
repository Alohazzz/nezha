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
                "plan",
            ]
            .map(OsString::from),
        );
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

// ── 讨论指令公共片段（联合分析讨论 / 方案执行共用）──────────────────────────

/// 价值评分技能指令：讨论/分析得出结论后，用 issue-value-scoring 技能产出「价值评分」
/// 小节写入 discussion.md（放在「修改方案汇总」之后、「影响范围与测试」之前），
/// 随开发向评论一起回写，数值同时写入议题「价值评分」字段（Req 核心指数 / Bug 优先指数）。
const VALUE_SCORE_INSTRUCTION: &str = r#"另外，在讨论/分析得出结论后，使用 issue-value-scoring 技能对议题做价值评分，并把 `## 价值评分` 小节写入 discussion.md（放在「修改方案汇总」小节之后、「影响范围与测试」小节之前，随开发向评论一起回写；数值同时写入议题「价值评分」字段，Req 写核心指数、Bug 写优先指数）。评分小节固定格式如下（按议题类别只输出对应的一行指数，其余行不要输出）：
## 价值评分
- 议题类别：Req（或 Bug）
- 核心指数：**50** = (价值 4 × 机会 5 × 影响 5) ÷ 工作量等级 2
- 优先指数：**54** = 严重 3 × 频率 3 × 范围 3 × 折减 1.0
- 一句话结论：高价值低成本，值得立即做。"#;

/// 补录议题技能指令：讨论/执行中发现需要新立项的问题时，提示用户手工调用
/// `yunxiao-backfill-issue` 技能补录议题（Skill 负责盘问，Nezha 持有 token 创建）。
const BACKFILL_SKILL_INSTRUCTION: &str = "此外，在讨论/执行过程中，如果发现一个不属于当前议题、需要单独新立项的问题，可以提示用户手工调用 yunxiao-backfill-issue 技能补录议题：它会总结上下文、判定缺陷/需求、按模板盘问并生成预览，确认后由 Nezha 创建云效议题并自动生成绑定待办。不要未经用户确认就自动立项。\n写补录请求文件 backfill-issue.json 时，目录名必须是你当前任务 id（读取环境变量 $NEZHA_TASK_ID，禁止自造 task_id），即 `.nezha/drafts/{NEZHA_TASK_ID}/backfill-issue.json`，与 discussion.md / knowledge.json 放同一目录；否则 Nezha 的补录侦测匹配不到本任务，不会创建议题与待办。只需写入一次；Nezha 消费后会自动清理该文件，若你随后发现文件消失属正常，不要重复写入或重新落盘。";

/// 知识沉淀提取规则（替代已废弃的 knowledge-sedimentation 技能，内嵌到提示词）。
/// 讨论提示词与 headless 降级路径共用，保证判定标准一致。
const KNOWLEDGE_SEDIMENTATION_RULES: &str = r#"知识沉淀规则：
- 按价值排序提取：业务规则/已知坑 > 关键实体/数据表映射 > 模块职责修正/依赖补充 > 验证记录
- 必须有依据（代码位置 / 文档 / 用户确认）；无依据一律不提取；排除图谱已有内容与纯实现细节
- 与图谱冲突的结论标注「与现状冲突，需复核」
- section 限定：定位 / 职责 / 关键实体与数据表 / 依赖与相关模块 / 业务规则与已知坑 / UI界面与入口 / 验证记录
- confidence：confirmed（已确认）/ pending（待验证）
- JSON 示例：[{ "module": "<目标知识库中的模块名>", "section": "业务规则与已知坑", "content": "…", "evidence": "…", "confidence": "confirmed", "suggestedTitle": "…" }]"#;

// ── 多议题联合方案（Plan）指令：讨论定稿 / 按方案执行 ────────────────────────

/// 方案讨论的流程与方案文档契约由 `yunxiao-plan-discussion` 技能维护（SkillHub 统一管理，
/// 改技能免重编）；此处只注入技能引用与动态参数（plan.md 路径、Bug 议题提示）。
const PLAN_DISCUSSION_SKILL: &str = "yunxiao-plan-discussion";

/// 方案讨论任务的完整指令：技能引用 + Bug 议题提示 + 方案文档落盘路径。
/// has_bug：方案内是否含 Bug 类议题（议题类别快照由前端传入），决定是否提示执行技能中的根因诊断。
pub fn plan_discussion_instructions(plan_md_path: &str, has_bug: bool) -> String {
    let bug_hint = if has_bug {
        "本方案含 Bug 缺陷类议题：先按技能「Bug 根因诊断」的要求，用 diagnosing-bugs 方法论定位根因（结论要有可复现的证据）后再进入方案产出。"
    } else {
        "本方案不含 Bug 类议题，可跳过技能中的「Bug 根因诊断」。"
    };
    format!(
        "## 工作流程\n请先读取并遵循 `{PLAN_DISCUSSION_SKILL}` 技能：严格按技能定义的讨论流程（含性能影响分析强制分支与前置知识认知）走完决策树并产出方案文档；先不要写代码。单议题与多议题联合的格式约定见技能对应小节。\n{bug_hint}\n\n## 输出与产物\n方案文档（绝对路径，技能中的落盘指令以此路径为准）：{plan_md_path}（目录不存在就先创建）。",
        plan_md_path = plan_md_path,
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
    let plan_md_path = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let canonical = std::path::Path::new(&project_path_for_dir)
            .canonicalize()
            .map_err(|e| format!("项目路径无效: {e}"))?;
        Ok(crate::storage::plan_dir(&canonical, &plan_id)
            .join("plan.md")
            .to_string_lossy()
            .into_owned()
            .replace("\\\\?\\", ""))
    })
    .await
    .map_err(|e| format!("方案目录解析线程错误: {e}"))??;
    Ok(plan_discussion_instructions(&plan_md_path, has_bug))
}

/// 方案执行流程：方案已定稿，直接执行；发现方案与代码现实冲突即停。
/// 执行动作统一走 implement 技能（把「本议题方案」当作 spec/工单落地）。
const PLAN_EXECUTION_FLOW: &str = "方案优先：本议题的修改方案已在「本议题方案（已定稿）」中定稿（来自多云题联合讨论），按方案直接执行改动，不要再把用户盘问一轮。请使用 implement 技能执行本次改动：把「本议题方案」当作 spec/工单，按该技能的流程落地实现并自验。执行中发现方案与代码现实冲突（文件/函数不存在、方案假设错误、影响面比方案判断更大）时，停下来在会话中说明冲突点并给出建议，等用户决策后再继续；不要擅自偏离方案。";

/// 方案讨论/执行共用的知识认知指令：直接让 Agent 调用 knowledge-graph 技能建立模块认知
///（图谱选择由技能按项目 graph.toml 自行解析，不在此注入具体图谱 id）。
const PLAN_KNOWLEDGE_INSTRUCTION: &str = "另外，开始前先使用 knowledge-graph 技能：按技能说明查询本项目绑定的知识图谱，建立对相关模块的认知（职责、代码位置、关键实体、跨模块依赖），并用实际代码验证。";

/// 方案执行任务的产物落盘：评分与影响范围进任务自己的 discussion.md；
/// 「修改方案汇总」由方案文档提供（回写时自动合并），不在此重复维护。
fn plan_execution_draft_instructions(
    task_id: &str,
    knowledge_target: Option<&crate::knowledge::KnowledgeTarget>,
) -> String {
    let knowledge_section = knowledge_target.map_or_else(String::new, |target| {
        format!(
            r#"
2. `.nezha/drafts/{task_id}/knowledge.json` —— 知识沉淀候选（任务收尾前写入）：
   - {knowledge_rules}
   - 每条候选必须携带 "knowledgeGraphId"，值必须是：{target_graph_id}
   - 输出 JSON 数组写入该文件，无候选则写 `[]`；只输出 JSON，不要附加说明文字。"#,
            task_id = task_id,
            knowledge_rules = KNOWLEDGE_SEDIMENTATION_RULES,
            target_graph_id = target.id,
        )
    });
    format!(
        r#"── 工作产物落盘（必须执行）────────────────────────────
本任务的工作产物写入当前工作目录（cwd）下的 `.nezha/drafts/{task_id}/` 目录（目录不存在就先创建）：

1. `.nezha/drafts/{task_id}/discussion.md` —— 回写云效的素材（只写本议题执行增量）：
   - 结构固定两段（按顺序）：
     a. `## 价值评分`：见上方价值评分指令，Req 写核心指数、Bug 写优先指数，附一句话结论；回写云效时与方案文档的「修改方案汇总」合并为开发向评论，数值同时写入议题「价值评分」字段。
     b. `## 影响范围与测试（测试向）`：字段固定三行——`修改分支`（本任务改动所在分支，如 master）、`修改文件`（受影响的项目/工程名，从实际改动文件路径归纳，如 Nto.His.Register.UI，多个用顿号分隔）、`测试步骤`（可执行的测试步骤与回归点）；若执行与方案一致，可基于方案文档对应节整理。
   - 「修改方案汇总」不在本文件维护（由方案文档 plan.md 提供，回写时自动合并），不要在此重复。
   - 任务收尾（结束对话前）再检查并更新一次，确保包含最终状态。{knowledge_section}"#,
        task_id = task_id,
    )
}

/// 方案执行任务的完整指令：流程（implement 执行 + knowledge-graph 认知）+ 评分 + 补录 + 产物落盘。
pub fn plan_execution_instructions(
    task_id: &str,
    knowledge_target: Option<&crate::knowledge::KnowledgeTarget>,
) -> String {
    let knowledge_graph = PLAN_KNOWLEDGE_INSTRUCTION;
    format!(
        "## 工作流程\n{flow}{knowledge_graph}\n\n## 输出与产物\n{value_score}\n\n{backfill}\n\n{draft}",
        flow = PLAN_EXECUTION_FLOW,
        knowledge_graph = if knowledge_graph.is_empty() {
            String::new()
        } else {
            format!("\n\n{knowledge_graph}")
        },
        value_score = VALUE_SCORE_INSTRUCTION,
        backfill = BACKFILL_SKILL_INSTRUCTION,
        draft = plan_execution_draft_instructions(task_id, knowledge_target),
    )
}

/// 前端在「立即运行」方案执行待办前调用（prompt 已在生成待办时定稿，此命令仅供预览/重建）。
#[tauri::command]
pub async fn get_plan_execution_instructions(
    project_path: String,
    task_id: String,
) -> Result<String, String> {
    let knowledge_target = crate::knowledge::resolve_knowledge_target(project_path)
        .await
        .ok();
    Ok(plan_execution_instructions(
        &task_id,
        knowledge_target.as_ref(),
    ))
}

// ── 直接执行链路（跳过讨论，议题即 spec）──────────────────────────────────────

/// 直接执行流程：无预生成方案文档，议题内容即 spec；执行动作同样走 implement 技能。
const DIRECT_EXECUTION_FLOW: &str = "议题即工单：本议题没有预先生成的方案文档，下方议题内容（含描述与发起人补充）就是本次改动的 spec。请使用 implement 技能执行本次改动：把议题内容当作 spec/工单，按该技能的流程落地实现并自验。执行中发现议题描述与代码现实冲突（文件/函数不存在、议题假设错误、影响面比议题判断更大）时，停下来在会话中说明冲突点并给出建议，等用户决策后再继续；不要擅自偏离议题意图。";

/// Bug 类议题直接执行时的根因取证（镜像方案讨论链路的 has_bug 提示：
/// 明确的 Bug 也不跳过取证，防止照症状修）。
const DIRECT_BUG_DIAGNOSIS_HINT: &str = "本议题是 Bug 缺陷：动手改代码前，先按 diagnosing-bugs 方法论定位根因——结论要有可复现的证据（复现步骤 / 日志 / 代码位置）；若根因与议题描述不符，停下来在会话中说明差异，等用户确认后再继续。";

/// 直接执行任务的产物落盘：discussion.md 比方案执行任务多写「修改方案汇总」段
/// （直接链路没有 plan.md，discussion.md 是回写云效的唯一素材源；
/// 回写按 `## 影响范围与测试` 前后切分开发向 / 测试向评论）。
fn direct_execution_draft_instructions(
    task_id: &str,
    knowledge_target: Option<&crate::knowledge::KnowledgeTarget>,
) -> String {
    let knowledge_section = knowledge_target.map_or_else(String::new, |target| {
        format!(
            r#"
2. `.nezha/drafts/{task_id}/knowledge.json` —— 知识沉淀候选（任务收尾前写入）：
   - {knowledge_rules}
   - 每条候选必须携带 "knowledgeGraphId"，值必须是：{target_graph_id}
   - 输出 JSON 数组写入该文件，无候选则写 `[]`；只输出 JSON，不要附加说明文字。"#,
            task_id = task_id,
            knowledge_rules = KNOWLEDGE_SEDIMENTATION_RULES,
            target_graph_id = target.id,
        )
    });
    format!(
        r#"── 工作产物落盘（必须执行）────────────────────────────
本任务的工作产物写入当前工作目录（cwd）下的 `.nezha/drafts/{task_id}/` 目录（目录不存在就先创建）：

1. `.nezha/drafts/{task_id}/discussion.md` —— 回写云效的素材（直接执行没有方案文档，本文件是唯一素材源，三段按顺序齐全）：
   - 结构固定三段（按顺序）：
     a. `## 修改方案汇总`：本议题实际做了什么改动、为什么这样改（回写时作为开发向评论的主体，承担方案文档的角色）；
     b. `## 价值评分`：见上方价值评分指令，Req 写核心指数、Bug 写优先指数，附一句话结论；数值同时写入议题「价值评分」字段。
     c. `## 影响范围与测试（测试向）`：字段固定三行——`修改分支`（本任务改动所在分支，如 master）、`修改文件`（受影响的项目/工程名，从实际改动文件路径归纳，如 Nto.His.Register.UI，多个用顿号分隔）、`测试步骤`（可执行的测试步骤与回归点）。
   - 任务收尾（结束对话前）再检查并更新一次，确保包含最终状态。{knowledge_section}"#,
        task_id = task_id,
    )
}

/// 直接执行任务的完整指令：流程（议题即 spec + Bug 根因取证 + knowledge-graph 认知）+
/// 评分 + 补录 + 产物落盘。has_bug 由议题类别推导（categoryId == bug）。
pub fn direct_execution_instructions(
    task_id: &str,
    has_bug: bool,
    knowledge_target: Option<&crate::knowledge::KnowledgeTarget>,
) -> String {
    let mut pieces: Vec<String> = vec![format!("## 工作流程\n{}", DIRECT_EXECUTION_FLOW)];
    if has_bug {
        pieces.push(DIRECT_BUG_DIAGNOSIS_HINT.to_string());
    }
    pieces.push(PLAN_KNOWLEDGE_INSTRUCTION.to_string());
    pieces.push(format!("## 输出与产物\n{}", VALUE_SCORE_INSTRUCTION));
    pieces.push(BACKFILL_SKILL_INSTRUCTION.to_string());
    pieces.push(direct_execution_draft_instructions(task_id, knowledge_target));
    pieces.join("\n\n")
}

/// 直接执行链路：议题列表 / 绑定待办「直接开始」时由前端调用组装 prompt。
#[tauri::command]
pub async fn get_direct_execution_instructions(
    project_path: String,
    task_id: String,
    has_bug: Option<bool>,
) -> Result<String, String> {
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() || task_id.contains('/') || task_id.contains('\\') || task_id.contains("..")
    {
        return Err("非法的任务 ID".to_string());
    }
    let knowledge_target = crate::knowledge::resolve_knowledge_target(project_path)
        .await
        .ok();
    Ok(direct_execution_instructions(
        &task_id,
        has_bug.unwrap_or(false),
        knowledge_target.as_ref(),
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
   - 测试向评论：<TEST_SUMMARY>...</TEST_SUMMARY>，面向测试人员，固定为「影响范围与测试指引」，字段固定三行：
     - 修改分支：直接使用下方给定的「修改分支」，不要改动、不要编造；
     - 修改文件：受影响的项目/工程名（从变更统计的文件路径归纳，如 Nto.His.Register.UI），多个用顿号分隔；
     - 测试步骤：给出可执行的测试步骤与回归点。
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

/// 云效回写草稿：开发向与测试向两条评论。
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YunxiaoWritebackDraft {
    pub dev_comment: String,
    pub test_comment: String,
}

/// discussion.md 中「影响范围与测试」小节标题前缀。
const TEST_SECTION_HEADER: &str = "## 影响范围与测试";

/// 把 discussion.md 拆成（开发向评论，测试向评论）：
/// - 开发向 = 从开头到 `## 影响范围与测试` 之前（含 `## 修改方案汇总` 与 `## 价值评分`）；
/// - 测试向 = 从 `## 影响范围与测试` 到文档末尾。
/// 找不到测试小节时：整篇归开发向，测试向为空串（由前端补填/走 headless 再生成）。
fn split_discussion_into_comments(text: &str) -> (String, String) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new());
    }
    if let Some(pos) = trimmed.find(TEST_SECTION_HEADER) {
        let dev = trimmed[..pos].trim();
        let test = trimmed[pos..].trim();
        (dev.to_string(), test.to_string())
    } else {
        (trimmed.to_string(), String::new())
    }
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
        "## 影响范围与测试指引\n\n- 修改分支：{}\n- 修改文件：（无）\n- 测试步骤：请在预览中补充。",
        if branch.trim().is_empty() {
            "（无）"
        } else {
            branch.trim()
        },
    );
    YunxiaoWritebackDraft {
        dev_comment: dev.join("\n"),
        test_comment: test,
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

/// 方案任务回写合并：开发向 = 方案节（修改方案汇总）+ 任务 drafts 的价值评分；
/// 测试向 = 任务 drafts 的影响范围（执行修订版）优先，回落方案节的测试小节。
fn merge_plan_writeback_draft(
    plan_section: &str,
    task_drafts: Option<&str>,
) -> YunxiaoWritebackDraft {
    let (plan_dev, plan_test) = split_plan_section(plan_section);
    let (drafts_test, score_section) = task_drafts
        .map(|drafts| {
            let (drafts_dev, drafts_test) = split_discussion_into_comments(drafts);
            let score = crate::value_score::extract_value_score_section(&drafts_dev)
                .map(str::to_string);
            (drafts_test, score)
        })
        .unwrap_or((String::new(), None));
    let dev_comment =
        crate::value_score::reappend_value_score_section(&plan_dev, score_section.as_deref());
    let test_comment = if drafts_test.trim().is_empty() {
        plan_test
    } else {
        drafts_test
    };
    YunxiaoWritebackDraft {
        dev_comment,
        test_comment,
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
        return Ok(merge_plan_writeback_draft(plan_section, task_drafts.as_deref()));
    }

    // 草稿优先（force=true 表示用户点了「重新生成」，跳过草稿走 headless）。
    if !force.unwrap_or(false) {
        if let Some(draft) =
            crate::drafts::read_draft_file(&project_path, &task_id, "discussion.md")
                .map_err(|e| format!("读取讨论草稿失败: {e}"))?
                .filter(|s| !s.trim().is_empty())
        {
            let (dev_comment, test_comment) = split_discussion_into_comments(&draft);
            return Ok(YunxiaoWritebackDraft {
                dev_comment,
                test_comment,
            });
        }
    }

    // 重新生成（force=true）会跳过草稿走 headless 润色，这里先把草稿里的
    // 「价值评分」小节保留下来，生成后拼到开发向评论末尾（评分推导随开发向评论发布）。
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
    let (branch, commits, diff_stat) = tokio::task::spawn_blocking(move || {
        gather_writeback_facts(&cwd_for_facts, base_for_facts.as_deref())
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
    let dev_comment =
        crate::value_score::reappend_value_score_section(&dev, preserved_score_section.as_deref());
    Ok(YunxiaoWritebackDraft {
        dev_comment,
        test_comment: test,
    })
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
    /// 生成候选时绑定的知识图谱，防止配置切换后旧草稿跨库写入。
    #[serde(default)]
    pub knowledge_graph_id: String,
}

const SEDIMENTATION_PROMPT_TEMPLATE: &str = r#"你是知识沉淀助手。基于下面的会话过程与云效议题信息，对照项目绑定的知识图谱，识别「有价值且图谱中没有」的知识，按给定格式输出候选。

严格遵循下方 <KNOWLEDGE_RULES> 内的提取规则，并按其判定标准、比对方法与输出格式输出。

<KNOWLEDGE_RULES>
{knowledge_rules}
</KNOWLEDGE_RULES>

每条候选必须携带 "knowledgeGraphId"，值必须是：{target_graph_id}

──── 云效议题 ────
编号：{serial_number}
标题：{task_name}
链接：{link}

──── 会话过程 ────
{session_text}

──── 知识图谱数据目录 ────
技能目录：{graph_skill_dir}
{graph_data_dir}

先读取技能目录下的 SKILL.md，再按数据目录查询图谱。

──── 项目根目录 ────
{project_path}

只输出 <SUGGESTIONS> 与 </SUGGESTIONS> 之间的 JSON 数组，标签外不要输出任何内容。
"#;

fn build_sedimentation_prompt(
    knowledge_rules: &str,
    serial_number: &str,
    task_name: &str,
    link: &str,
    session_text: &str,
    graph_skill_dir: &str,
    graph_data_dir: &str,
    target_graph_id: &str,
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
        .replace("{knowledge_rules}", knowledge_rules.trim())
        .replace("{serial_number}", serial_number.trim())
        .replace("{task_name}", &placeholder(task_name))
        .replace("{link}", &placeholder(link))
        .replace("{session_text}", &placeholder(session_text))
        .replace("{graph_skill_dir}", graph_skill_dir.trim())
        .replace("{graph_data_dir}", graph_data_dir.trim())
        .replace("{target_graph_id}", target_graph_id.trim())
        .replace("{project_path}", project_path.trim())
}

/// 解析候选知识 JSON 数组并规范化字段（模块/段落缺失的条目丢弃）。
fn parse_suggestions_json(inner: &str) -> Result<Vec<KnowledgeSuggestion>, String> {
    let parsed: Vec<serde_json::Value> =
        serde_json::from_str(inner).map_err(|e| format!("解析候选知识 JSON 失败: {e}"))?;
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

/// 提取 `<SUGGESTIONS>...</SUGGESTIONS>` 内的 JSON 数组并规范化字段。
fn extract_suggestions(stdout: &str) -> Result<Vec<KnowledgeSuggestion>, String> {
    const OPEN: &str = "<SUGGESTIONS>";
    const CLOSE: &str = "</SUGGESTIONS>";
    let inner = stdout
        .rfind(CLOSE)
        .and_then(|close_pos| {
            let prefix = &stdout[..close_pos];
            prefix
                .rfind(OPEN)
                .map(|open_pos| prefix[open_pos + OPEN.len()..].trim().to_string())
        })
        .ok_or_else(|| "未找到 <SUGGESTIONS> 输出标签".to_string())?;
    parse_suggestions_json(&inner)
}

/// 解析草稿 `knowledge.json`：直接 JSON 数组，或带 `<SUGGESTIONS>` 标签（兼容 headless 输出）。
fn parse_knowledge_suggestions(raw: &str) -> Result<Vec<KnowledgeSuggestion>, String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('[') {
        parse_suggestions_json(trimmed)
    } else {
        extract_suggestions(raw)
    }
}

/// 生成知识沉淀候选：
/// - 草稿优先：会话收尾时已落盘的 `knowledge.json` 直接作为候选（秒开）；
/// - 无草稿 / 解析失败 / force=true 时：内置提取规则 + headless 重新提取
///   （knowledge-sedimentation 技能已废弃，规则内嵌，不再读取技能仓库）。
#[tauri::command]
pub async fn generate_knowledge_sedimentation(
    project_path: String,
    task_id: String,
    serial_number: String,
    task_name: String,
    link: String,
    session_path: Option<String>,
    agent: String,
    force: Option<bool>,
) -> Result<Vec<KnowledgeSuggestion>, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {}", agent));
    }
    let project_for_validation = project_path.clone();
    tokio::task::spawn_blocking(move || validate_project_path_for_naming(&project_for_validation))
        .await
        .map_err(|e| format!("project_path 校验线程错误: {e}"))??;

    // 项目绑定哪个知识库，就对照哪个知识库；未绑定/不可用时直接失败，避免默认误入 HIS。
    let knowledge_target = crate::knowledge::resolve_knowledge_target(project_path.clone()).await?;
    let graph_data_dir = knowledge_target.data_dir.clone();

    // 草稿优先（force=true 表示用户点了「重新生成」，跳过草稿走 headless）。
    if !force.unwrap_or(false) {
        if let Some(raw) = crate::drafts::read_draft_file(&project_path, &task_id, "knowledge.json")
            .map_err(|e| format!("读取知识沉淀草稿失败: {e}"))?
            .filter(|s| !s.trim().is_empty())
        {
            if let Ok(suggestions) = parse_knowledge_suggestions(&raw) {
                let bound_to_target = suggestions
                    .iter()
                    .all(|suggestion| suggestion.knowledge_graph_id == knowledge_target.id);
                if bound_to_target {
                    return Ok(suggestions);
                }
                eprintln!(
                    "[sedimentation] draft knowledge.json bound to another graph; regenerating"
                );
            } else {
                eprintln!(
                    "[sedimentation] draft knowledge.json parse failed, falling back to headless"
                );
            }
        }
    }

    // 会话摘要（校验失败/超限时降级为无会话模式）
    let session_text = match session_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
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
        KNOWLEDGE_SEDIMENTATION_RULES,
        &serial_number,
        task_name.trim(),
        &link,
        &session_text,
        &knowledge_target.skill_dir,
        &graph_data_dir,
        &knowledge_target.id,
        &project_path,
    );
    let output = run_headless_agent_with_timeout(
        &agent,
        &project_path,
        &prompt,
        SEDIMENTATION_TIMEOUT,
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
    extract_suggestions(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_discussion_references_skill_and_dynamic_params() {
        let prompt = plan_discussion_instructions("H:/proj/.nezha/plans/p1/plan.md", false);
        // 技能引用 + plan.md 动态路径必须齐备；流程与文档契约文本由技能承载，不再内联。
        assert!(prompt.contains("yunxiao-plan-discussion"));
        assert!(prompt.contains("H:/proj/.nezha/plans/p1/plan.md"));
        // 图谱 id 不能被当成技能名；知识认知与补录细节由技能/执行路径承载，讨论提示词不内联。
        assert!(!prompt.contains("使用 `ICUCIS` 技能"));
        assert!(!prompt.contains("knowledge-graph"));
        assert!(!prompt.contains("NEZHA_TASK_ID"));
    }

    #[test]
    fn direct_execution_instructions_compose_flow_and_drafts() {
        let prompt = direct_execution_instructions("9001", true, None);
        // 议题即 spec 流程 + Bug 根因取证 + 知识认知全注入。
        assert!(prompt.contains("议题即工单"));
        assert!(prompt.contains("diagnosing-bugs"));
        assert!(prompt.contains("knowledge-graph"));
        // discussion.md 三段结构（直接链路无方案文档，本文件是回写唯一素材源）。
        assert!(prompt.contains(".nezha/drafts/9001/discussion.md"));
        assert!(prompt.contains("## 修改方案汇总"));
        assert!(prompt.contains("## 价值评分"));
        assert!(prompt.contains("## 影响范围与测试"));
        assert!(prompt.contains("backfill-issue.json"));
        // 无图谱目标时不出现 knowledge.json 落盘段（补录指令文本里会提及该文件名，
        // 故断言用具体落盘路径）。
        assert!(!prompt.contains(".nezha/drafts/9001/knowledge.json"));
    }

    #[test]
    fn direct_execution_instructions_bug_hint_conditional() {
        let no_bug = direct_execution_instructions("9002", false, None);
        assert!(!no_bug.contains("diagnosing-bugs"));
        assert!(no_bug.contains("knowledge-graph"));
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
    fn split_discussion_splits_dev_and_test_sections() {
        let text = "## 修改方案汇总（开发向）\n\nWhat…\n\n## 价值评分\n\n- 核心指数：**50** = (4 × 5 × 5) ÷ 2\n\n## 影响范围与测试（测试向）\n\n- 影响范围：模块A\n- 测试步骤：1. …";
        let (dev, test) = split_discussion_into_comments(text);
        assert!(dev.contains("修改方案汇总"));
        assert!(dev.contains("## 价值评分"));
        assert!(dev.contains("核心指数"));
        assert!(!dev.contains("影响范围与测试"));
        assert!(test.contains("影响范围与测试"));
        assert!(test.contains("模块A"));
    }

    #[test]
    fn split_discussion_without_test_section_keeps_all_in_dev() {
        let text = "## 修改方案汇总\n\n内容";
        let (dev, test) = split_discussion_into_comments(text);
        assert_eq!(dev, "## 修改方案汇总\n\n内容");
        assert!(test.is_empty());
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
        let with_bug = plan_discussion_instructions("C:/p/.nezha/plans/1/plan.md", true);
        assert!(with_bug.contains("diagnosing-bugs"));
        assert!(with_bug.contains("Bug 根因诊断"));

        let without_bug = plan_discussion_instructions("C:/p/.nezha/plans/1/plan.md", false);
        assert!(!without_bug.contains("diagnosing-bugs"));
        assert!(without_bug.contains("Bug 根因诊断"));
    }

    #[test]
    fn parses_knowledge_suggestions_from_plain_json_array() {
        let raw = r#"[{"module":"Nto.His.Register","section":"业务规则与已知坑","content":"规则","evidence":"代码","confidence":"confirmed","suggestedTitle":"挂号规则"}]"#;
        let suggestions = parse_knowledge_suggestions(raw).expect("parses");
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].module, "Nto.His.Register");
        assert_eq!(suggestions[0].confidence, "confirmed");
    }

    #[test]
    fn parses_knowledge_suggestions_from_tagged_output() {
        let raw = "<SUGGESTIONS>[{\"module\":\"M\",\"section\":\"职责\",\"content\":\"c\",\"evidence\":\"e\",\"confidence\":\"pending\",\"suggestedTitle\":\"t\"}]</SUGGESTIONS>";
        let suggestions = parse_knowledge_suggestions(raw).expect("parses");
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].module, "M");
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
            "会话",
            "C:/skills/ICUCIS",
            "C:/data",
            "ICUCIS",
            "C:/proj",
        );
        assert!(prompt.contains("技能规则"));
        assert!(prompt.contains("QHDK-1"));
        assert!(prompt.contains("C:/skills/ICUCIS"));
        assert!(prompt.contains("C:/data"));
        assert!(prompt.contains("ICUCIS"));
        assert!(prompt.contains("C:/proj"));
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
                "prompt text",
            ]
        );
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
}
