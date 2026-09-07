use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::agent_assist::run_headless_agent_with_timeout;

#[derive(Serialize, Clone)]
pub struct WeeklyReport {
    pub week_start: String,
    pub week_end: String,
    pub total_sessions: usize,
    pub involved_projects: usize,
    pub total_git: usize,
    pub by_project: Vec<ProjectReport>,
    pub git: Vec<GitCommit>,
    pub markdown: String,
}

#[derive(Serialize, Clone)]
pub struct ProjectReport {
    pub project: String,
    pub sessions: usize,
    pub days: Vec<DayRow>,
    pub commits: Vec<CommitEntry>,
}

#[derive(Serialize, Clone)]
pub struct CommitEntry {
    pub date: String,
    pub subject: String,
}

#[derive(Serialize, Clone)]
pub struct DayRow {
    pub date: String,
    pub topics: Vec<String>,
    pub count: usize,
}

#[derive(Serialize, Clone)]
pub struct GitCommit {
    pub project: String,
    pub count: usize,
}

#[derive(Clone)]
struct Project {
    name: String,
    path: String,
    path_lower: String,
}

#[tauri::command]
pub async fn build_weekly_report(week: Option<String>) -> Result<WeeklyReport, String> {
    let arg = week.unwrap_or_else(|| "last".to_string());
    tokio::task::spawn_blocking(move || build(arg))
        .await
        .map_err(|e| e.to_string())?
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

fn resolve_week(arg: &str) -> Option<(NaiveDate, NaiveDate)> {
    let today = Local::now().date_naive();
    let dow = today.weekday().num_days_from_monday() as i64; // Mon=0 .. Sun=6
    let this_mon = today - ChronoDuration::days(dow);
    match arg {
        "this" => Some((this_mon, this_mon + ChronoDuration::days(7))),
        "" | "last" => Some((this_mon - ChronoDuration::days(7), this_mon)),
        other => {
            let d = NaiveDate::parse_from_str(other, "%Y-%m-%d").ok()?;
            Some((d, d + ChronoDuration::days(7)))
        }
    }
}

fn build(arg: String) -> Result<WeeklyReport, String> {
    let home = home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    let (start, end_excl) = resolve_week(&arg).ok_or_else(|| format!("invalid week: {arg}"))?;
    let start_ms = start.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis();
    let end_ms = end_excl.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis();
    let projects = load_projects(&home);
    let codex_root = home.join(".codex").join("sessions");
    let claude_root = home.join(".claude").join("projects");

    let mut project_days: BTreeMap<String, BTreeMap<String, (BTreeSet<String>, usize)>> = BTreeMap::new();
    let mut project_count: BTreeMap<String, usize> = BTreeMap::new();

    // codex: bucket by folder date YYYY/MM/DD
    for file in collect_jsonl(&codex_root) {
        let when = folder_date(&codex_root, &file);
        let day_ms = match parse_folder_date_ms(&when) {
            Some(v) => v,
            None => continue,
        };
        if day_ms < start_ms || day_ms >= end_ms {
            continue;
        }
        let (cwd, first_msg) = scan_session(&file);
        let project = project_for(cwd.as_deref().unwrap_or(""), &projects);
        add_session(&mut project_days, &mut project_count, &project, &when[5..], first_msg.as_deref());
    }

    // claude: bucket by file mtime, best-effort project map
    for file in collect_jsonl(&claude_root) {
        let Ok(meta) = std::fs::metadata(&file) else { continue };
        let modified = meta.modified().map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)).unwrap_or(0);
        if modified < start_ms || modified >= end_ms {
            continue;
        }
        let project = claude_project_for(&file, &projects);
        let (_, first_msg) = scan_session(&file);
        let day = local_date(modified);
        add_session(&mut project_days, &mut project_count, &project, &day, first_msg.as_deref());
    }

    let rows = git_rows(&projects, &start, &end_excl);
    let git: Vec<GitCommit> = rows
        .iter()
        .filter(|(_, commits)| !commits.is_empty())
        .map(|(name, commits)| GitCommit { project: name.clone(), count: commits.len() })
        .collect();
    let project_commits: BTreeMap<String, Vec<CommitEntry>> = rows.into_iter().collect();

    let by_project = build_projects(&project_days, &project_count, &project_commits);
    let total_sessions: usize = project_count.values().sum();
    let involved_projects = by_project.len();

    let total_git: usize = git.iter().map(|g| g.count).sum();

    let week_start = start.format("%Y-%m-%d").to_string();
    let week_end = (end_excl - ChronoDuration::days(1)).format("%Y-%m-%d").to_string();
    let markdown = render_markdown(&week_start, &week_end, total_sessions, involved_projects, total_git, &by_project, &git);

    Ok(WeeklyReport {
        week_start,
        week_end,
        total_sessions,
        involved_projects,
        total_git,
        by_project,
        git,
        markdown,
    })
}

fn load_projects(home: &Path) -> Vec<Project> {
    let file = home.join(".nezha").join("projects.json");
    let Ok(text) = std::fs::read_to_string(file) else { return vec![] };
    let Ok(arr) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
    arr.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    let name = v.get("name")?.as_str()?.to_string();
                    let path = v.get("path")?.as_str()?.to_string();
                    let path_lower = path.to_lowercase();
                    Some(Project { name, path, path_lower })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn project_for(cwd: &str, projects: &[Project]) -> String {
    if cwd.is_empty() {
        return "(临时 worktree)".to_string();
    }
    let key = cwd.to_lowercase();
    let mut best: Option<&str> = None;
    let mut best_len = 0;
    for p in projects {
        if key.starts_with(&p.path_lower) && p.path_lower.len() > best_len {
            best = Some(&p.name);
            best_len = p.path_lower.len();
        }
    }
    best.unwrap_or("(临时 worktree)").to_string()
}

fn claude_project_for(file: &Path, projects: &[Project]) -> String {
    let parent = file
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    for p in projects {
        let base = p.path_lower.rsplit(['\\', '/']).next().unwrap_or("");
        if !base.is_empty() && parent.contains(base) {
            return p.name.clone();
        }
    }
    "Claude 会话".to_string()
}

fn collect_jsonl(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                out.push(p);
            }
        }
    }
    if root.exists() {
        walk(root, &mut out);
    }
    out
}

fn folder_date(root: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(root).ok();
    match rel {
        Some(r) => r.components().take(3).map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("-"),
        None => String::new(),
    }
}

fn parse_folder_date_ms(when: &str) -> Option<i64> {
    NaiveDate::parse_from_str(when, "%Y-%m-%d")
        .ok()
        .map(|d| d.and_hms_opt(12, 0, 0).unwrap().and_utc().timestamp_millis())
}

fn local_date(ms: i64) -> String {
    let secs = ms / 1000;
    let dt = chrono::DateTime::from_timestamp(secs, 0).unwrap_or_default();
    dt.with_timezone(&Local).format("%m-%d").to_string()
}

fn scan_session(file: &Path) -> (Option<String>, Option<String>) {
    let mut cwd = None;
    let mut first_msg = None;
    let Ok(f) = std::fs::File::open(file) else { return (cwd, first_msg) };
    let reader = BufReader::new(f);
    let mut n = 0;
    for line in reader.lines() {
        n += 1;
        if n > 3000 || (cwd.is_some() && first_msg.is_some()) {
            break;
        }
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let Some(t) = v.get("type").and_then(|x| x.as_str()) else { continue };
        if t == "session_meta" && cwd.is_none() {
            if let Some(c) = v.pointer("/payload/cwd").and_then(|x| x.as_str()) {
                cwd = Some(c.to_string());
            }
        } else if t == "event_msg" && first_msg.is_none() {
            if v.pointer("/payload/type").and_then(|x| x.as_str()) == Some("user_message") {
                if let Some(m) = v.pointer("/payload/message").and_then(|x| x.as_str()) {
                    first_msg = Some(m.to_string());
                }
            }
        }
    }
    (cwd, first_msg)
}

fn clean_topic(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // strip [Image #N] / [Image #1] occurrences
    loop {
        let Some(start) = s.find("[Image") else { break };
        let Some(end) = s[start..].find(']').map(|i| start + i + 1) else { break };
        s = format!("{}{}", &s[..start], &s[end..]);
    }
    // strip leading $command
    if let Some(stripped) = s.strip_prefix('$') {
        if let Some(sp) = stripped.find(' ') {
            s = stripped[sp + 1..].trim().to_string();
        } else {
            s = String::new();
        }
    }
    let mut out = String::new();
    let mut prev_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    let out = out.trim().to_string();
    if out.chars().count() > 40 {
        let short: String = out.chars().take(40).collect();
        format!("{short}…")
    } else {
        out
    }
}

fn add_session(
    project_days: &mut BTreeMap<String, BTreeMap<String, (BTreeSet<String>, usize)>>,
    project_count: &mut BTreeMap<String, usize>,
    project: &str,
    day: &str,
    topic: Option<&str>,
) {
    let days = project_days.entry(project.to_string()).or_default();
    let entry = days.entry(day.to_string()).or_insert_with(|| (BTreeSet::new(), 0));
    entry.1 += 1;
    if let Some(t) = topic {
        let clean = clean_topic(t);
        if !clean.is_empty() {
            entry.0.insert(clean);
        }
    }
    *project_count.entry(project.to_string()).or_insert(0) += 1;
}

fn build_projects(
    project_days: &BTreeMap<String, BTreeMap<String, (BTreeSet<String>, usize)>>,
    project_count: &BTreeMap<String, usize>,
    project_commits: &BTreeMap<String, Vec<CommitEntry>>,
) -> Vec<ProjectReport> {
    let mut list: Vec<ProjectReport> = project_days
        .iter()
        .map(|(project, days)| {
            let mut days_vec: Vec<DayRow> = days
                .iter()
                .map(|(date, (topics, count))| DayRow {
                    date: date.clone(),
                    topics: topics.iter().take(3).cloned().collect(),
                    count: *count,
                })
                .collect();
            days_vec.sort_by(|a, b| a.date.cmp(&b.date));
            ProjectReport {
                project: project.clone(),
                sessions: *project_count.get(project).unwrap_or(&0),
                days: days_vec,
                commits: project_commits.get(project).cloned().unwrap_or_default(),
            }
        })
        .collect();
    // include projects that only had commits (no recorded sessions)
    for (project, commits) in project_commits {
        if !list.iter().any(|p| &p.project == project) {
            list.push(ProjectReport {
                project: project.clone(),
                sessions: *project_count.get(project).unwrap_or(&0),
                days: vec![],
                commits: commits.clone(),
            });
        }
    }
    list.sort_by(|a, b| (b.sessions + b.commits.len()).cmp(&(a.sessions + a.commits.len())));
    list
}

fn git_log_commits(repo: &str, since: &NaiveDate, until_excl: &NaiveDate) -> Vec<CommitEntry> {
    let since_str = since.format("%Y-%m-%d").to_string();
    let until_str = (*until_excl - ChronoDuration::days(1)).format("%Y-%m-%d").to_string();
    let out = Command::new("git")
        .args([
            "-C",
            repo,
            "log",
            &format!("--since={since_str} 00:00:00"),
            &format!("--until={until_str} 23:59:59"),
            "--date=format:%Y-%m-%d",
            "--format=%ad%x09%s",
            "--no-merges",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|line| {
                let (date, subject) = line.split_once('\t')?;
                let subject = subject.trim();
                if subject.is_empty() {
                    None
                } else {
                    Some(CommitEntry {
                        date: date.to_string(),
                        subject: subject.to_string(),
                    })
                }
            })
            .collect(),
        _ => vec![],
    }
}

fn git_rows(projects: &[Project], start: &NaiveDate, end_excl: &NaiveDate) -> Vec<(String, Vec<CommitEntry>)> {
    projects
        .iter()
        .map(|p| (p.name.clone(), git_log_commits(&p.path, start, end_excl)))
        .collect()
}

fn render_markdown(
    week_start: &str,
    week_end: &str,
    total_sessions: usize,
    involved_projects: usize,
    total_git: usize,
    by_project: &[ProjectReport],
    git: &[GitCommit],
) -> String {
    let mut md = String::new();
    md.push_str(&format!("# 周报 · {week_start} ~ {week_end}\n\n"));
    md.push_str("> 统计范围：自然周（周一 → 周日）· 覆盖该周所有 agent 会话 · 确定性数据，无 AI 生成\n\n");
    md.push_str("## 本周工作量\n\n");
    md.push_str("| 指标 | 数值 |\n| --- | --- |\n");
    md.push_str(&format!("| 会话数 | **{total_sessions}** |\n"));
    md.push_str(&format!("| 涉及项目 | {involved_projects} |\n"));
    md.push_str(&format!("| git 提交 | **{total_git}** |\n"));
    md.push_str("\n**各项目会话数**\n\n| 项目 | 会话数 |\n| --- | --- |\n");
    for p in by_project {
        md.push_str(&format!("| {} | {} |\n", p.project, p.sessions));
    }
    md.push_str("\n## 本周做了什么\n");
    for p in by_project {
        let commits_label = if p.commits.is_empty() {
            String::new()
        } else {
            format!(" · {} 个提交", p.commits.len())
        };
        md.push_str(&format!("\n### {}（{} 条会话{}）\n", p.project, p.sessions, commits_label));
        if p.commits.is_empty() {
            for d in &p.days {
                let topic = if d.topics.is_empty() { "(无主题)".to_string() } else { d.topics.join(" · ") };
                md.push_str(&format!("- **{}** {}（{} 条会话）\n", d.date, topic, d.count));
            }
        } else {
            for c in &p.commits {
                md.push_str(&format!("- **{}** {}\n", c.date, c.subject));
            }
        }
    }
    md.push_str("\n## Git 提交\n\n| 项目 | 提交数 |\n| --- | --- |\n");
    for g in git {
        md.push_str(&format!("| {} | {} |\n", g.project, g.count));
    }
    md
}

const SUMMARY_TIMEOUT_SECS: u64 = 240;

fn facts_markdown(r: &WeeklyReport) -> String {
    let mut s = String::new();
    s.push_str(&format!("统计周期：{} ~ {}\n", r.week_start, r.week_end));
    s.push_str(&format!(
        "总计：agent 会话 {} 次，涉及项目 {} 个，git 提交 {} 个。\n\n",
        r.total_sessions, r.involved_projects, r.total_git
    ));
    for p in &r.by_project {
        s.push_str(&format!("### {}（会话 {}，提交 {}）\n", p.project, p.sessions, p.commits.len()));
        if !p.commits.is_empty() {
            s.push_str("提交：\n");
            for c in p.commits.iter().take(12) {
                s.push_str(&format!("- [{}] {}\n", c.date, c.subject));
            }
        }
        if !p.days.is_empty() {
            s.push_str("会话主题（部分）：\n");
            for d in p.days.iter().take(8) {
                let topic = if d.topics.is_empty() { "(无主题)".to_string() } else { d.topics.join(" · ") };
                s.push_str(&format!("- {} {}（{} 条）\n", d.date, topic, d.count));
            }
        }
        s.push('\n');
    }
    s
}

fn summary_prompt(facts: &str) -> String {
    format!(
        "你是资深研发周报助手。请**仅依据**下面给出的本周事实证据（agent 会话 + git 提交）综合分析，回答「本周到底做了什么」。要求：\n\
         - 按项目/主题归纳本周已完成的工作与关键成果，突出交付与影响，语言简洁；\n\
         - 如有明显迹象，指出未完成事项或卡点（没有就跳过，不要编造）；\n\
         - 不要罗列原始会话或提交流水账，不编造证据中不存在的内容；\n\
         - 用 Markdown（可用小标题与列表），控制在 300-400 字；\n\
         - 只输出以 <SUMMARY> 开头、</SUMMARY> 结尾的内容，中间为 Markdown 正文，不要任何其他文字。\n\n==== 本周事实证据 ====\n{facts}"
    )
}

fn extract_summary(raw: &str) -> String {
    if let Some(s) = raw.find("<SUMMARY>") {
        let body_start = s + "<SUMMARY>".len();
        if let Some(rel) = raw[body_start..].find("</SUMMARY>") {
            let inner = raw[body_start..body_start + rel].trim().to_string();
            if !inner.is_empty() {
                return inner;
            }
        }
    }
    let mut lines: Vec<&str> = raw.trim().lines().collect();
    while lines
        .last()
        .map(|l| l.trim().is_empty() || l.contains("tokens used") || l.trim().starts_with("──"))
        .unwrap_or(false)
    {
        lines.pop();
    }
    lines.join("\n").trim().to_string()
}

#[tauri::command]
pub async fn generate_weekly_summary(week: Option<String>) -> Result<String, String> {
    let arg = week.unwrap_or_else(|| "last".to_string());
    let report = build(arg)?;
    let facts = facts_markdown(&report);
    let prompt = summary_prompt(&facts);
    let home = home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    // Run the headless agent in a real project (git repo) dir, like other headless
    // calls (generate_task_name), so codex's git-repo check passes.
    let projects = load_projects(&home);
    let cwd = projects
        .first()
        .map(|p| p.path.clone())
        .unwrap_or_else(|| home.to_string_lossy().into_owned());
    let output = run_headless_agent_with_timeout(
        "codex",
        &cwd,
        &prompt,
        Duration::from_secs(SUMMARY_TIMEOUT_SECS),
        false,
        None,
    )
    .await?;
    if !output.status.success() {
        return Err(format!("summary agent failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    let summary = extract_summary(&raw);
    if summary.is_empty() {
        return Err("summary agent returned empty response".to_string());
    }
    Ok(summary)
}
