import { describe, expect, it } from "vitest";
import {
  compactSkillMentions,
  expandSkillTokens,
  skillInstruction,
  splitSkillMentions,
} from "../skillMention";

// 技能提及的两种形态互转（对齐 ZCode canonical mention）：
// 输入框写紧凑 `$name`，提交时展开为带 SKILL.md 路径的指令，气泡/标题再折回短文本。
// 三个函数都是纯字符串处理，直测。

const SKILL = {
  name: "batch-grill-me",
  displayName: "Batch Grill Me",
  path: "C:\\Users\\SuYi\\.nezha\\skill_repos\\hub\\batch-grill-me",
};
const PATH_SKILL = { name: "local-skill", path: "/tmp/skills/local-skill" };

describe("skillInstruction", () => {
  it("keeps the historical prompt wording so the agent sees the same text", () => {
    expect(skillInstruction(SKILL)).toBe(
      `请读取并遵循 Batch Grill Me 技能：${SKILL.path}/SKILL.md`,
    );
    // 没有 displayName 时退回目录名
    expect(skillInstruction(PATH_SKILL)).toBe(
      `请读取并遵循 local-skill 技能：${PATH_SKILL.path}/SKILL.md`,
    );
  });
});

describe("expandSkillTokens", () => {
  it("replaces known $tokens with the canonical instruction", () => {
    expect(expandSkillTokens("用 $batch-grill-me 过一遍", [SKILL])).toBe(
      `用 ${skillInstruction(SKILL)} 过一遍`,
    );
  });

  it("expands every occurrence and matches case-insensitively by slug", () => {
    const once = skillInstruction(SKILL);
    expect(expandSkillTokens("$batch-grill-me 和 $BATCH-GRILL-ME", [SKILL])).toBe(`${once} 和 ${once}`);
  });

  it("leaves unknown tokens and non-token text untouched", () => {
    // 未知技能 / shell 变量 / 金额都不该被改写
    expect(expandSkillTokens("$unknown 与 $PATH 与 $ 与 $100", [SKILL])).toBe(
      "$unknown 与 $PATH 与 $ 与 $100",
    );
    expect(expandSkillTokens("没有触发符", [SKILL])).toBe("没有触发符");
  });

  it("stops at slug punctuation so trailing text survives", () => {
    expect(expandSkillTokens("$batch-grill-me。继续", [SKILL])).toBe(
      `${skillInstruction(SKILL)}。继续`,
    );
  });
});

describe("splitSkillMentions", () => {
  it("splits canonical instructions back into skill parts", () => {
    const text = `先 ${skillInstruction(SKILL)} 再过一遍`;
    expect(splitSkillMentions(text)).toEqual([
      { type: "text", text: "先 " },
      { type: "skill", label: "Batch Grill Me", path: `${SKILL.path}/SKILL.md` },
      { type: "text", text: " 再过一遍" },
    ]);
  });

  it("keeps plain text as a single part when nothing matches", () => {
    expect(splitSkillMentions("普通文本")).toEqual([{ type: "text", text: "普通文本" }]);
  });

  it("round-trips through expandSkillTokens", () => {
    // 展开 → 折叠 必须回到紧凑形态（气泡展示的正是折叠结果）
    const expanded = expandSkillTokens("$batch-grill-me 改一下", [SKILL]);
    expect(compactSkillMentions(expanded)).toBe("$Batch Grill Me 改一下");
  });
});

describe("compactSkillMentions", () => {
  it("collapses the long instruction into a short $label for titles", () => {
    expect(compactSkillMentions(`请 ${skillInstruction(PATH_SKILL)}`)).toBe("请 $local-skill");
  });
});
