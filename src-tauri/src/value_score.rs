//! 「价值评分」小节（issue-value-scoring 技能写入 discussion.md）的提取 / 解析 / 剥离 / 拼回。
//! 回写云效时：评分进议题字段、不进评论；「重新生成」时把评分小节原样拼回，避免丢失。

/// 评分小节标题前缀（技能输出格式固定，见 issue-value-scoring/SKILL.md）。
pub const SCORE_SECTION_HEADER: &str = "## 价值评分";

/// 提取评分小节：从 `## 价值评分` 标题行开始，到下一个 `## ` 标题或文本末尾。
/// 返回的是 `text` 的子切片（已 trim），找不到时返回 None。
pub fn extract_value_score_section(text: &str) -> Option<&str> {
    let mut line_start = 0usize;
    let mut start_byte = None;
    for line in text.lines() {
        if line.starts_with(SCORE_SECTION_HEADER) {
            start_byte = Some(line_start);
            break;
        }
        line_start += line.len() + 1;
    }
    let start = start_byte?;
    let rest = &text[start..];
    let section = match rest.find("\n## ") {
        Some(next) => &rest[..next],
        None => rest,
    };
    let trimmed = section.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 从评分小节中解析核心指数（Req）或优先指数（Bug），取标签后的第一个数字。
pub fn parse_value_score_index(section: &str) -> Option<f64> {
    for line in section.lines() {
        let trimmed = line.trim();
        let rest = ["- 核心指数：", "- 优先指数：", "- 核心指数:", "- 优先指数:"]
            .iter()
            .find_map(|prefix| trimmed.strip_prefix(prefix))
            .map(str::trim);
        if let Some(rest) = rest {
            if let Some(value) = first_number(rest) {
                return Some(value);
            }
        }
    }
    None
}

fn first_number(s: &str) -> Option<f64> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let starts_number = b.is_ascii_digit()
            || (b == b'-' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit());
        if starts_number {
            let start = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            if let Ok(value) = s[start..i].parse::<f64>() {
                return Some(value);
            }
            continue;
        }
        i += 1;
    }
    None
}

/// 从完整回写内容中剥离评分小节：返回（评论正文，评分小节）。
/// 小节不存在时返回（原文 trim，None）。
pub fn strip_value_score_section(text: &str) -> (String, Option<String>) {
    let Some(section) = extract_value_score_section(text) else {
        return (text.trim().to_string(), None);
    };
    let start = section.as_ptr() as usize - text.as_ptr() as usize;
    let end = start + section.len();
    let before = text[..start].trim_end();
    let after = text[end..].trim_start();
    let comment = match (before.is_empty(), after.is_empty()) {
        (true, true) => String::new(),
        (true, false) => after.to_string(),
        (false, true) => before.to_string(),
        (false, false) => format!("{before}\n\n{after}"),
    };
    (comment, Some(section.to_string()))
}

/// 把保留的评分小节拼回重新生成的汇总末尾（幂等：汇总已含小节或没有保留值时原样返回）。
pub fn reappend_value_score_section(summary: &str, preserved: Option<&str>) -> String {
    let summary = summary.trim_end();
    let Some(preserved) = preserved.map(str::trim).filter(|s| !s.is_empty()) else {
        return summary.to_string();
    };
    if summary.contains(SCORE_SECTION_HEADER) {
        return summary.to_string();
    }
    format!("{summary}\n\n{preserved}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_section_stopping_at_next_heading() {
        let text = r#"# 方案讨论

一些讨论内容。

## 价值评分（issue-value-scoring · 2026-08-24）

- 议题类别：Req
- 核心指数：**50.0** = (4 × 5 × 5) ÷ 工作量等级 2
- 一句话结论：高价值低成本，值得立即做。

## 后续步骤

继续跟进。"#;
        let section = extract_value_score_section(text).expect("应找到评分小节");
        assert!(section.starts_with("## 价值评分"));
        assert!(section.contains("核心指数"));
        assert!(section.ends_with("一句话结论：高价值低成本，值得立即做。"));
        assert!(!section.contains("后续步骤"));
    }

    #[test]
    fn extracts_section_running_to_eof() {
        let text = "正文\n\n## 价值评分（issue-value-scoring · 2026-08-24）\n\n- 优先指数：**54.0** = 严重 3 × 频率 3 × 范围 3";
        let section = extract_value_score_section(text).expect("应找到评分小节");
        assert!(section.contains("优先指数"));
        assert!(section.ends_with("严重 3 × 频率 3 × 范围 3"));
    }

    #[test]
    fn returns_none_when_section_missing() {
        assert_eq!(extract_value_score_section("普通评论内容"), None);
        assert_eq!(
            extract_value_score_section("## 价值评估\n\n不是评分小节"),
            None
        );
    }

    #[test]
    fn parses_req_core_index() {
        let section = "## 价值评分（issue-value-scoring · 2026-08-24）\n\n- 核心指数：**50.0** = (4 × 5 × 5) ÷ 工作量等级 2";
        assert_eq!(parse_value_score_index(section), Some(50.0));
    }

    #[test]
    fn parses_bug_priority_index() {
        let section = "- 优先指数：**54.0** = 严重 3 × 频率 3 × 范围 3 × 折减 1.0（无绕行）";
        assert_eq!(parse_value_score_index(section), Some(54.0));
    }

    #[test]
    fn parses_plain_number_without_bold() {
        let section = "- 核心指数：12 = (2 × 3 × 4) ÷ 2";
        assert_eq!(parse_value_score_index(section), Some(12.0));
    }

    #[test]
    fn parse_returns_none_without_index_line() {
        assert_eq!(
            parse_value_score_index("## 价值评分\n\n- 议题类别：Req"),
            None
        );
        assert_eq!(parse_value_score_index(""), None);
    }

    #[test]
    fn strips_section_from_middle_keeping_rest() {
        let text = "开头总结\n\n## 价值评分（issue-value-scoring · 2026-08-24）\n\n- 核心指数：**12.0**\n\n## 结尾备注\n\n补充说明";
        let (comment, section) = strip_value_score_section(text);
        assert_eq!(comment, "开头总结\n\n## 结尾备注\n\n补充说明");
        let section = section.expect("应剥离出评分小节");
        assert!(section.starts_with("## 价值评分"));
        assert!(section.contains("12.0"));
    }

    #[test]
    fn strip_returns_original_when_no_section() {
        let text = "只有评论内容";
        let (comment, section) = strip_value_score_section(text);
        assert_eq!(comment, "只有评论内容");
        assert_eq!(section, None);
    }

    #[test]
    fn reappend_appends_section_when_missing() {
        let summary = "重新生成的总结正文";
        let preserved = "## 价值评分（issue-value-scoring · 2026-08-24）\n\n- 核心指数：**50.0**";
        let result = reappend_value_score_section(summary, Some(preserved));
        assert!(result.starts_with("重新生成的总结正文"));
        assert!(result.contains("## 价值评分"));
        assert!(result.ends_with("核心指数：**50.0**"));
    }

    #[test]
    fn reappend_skips_when_summary_already_has_section() {
        let summary =
            "正文\n\n## 价值评分（issue-value-scoring · 2026-08-24）\n\n- 核心指数：**9.0**";
        let result = reappend_value_score_section(
            summary,
            Some("## 价值评分（issue-value-scoring · 2026-08-24）\n\n- 核心指数：**50.0**"),
        );
        assert_eq!(result, summary);
    }

    #[test]
    fn reappend_returns_summary_unchanged_without_preserved() {
        let summary = "正文";
        assert_eq!(reappend_value_score_section(summary, None), summary);
    }
}
