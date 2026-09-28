import { describe, expect, it } from "vitest";
import { renderMarkdownWithToc } from "../utils/markdown";

/**
 * 知识库卡片预览的新增高亮：只有命中「未发布新增行」的列表项才带 kg-new-entry 类。
 * 这是第二阶段「预览态高亮新增条目」的核心行为，且必须不误伤普通列表项。
 */
describe("renderMarkdownWithToc highlightTexts", () => {
  const card = [
    "## 业务规则 / 已知坑",
    "",
    "- 退号时限与费用联动（来源：用户确认，2026-08-21）",
    "- 缓存键必须带租户前缀（来源：CacheService.cs，2026-09-28）",
    "",
  ].join("\n");

  it("未传 highlightTexts 时不产生任何高亮类", () => {
    const { html } = renderMarkdownWithToc(card);
    expect(html).not.toContain("kg-new-entry");
  });

  it("命中新增行的列表项被高亮，其余保持不变", () => {
    const { html } = renderMarkdownWithToc(card, {
      highlightTexts: ["缓存键必须带租户前缀（来源：CacheService.cs，2026-09-28）"],
    });
    const highlighted = html.match(/<li class="kg-new-entry">[\s\S]*?<\/li>/g) ?? [];
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toContain("缓存键必须带租户前缀");
    expect(highlighted[0]).not.toContain("退号时限");
    // 未命中的条目不应带类。
    const allLi = html.match(/<li[\s\S]*?<\/li>/g) ?? [];
    const plain = allLi.filter((li) => li.includes("退号时限"));
    expect(plain).toHaveLength(1);
    expect(plain[0]).not.toContain("kg-new-entry");
  });

  it("按纯文本包含匹配：条目含行内代码/加粗也能命中", () => {
    const formatted = "## 职责\n\n- `SchedulId` 为空则遍历排班（来源：X.cs）\n";
    const { html } = renderMarkdownWithToc(formatted, {
      highlightTexts: ["SchedulId 为空则遍历排班（来源：X.cs）"],
    });
    expect(html).toContain('class="kg-new-entry"');
  });

  it("待高亮文本为空数组时退化为默认渲染", () => {
    const { html } = renderMarkdownWithToc(card, { highlightTexts: [] });
    expect(html).not.toContain("kg-new-entry");
    expect(html).toContain("退号时限");
  });
});
