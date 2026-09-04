import { describe, expect, it } from "vitest";
import {
  buildKnowledgeBatchMessage,
  buildKnowledgeCommentMessage,
  cardAbsPath,
  newKnowledgeCommentId,
  type KnowledgeComment,
} from "../components/knowledge/knowledgeComments";

function sampleComment(): KnowledgeComment {
  return {
    id: "c1",
    module: "Hsp.BaseData",
    absPath: "C:/skills/knowledge-graphs/HIS/data/modules/Hsp.BaseData.md",
    text: "缓存键必须带租户前缀",
    status: "open",
    createdAt: 1,
  };
}

describe("knowledge comments", () => {
  it("builds a card-absolute-path anchor and blockquotes the instruction", () => {
    const message = buildKnowledgeCommentMessage(sampleComment());
    expect(message).toContain("@C:/skills/knowledge-graphs/HIS/data/modules/Hsp.BaseData.md");
    expect(message).toContain("> 缓存键必须带租户前缀");
    expect(message).toContain("只修改上面 @ 指向的这一张知识库卡片");
  });

  it("blockquotes multi-line instructions", () => {
    const comment = { ...sampleComment(), text: "第一行\n第二行" };
    const message = buildKnowledgeCommentMessage(comment);
    expect(message).toContain("> 第一行\n> 第二行");
  });

  it("joins multiple comments with a blank line", () => {
    const message = buildKnowledgeBatchMessage([sampleComment(), sampleComment()]);
    expect(message.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  it("joins data dir and module with forward slashes", () => {
    expect(cardAbsPath("C:\\skills\\knowledge-graphs\\HIS\\data", "io")).toBe(
      "C:/skills/knowledge-graphs/HIS/data/modules/io.md",
    );
  });

  it("generates unique ids", () => {
    expect(newKnowledgeCommentId()).not.toBe(newKnowledgeCommentId());
  });
});
