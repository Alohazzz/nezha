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

/// 从评分小节中解析核心指数（Req）/ 绩效指数或优先指数（Bug），取标签后的第一个数字。
/// v2 评分（issue-value-scoring）Bug 用「绩效指数 = 优先指数 × 研发贡献系数」，
/// 绩效导向，优先于旧「优先指数」；Req 仍取「核心指数」。旧格式（2026-10 前回写的
/// 评论）继续兼容，回代历史议题不丢值。
/// 容错：模型偶尔把「指数」写成「指标」（如「核心指标：19.2」，QHDK 实例导致字段
/// 回写为空），两词等价接受；中文/英文冒号都认。
pub fn parse_value_score_index(section: &str) -> Option<f64> {
    // 行标签按优先级排列：绩效（v2 Bug）> 核心（Req）> 优先（旧 Bug）；
    // 「指数/指标」两变体 ×「：/:」两冒号由 expand_label 展开生成。
    for label in expand_label("- 绩效")
        .into_iter()
        .chain(expand_label("- 核心"))
        .chain(expand_label("- 优先"))
    {
        if let Some(value) = first_index_after(section, &label) {
            return Some(value);
        }
    }
    None
}

/// 生成一个标签前缀的全部变体：`指数`/`指标` × 中文冒号/英文冒号。
fn expand_label(prefix: &str) -> Vec<String> {
    let mut variants = Vec::with_capacity(4);
    for word in ["指数", "指标"] {
        for colon in ["：", ":"] {
            variants.push(format!("{prefix}{word}{colon}"));
        }
    }
    variants
}

fn first_index_after(section: &str, prefix: &str) -> Option<f64> {
    for line in section.lines() {
        if let Some(rest) = line.trim().strip_prefix(prefix).map(str::trim) {
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

/// 从文本中剥掉评分小节（含其标题行到下一个 `## ` 标题或文末），其余内容原样保留。
/// 用于评分小节被 agent 写进测试向半区时，避免它随测试向评论重复发布。
pub fn strip_value_score_section(text: &str) -> String {
    let mut line_start = 0usize;
    let mut start_byte = None;
    for line in text.lines() {
        if line.starts_with(SCORE_SECTION_HEADER) {
            start_byte = Some(line_start);
            break;
        }
        line_start += line.len() + 1;
    }
    let Some(start) = start_byte else {
        return text.to_string();
    };
    let rest = &text[start..];
    let end = match rest.find("\n## ") {
        // 下一个小节标题从 rest 内的 `\n` 之后开始，保留它（含前导空行规整交给 trim）。
        Some(next) => start + next + 1,
        None => text.len(),
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(text[..start].trim_end());
    let tail = text[end..].trim_start();
    if !out.is_empty() && !tail.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(tail);
    out
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
        let section = "- 优先指数：**54.0** = 严重 3 × 频率 3 × 范围 3 × 折减 1.0";
        assert_eq!(parse_value_score_index(section), Some(54.0));
    }

    #[test]
    fn prefers_performance_index_over_priority_index() {
        // v2 Bug 格式：绩效指数（进字段与月度汇总）优先于旧「优先指数」
        let section = "- 优先指数：**54.0** = 严重 3 × 频率 3 × 范围 3 × 折减 1.0\n- 绩效指数：**59.4** = 54.0 × 研发贡献系数 1.1";
        assert_eq!(parse_value_score_index(section), Some(59.4));
    }

    #[test]
    fn parses_performance_index_alone() {
        let section = "- 绩效指数：**59.4** = 54.0 × 研发贡献系数 1.1（诊断与验证难度 5）";
        assert_eq!(parse_value_score_index(section), Some(59.4));
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
    fn parses_index_label_typo_zhibiao() {
        // 实例：模型把「核心指数」写成「核心指标」，导致字段回写为空——必须兜底。
        let section = "- 核心指标：19.2 = (3 × 4 × 2) × 交付复杂度系数 0.8";
        assert_eq!(parse_value_score_index(section), Some(19.2));
        assert_eq!(
            parse_value_score_index("- 绩效指标：59.4 = 54.0 × 研发贡献系数 1.1"),
            Some(59.4)
        );
    }

    #[test]
    fn parses_half_width_colon_variants() {
        assert_eq!(parse_value_score_index("- 核心指数: 50"), Some(50.0));
        assert_eq!(parse_value_score_index("- 绩效指标: 59.4"), Some(59.4));
    }

    #[test]
    fn zhibiao_does_not_shadow_priority_order() {
        // 「指标」容错不得改变优先级：绩效行存在时核心行（无论指数/指标）不生效。
        let section = "- 核心指标：19.2\n- 绩效指数：59.4";
        assert_eq!(parse_value_score_index(section), Some(59.4));
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

    #[test]
    fn strips_section_running_to_eof() {
        let text = "## 影响范围与测试\n\n- 修改分支：fix/x\n\n## 价值评分\n\n- 优先指数：**31.5**";
        let out = strip_value_score_section(text);
        assert!(out.contains("影响范围与测试"));
        assert!(out.contains("修改分支"));
        assert!(!out.contains("价值评分"));
        assert!(!out.contains("31.5"));
    }

    #[test]
    fn strips_section_stopping_at_next_heading() {
        let text = "## 价值评分\n\n- 核心指数：**50**\n\n## 后续步骤\n\n继续。";
        let out = strip_value_score_section(text);
        assert!(!out.contains("价值评分"));
        assert!(!out.contains("核心指数"));
        assert!(out.contains("后续步骤"));
    }

    #[test]
    fn strip_returns_text_unchanged_without_section() {
        let text = "## 影响范围与测试\n\n- 测试步骤：1. …";
        assert_eq!(strip_value_score_section(text), text);
        assert_eq!(strip_value_score_section(""), "");
    }
}
