//! 知识沉淀自动回写：把通过「规则 + Agent」两层质量门的知识候选写入技能库
//! `his-knowledge-graph/data/modules/<module>.md`，并 git 提交推送，
//! 替代「知识库负责人手工更新模块卡片」这最后一公里。
//!
//! 设计要点（与产品决策一致）：
//! - 规则层（不调 LLM）：evidence 非空、confidence=confirmed、模块/section 合法、
//!   目标文件存在、内容未重复。挡掉明显不合格的候选，零成本、确定性。
//! - Agent 层：一次 headless 调用批量语义质检（去重 / 冲突 / 依据相关性），
//!   技能规则由 SkillHub 的 `knowledge-quality-gate` 统一维护。
//! - 只增不改：在对应 section 末尾追加「日期 + 置信度 + 内容 + 依据」，保留既有内容。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 前端传入的知识沉淀候选（与 KnowledgeSuggestion 对齐，camelCase）。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCandidate {
    pub module: String,
    pub section: String,
    pub content: String,
    pub evidence: String,
    pub confidence: String,
    #[serde(default)]
    pub suggested_title: String,
}

/// 单条候选的回写结果。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeWritebackItem {
    pub index: usize,
    pub module: String,
    pub section: String,
    pub passed: bool,
    pub written: bool,
    pub reason: String,
}

/// 一次提交的整体回写结果。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeWritebackResult {
    pub items: Vec<KnowledgeWritebackItem>,
    pub all_passed: bool,
    pub written_count: usize,
    pub commit: Option<String>,
}

const QUALITY_GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// section 标题归一化：去空白、`/` 归并为「与」，让候选的
/// 「关键实体与数据表」能命中文档里的「关键实体 / 数据表」标题。
fn normalize_section(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| if c == '/' { '与' } else { c })
        .collect()
}

/// 模块名只允许字母/数字/点/下划线/连字符，杜绝路径穿越。
fn module_is_safe(module: &str) -> bool {
    !module.is_empty()
        && module
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// 候选对应的模块卡片路径；调用方需先确认 hub 根存在。
fn module_doc_path(hub: &Path, module: &str) -> PathBuf {
    hub.join("his-knowledge-graph")
        .join("data")
        .join("modules")
        .join(format!("{module}.md"))
}

/// 在模块文档中定位 section 标题行号（`## <标题>`），按归一化标题匹配。
fn find_section_heading(lines: &[&str], section: &str) -> Option<usize> {
    let target = normalize_section(section);
    lines.iter().enumerate().find_map(|(idx, line)| {
        let rest = line.strip_prefix("## ")?;
        (normalize_section(rest.trim()) == target).then_some(idx)
    })
}

/// 校验单个候选的结构合法性（规则层）。返回 Ok(文件内容) 或 拒绝原因。
fn validate_candidate(hub: &Path, candidate: &KnowledgeCandidate) -> Result<String, String> {
    if candidate.content.trim().is_empty() {
        return Err("内容为空".to_string());
    }
    if candidate.evidence.trim().is_empty() {
        return Err("缺少依据（evidence）".to_string());
    }
    if candidate.confidence != "confirmed" {
        return Err(format!(
            "置信度为 {}，仅 confirmed 可自动回写",
            candidate.confidence
        ));
    }
    if !module_is_safe(&candidate.module) {
        return Err(format!("模块名不合法：{}", candidate.module));
    }
    if candidate.section.trim().is_empty() {
        return Err("section 为空".to_string());
    }
    let doc = module_doc_path(hub, &candidate.module);
    if !doc.is_file() {
        return Err(format!(
            "模块卡片不存在：his-knowledge-graph/data/modules/{}.md",
            candidate.module
        ));
    }
    let content = std::fs::read_to_string(&doc).map_err(|e| format!("读取模块卡片失败: {e}"))?;
    let lines: Vec<&str> = content.lines().collect();
    if find_section_heading(&lines, &candidate.section).is_none() {
        return Err(format!("模块卡片中找不到 section：{}", candidate.section));
    }
    // 规则层兜底去重：内容已逐字存在时直接拒绝（语义去重交给 Agent 层）。
    if content.contains(candidate.content.trim()) {
        return Err("内容已存在于模块卡片（重复沉淀）".to_string());
    }
    Ok(content)
}

/// Agent 质量门的单项判定。
#[derive(Deserialize, Clone, Debug)]
struct GateVerdict {
    index: usize,
    passed: bool,
    #[serde(default)]
    reason: String,
}

/// 从 headless 输出中解析 <GATE> JSON 数组；缺失时返回 None（调用方按全不过处理）。
fn parse_gate_verdicts(stdout: &str) -> Option<Vec<GateVerdict>> {
    const OPEN: &str = "<GATE>";
    const CLOSE: &str = "</GATE>";
    let close_pos = stdout.rfind(CLOSE)?;
    let prefix = &stdout[..close_pos];
    let open_pos = prefix.rfind(OPEN)?;
    let inner = &prefix[open_pos + OPEN.len()..];
    let trimmed = inner.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// 构造质量门提示词：候选数组 + 技能路径 + 输出格式。
fn build_gate_prompt(hub: &str, indices: &[usize], all: &[KnowledgeCandidate]) -> String {
    let payload: Vec<serde_json::Value> = indices
        .iter()
        .map(|&i| {
            let c = &all[i];
            serde_json::json!({
                "index": i,
                "module": c.module,
                "section": c.section,
                "content": c.content,
                "evidence": c.evidence,
                "confidence": c.confidence,
                "suggestedTitle": c.suggested_title,
            })
        })
        .collect();
    format!(
        r#"你是知识质量门。请先读取并严格遵循技能：`{hub}/knowledge-quality-gate/SKILL.md`。
当前工作目录是技能库根目录：{hub}

待校验候选（index 为原始序号，务必原样带回）：
{payload}

请对照 `his-knowledge-graph/data/modules/<module>.md` 的现有内容逐条校验，只输出：
<GATE>
[{{"index":0,"passed":true,"reason":"ok"}}]
</GATE>
标签外不要输出任何内容。passed=false 时 reason 必须给出具体依据（重复 / 冲突 / 依据不足等）。"#,
        hub = hub,
        payload = serde_json::to_string_pretty(&payload).unwrap_or_default(),
    )
}

/// 在 section 末尾追加一条结构化知识块（只增不改），返回新文件内容。
fn append_entry(content: &str, section: &str, candidate: &KnowledgeCandidate) -> String {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    if !content.ends_with('\n') {
        lines.push(String::new());
    }
    let borrowed: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let heading = find_section_heading(&borrowed, section).expect("validated section heading");
    // section 结束位置：下一个 `## ` 标题；没有则文件末尾。
    let end = borrowed[heading + 1..]
        .iter()
        .position(|l| l.starts_with("## "))
        .map(|offset| heading + 1 + offset)
        .unwrap_or(lines.len());
    let mut block: Vec<String> = Vec::new();
    if end == 0 || !lines[end - 1].trim().is_empty() {
        block.push(String::new());
    }
    block.push(format!("- {date} · 已确认 · {}", candidate.content.trim()));
    block.push(format!("  - 依据：{}", candidate.evidence.trim()));
    if end < lines.len() && lines[end].starts_with("## ") {
        block.push(String::new());
    }
    lines.splice(end..end, block);
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// 知识沉淀自动回写：规则校验 → Agent 质量门 → 写模块卡片 → git 提交推送。
/// 返回逐条结果；任何一条未通过都不会写库，由前端保留议题走人工审核。
#[tauri::command]
pub async fn knowledge_auto_writeback(
    suggestions: Vec<KnowledgeCandidate>,
    agent: String,
) -> Result<KnowledgeWritebackResult, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {agent}"));
    }
    if suggestions.is_empty() {
        return Err("知识候选为空".to_string());
    }
    let hub_str = crate::skills::configured_hub_path()
        .ok_or_else(|| "技能库未配置，无法自动回写知识库".to_string())?;
    let hub = PathBuf::from(&hub_str);
    if !hub.join("his-knowledge-graph").is_dir() {
        return Err("技能库中未找到 his-knowledge-graph，无法自动回写".to_string());
    }

    // 1) 规则层：逐条结构校验，不通过直接出局（不进 Agent）。
    let mut items: Vec<KnowledgeWritebackItem> = Vec::new();
    let mut rule_passed: Vec<usize> = Vec::new();
    for (index, candidate) in suggestions.iter().enumerate() {
        let item = match validate_candidate(&hub, candidate) {
            Ok(_) => {
                rule_passed.push(index);
                KnowledgeWritebackItem {
                    index,
                    module: candidate.module.clone(),
                    section: candidate.section.clone(),
                    passed: true,
                    written: false,
                    reason: String::new(),
                }
            }
            Err(reason) => KnowledgeWritebackItem {
                index,
                module: candidate.module.clone(),
                section: candidate.section.clone(),
                passed: false,
                written: false,
                reason,
            },
        };
        items.push(item);
    }

    // 2) Agent 层：一次 headless 批量语义质检。
    if !rule_passed.is_empty() {
        let prompt = build_gate_prompt(&hub_str, &rule_passed, &suggestions);
        let output = crate::agent_assist::run_headless_agent_with_timeout(
            &agent,
            &hub_str,
            &prompt,
            QUALITY_GATE_TIMEOUT,
            true,
            None,
        )
        .await?;
        if !output.status.success() {
            return Err(format!(
                "质量门执行失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let verdicts = parse_gate_verdicts(&stdout).ok_or_else(|| {
            "质量门未返回 <GATE> 结果，按全部未通过处理（议题保留人工审核）".to_string()
        })?;
        let judged: Vec<usize> = verdicts.iter().map(|v| v.index).collect();
        for verdict in verdicts {
            if let Some(item) = items.iter_mut().find(|i| i.index == verdict.index) {
                item.passed = verdict.passed;
                if !verdict.passed {
                    item.reason = if verdict.reason.is_empty() {
                        "质量门未通过".to_string()
                    } else {
                        verdict.reason
                    };
                }
            }
        }
        // 质量门漏判的条目一律按未通过处理，绝不让「漏回」变成放行。
        for item in items.iter_mut() {
            if rule_passed.contains(&item.index) && !judged.contains(&item.index) {
                item.passed = false;
                item.reason = "质量门未返回该条判定，按未通过处理".to_string();
            }
        }
    }

    // 3) 写入通过的条目（同模块多次写入按顺序累积）。
    let mut changed_docs: Vec<PathBuf> = Vec::new();
    for (index, candidate) in suggestions.iter().enumerate() {
        let passed = items
            .iter()
            .find(|i| i.index == index)
            .map(|i| i.passed)
            .unwrap_or(false);
        if !passed {
            continue;
        }
        let doc = module_doc_path(&hub, &candidate.module);
        let current = std::fs::read_to_string(&doc)
            .map_err(|e| format!("写入前读取 {} 失败: {e}", candidate.module))?;
        let next = append_entry(&current, &candidate.section, candidate);
        std::fs::write(&doc, next).map_err(|e| format!("写入 {} 失败: {e}", candidate.module))?;
        if !changed_docs.contains(&doc) {
            changed_docs.push(doc);
        }
        if let Some(item) = items.iter_mut().find(|i| i.index == index) {
            item.written = true;
            item.reason = "已自动写入模块卡片".to_string();
        }
    }

    // 4) git 提交推送（有写入才提交）。
    let written_count = items.iter().filter(|i| i.written).count();
    let mut commit: Option<String> = None;
    if written_count > 0 {
        let mut add_args: Vec<String> = vec!["add".into(), "--".into()];
        for doc in &changed_docs {
            let rel = doc
                .strip_prefix(&hub)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            add_args.push(rel);
        }
        let add = crate::git::run_git_with_timeout(
            hub_str.clone(),
            add_args,
            std::time::Duration::from_secs(30),
        )
        .await?;
        if !add.status.success() {
            return Err(format!(
                "git add 失败: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            ));
        }
        let message = format!("docs(knowledge): auto sediment {written_count} entries via Nezha");
        let commit_out = crate::git::run_git_with_timeout(
            hub_str.clone(),
            vec!["commit".into(), "-m".into(), message.clone()],
            std::time::Duration::from_secs(30),
        )
        .await?;
        if !commit_out.status.success() {
            return Err(format!(
                "git commit 失败: {}",
                String::from_utf8_lossy(&commit_out.stderr).trim()
            ));
        }
        let push = crate::git::run_git_with_timeout(
            hub_str.clone(),
            vec!["push".into()],
            std::time::Duration::from_secs(120),
        )
        .await?;
        if !push.status.success() {
            return Err(format!(
                "已提交但推送失败: {}（本地提交已保留，可手动 push 后关闭议题）",
                String::from_utf8_lossy(&push.stderr).trim()
            ));
        }
        commit = Some(message);
    }

    let all_passed = items.iter().all(|i| i.passed);
    Ok(KnowledgeWritebackResult {
        items,
        all_passed,
        written_count,
        commit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_section_aliases() {
        assert_eq!(
            normalize_section("关键实体 / 数据表"),
            normalize_section("关键实体与数据表")
        );
        assert_eq!(
            normalize_section(" 业务规则 / 已知坑 "),
            normalize_section("业务规则与已知坑")
        );
    }

    #[test]
    fn rejects_unsafe_module_names() {
        assert!(module_is_safe("Hsp.BaseData.Cache"));
        assert!(!module_is_safe("../etc/passwd"));
        assert!(!module_is_safe("a/b"));
        assert!(!module_is_safe(""));
    }

    fn sample_doc() -> String {
        "# Hsp.BaseData.Cache（缓存）\n\n## 职责\n\n缓存。\n\n## 业务规则 / 已知坑\n\n（待补充）\n\n## 验证记录\n\n（待补充）\n".to_string()
    }

    #[test]
    fn appends_entry_into_matching_section() {
        let candidate = KnowledgeCandidate {
            module: "Hsp.BaseData.Cache".into(),
            section: "业务规则与已知坑".into(),
            content: "缓存键必须带租户前缀".into(),
            evidence: "Hsp.BaseData.Cache.Bll/CacheService.cs:42".into(),
            confidence: "confirmed".into(),
            suggested_title: String::new(),
        };
        let next = append_entry(&sample_doc(), &candidate.section, &candidate);
        let in_section = next
            .split("## 业务规则 / 已知坑")
            .nth(1)
            .and_then(|rest| rest.split("## 验证记录").next())
            .unwrap_or_default();
        assert!(in_section.contains("缓存键必须带租户前缀"));
        assert!(in_section.contains("依据：Hsp.BaseData.Cache.Bll/CacheService.cs:42"));
        // 只增不改：原有内容仍在。
        assert!(next.contains("（待补充）"));
    }

    #[test]
    fn parses_gate_verdict_block() {
        let stdout = "前言\n<GATE>[{\"index\":0,\"passed\":true,\"reason\":\"ok\"},{\"index\":1,\"passed\":false,\"reason\":\"与现状冲突\"}]</GATE>\n后记";
        let verdicts = parse_gate_verdicts(stdout).expect("parses");
        assert_eq!(verdicts.len(), 2);
        assert!(verdicts[0].passed);
        assert_eq!(verdicts[1].reason, "与现状冲突");
    }
}
