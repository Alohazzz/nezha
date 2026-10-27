import { describe, expect, it } from "vitest";
import { deriveTaskNameFromPrompt } from "../hooks/useCodexAutoName";

describe("deriveTaskNameFromPrompt", () => {
  it("取首行非空文本并保留原文", () => {
    expect(deriveTaskNameFromPrompt("修复登录页 token 过期\n第二行")).toBe(
      "修复登录页 token 过期",
    );
  });

  it("跳过 Markdown 标题行与 HTML 片段行", () => {
    expect(deriveTaskNameFromPrompt("# 标题\n修复登录页")).toBe("修复登录页");
    expect(deriveTaskNameFromPrompt("<context>wrap</context>\n修复登录页")).toBe(
      "修复登录页",
    );
  });

  it("剥掉斜杠命令前缀（/model 这类命令不是任务主题）", () => {
    expect(deriveTaskNameFromPrompt("/model 解释一下这个命令")).toBe(
      "解释一下这个命令",
    );
  });

  it("清洗 Markdown 装饰符号并压缩空白", () => {
    expect(deriveTaskNameFromPrompt("- **重构**   PTY 读取缓冲")).toBe(
      "重构 PTY 读取缓冲",
    );
    expect(deriveTaskNameFromPrompt("`fix` _login_ bug")).toBe("fix login bug");
  });

  it("超长 prompt 截断并追加省略号", () => {
    const long = "查".repeat(80);
    const name = deriveTaskNameFromPrompt(long);
    expect(name).toBe("查".repeat(60) + "…");
  });

  it("全标题行 / 空 prompt 返回 null（保持 task-<id> 兜底名）", () => {
    expect(deriveTaskNameFromPrompt("# 只有一个标题")).toBeNull();
    expect(deriveTaskNameFromPrompt("")).toBeNull();
    expect(deriveTaskNameFromPrompt(undefined)).toBeNull();
  });
});
