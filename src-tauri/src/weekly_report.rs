use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;

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

    let by_project = build_projects(&project_days, &project_count);
    let total_sessions: usize = project_count.values().sum();
    let involved_projects = project_count.len();

    let git = build_git(&projects, &start, &end_excl);
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
            }
        })
        .collect();
    list.sort_by(|a, b| b.sessions.cmp(&a.sessions));
    list
}

fn git_log_count(repo: &str, since: &NaiveDate, until_excl: &NaiveDate) -> usize {
    let since_str = since.format("%Y-%m-%d").to_string();
    let until_str = (*until_excl - ChronoDuration::days(1)).format("%Y-%m-%d").to_string();
    let out = Command::new("git")
        .args(["-C", repo, "log", &format!("--since={since_str} 00:00:00"), &format!("--until={until_str} 23:59:59"), "--format=%h", "--no-merges"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).lines().count(),
        _ => 0,
    }
}

fn build_git(projects: &[Project], start: &NaiveDate, end_excl: &NaiveDate) -> Vec<GitCommit> {
    let mut v: Vec<GitCommit> = projects
        .iter()
        .map(|p| GitCommit { project: p.name.clone(), count: git_log_count(&p.path, start, end_excl) })
        .collect();
    v.retain(|g| g.count > 0);
    v
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
        md.push_str(&format!("\n### {}\n", p.project));
        for d in &p.days {
            let topic = if d.topics.is_empty() { "(无主题)".to_string() } else { d.topics.join(" · ") };
            md.push_str(&format!("- **{}** {}（{} 条会话）\n", d.date, topic, d.count));
        }
    }
    md.push_str("\n## Git 提交\n\n| 项目 | 提交数 |\n| --- | --- |\n");
    for g in git {
        md.push_str(&format!("| {} | {} |\n", g.project, g.count));
    }
    md
}
