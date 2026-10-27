import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  filterMentionItems,
  mergeBuiltinWithCommands,
} from "../components/new-task/ComposerMention";

// structured composer `/` 弹层的内置命令（/model /effort /compact /review /stop）
// 与自定义命令合并过滤。合并（mergeBuiltinWithCommands）与过滤
// （filterMentionItems）都是纯函数，直测。

function builtin(name: string): { kind: "builtin"; name: string; description: unknown } {
  const match = BUILTIN.find((cmd) => cmd.name === name);
  return { kind: "builtin", name, description: match?.description };
}

const BUILTIN = BUILTIN_COMMANDS.map(({ name, action }) => ({ name, description: `act:${action}` }));

describe("builtin slash commands", () => {
  it("merge puts builtin first and lets custom commands shadow same names", () => {
    const merged = mergeBuiltinWithCommands(BUILTIN, [
      { name: "zzz", description: "custom", scope: "global", path: "z.md" },
    ]);
    const labels = merged.map((item) =>
      item.kind === "builtin" ? `b:${item.name}` : item.kind === "command" ? `c:${item.command.name}` : item.kind,
    );
    expect(labels).toEqual(["b:model", "b:effort", "b:compact", "b:review", "b:stop", "c:zzz"]);

    // 同名时自定义命令优先：内置 model 被剔除
    const shadowed = mergeBuiltinWithCommands(BUILTIN, [
      { name: "model", description: "custom", scope: "project", path: "m.md" },
    ]);
    expect(shadowed.filter((item) => item.kind === "builtin").map((item) => item.name))
      .toEqual(["effort", "compact", "review", "stop"]);
  });

  it("builtin entries filter by exact / prefix / subsequence like commands", () => {
    const items = mergeBuiltinWithCommands(BUILTIN, []);
    // 空查询返回全部
    expect(filterMentionItems(items, "")).toHaveLength(BUILTIN.length);
    // 精确名
    expect(filterMentionItems(items, "model")).toEqual([builtin("model")]);
    expect(filterMentionItems(items, "compact")).toEqual([builtin("compact")]);
    // 前缀
    expect(filterMentionItems(items, "ef")).toEqual([builtin("effort")]);
    // 子序列（moel ⊂ model）
    expect(filterMentionItems(items, "moel")).toEqual([builtin("model")]);
    // 无匹配
    expect(filterMentionItems(items, "xyz")).toEqual([]);
  });

  it("builtin command set matches Codex CLI commands expressible over app-server", () => {
    expect(BUILTIN_COMMANDS.map((cmd) => cmd.name)).toEqual([
      "model",
      "effort",
      "compact",
      "review",
      "stop",
    ]);
  });
});
