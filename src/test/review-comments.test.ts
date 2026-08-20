import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import {
  buildBatchMessage,
  buildCommentMessage,
  isSendableStatus,
  resolveTargetTask,
  toRelativeProjectPath,
  truncateSnippet,
  type ReviewComment,
} from "../components/file-viewer/reviewComments";

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    path: "src/foo.ts",
    startLine: 12,
    endLine: 15,
    snippet: "const a = 1;\nconst b = 2;",
    text: "这段逻辑建议抽成函数",
    status: "open",
    createdAt: 1,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    prompt: "do something",
    agent: "claude",
    permissionMode: "ask",
    status: "done",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("review comments — 消息组装", () => {
  it("单行评论用 :line，多行用 :start-end", () => {
    expect(buildCommentMessage(comment({ startLine: 12, endLine: 12 }))).toContain("@src/foo.ts:12");
    expect(buildCommentMessage(comment())).toContain("@src/foo.ts:12-15");
  });

  it("正文按行转成 > 引用块", () => {
    const msg = buildCommentMessage(comment({ text: "第一行\n第二行" }));
    expect(msg).toContain("> 第一行\n> 第二行");
  });

  it("批量合并：多条评论以空行分隔", () => {
    const batch = buildBatchMessage([
      comment({ id: "a", path: "a.ts", startLine: 1, endLine: 1 }),
      comment({ id: "b", path: "b.ts", startLine: 2, endLine: 2 }),
    ]);
    expect(batch).toContain("@a.ts:1");
    expect(batch).toContain("@b.ts:2");
    expect(batch.split("\n\n").length).toBe(2);
  });

  it("anchorable=false 时不带 @ 前缀（纯文本锚）", () => {
    const msg = buildCommentMessage(comment({ anchorable: false }));
    expect(msg).not.toContain("@src/foo.ts");
    expect(msg).toContain("src/foo.ts:12-15");
  });
});

describe("review comments — 路径与截断", () => {
  it("绝对路径转相对项目根路径（统一 / 分隔）", () => {
    expect(toRelativeProjectPath("C:/proj", "C:/proj/src/a.ts")).toBe("src/a.ts");
    expect(toRelativeProjectPath("C:/proj/", "C:/proj/\\src\\a.ts")).toBe("src/a.ts");
  });

  it("snippet 超行数/超字符数截断并附省略标记", () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    expect(truncateSnippet(long)).toMatch(/…$/);
    const wide = "x".repeat(3000);
    expect(truncateSnippet(wide)).toHaveLength(2002);
  });
});

describe("review comments — 目标任务判定", () => {
  it("按 awaiting_review → input_required → running → 最近活跃 优先级", () => {
    const running = task({ id: "r", status: "running", updatedAt: 100 });
    const awaiting = task({ id: "a", status: "awaiting_review", updatedAt: 200 });
    const input = task({ id: "i", status: "input_required", updatedAt: 150 });
    const done = task({ id: "d", status: "done", updatedAt: 300 });
    expect(resolveTargetTask([running, done, input, awaiting])?.id).toBe("a");
    expect(resolveTargetTask([done, input, running])?.id).toBe("i");
    expect(resolveTargetTask([done, running])?.id).toBe("r");
    expect(resolveTargetTask([done, done])).toBeNull();
  });

  it("没有存活任务时返回 null（全死回退由 ProjectPage 兜底）", () => {
    const recent = task({ id: "r", status: "done", updatedAt: 50 });
    const older = task({ id: "o", status: "done", updatedAt: 10 });
    expect(resolveTargetTask([older, recent])).toBeNull();
  });

  it("isSendableStatus 只认存活状态", () => {
    expect(isSendableStatus("awaiting_review")).toBe(true);
    expect(isSendableStatus("input_required")).toBe(true);
    expect(isSendableStatus("running")).toBe(true);
    expect(isSendableStatus("pending")).toBe(true);
    expect(isSendableStatus("done")).toBe(false);
    expect(isSendableStatus("failed")).toBe(false);
  });
});
