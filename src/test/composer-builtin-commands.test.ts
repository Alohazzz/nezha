import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMAND_NAMES,
  filterMentionItems,
  mergeBuiltinWithCommands,
} from "../components/new-task/ComposerMention";

// structured composer `/` 弹层的内置命令（/model /effort）与自定义命令合并过滤。
// 合并（mergeBuiltinWithCommands）与过滤（filterMentionItems）都是纯函数，直测。

function builtin(name: string): { kind: "builtin"; name: string; description: string } {
  return { kind: "builtin", name, description: `desc-${name}` };
}

const BUILTIN = BUILTIN_COMMAND_NAMES.map((name) => ({ name, description: `desc-${name}` }));

describe("builtin slash commands", () => {
  it("merge puts builtin first and lets custom commands shadow same names", () => {
    const merged = mergeBuiltinWithCommands(BUILTIN, [
      { name: "zzz", description: "custom", scope: "global", path: "z.md" },
    ]);
    const labels = merged.map((item) =>
      item.kind === "builtin" ? `b:${item.name}` : item.kind === "command" ? `c:${item.command.name}` : item.kind,
    );
    expect(labels).toEqual(["b:model", "b:effort", "c:zzz"]);

    // 同名时自定义命令优先：内置 model 被剔除
    const shadowed = mergeBuiltinWithCommands(BUILTIN, [
      { name: "model", description: "custom", scope: "project", path: "m.md" },
    ]);
    expect(shadowed).toHaveLength(2);
    expect(shadowed.filter((item) => item.kind === "builtin")).toEqual([builtin("effort")]);
  });

  it("builtin entries filter by exact / prefix / subsequence like commands", () => {
    const items = mergeBuiltinWithCommands(BUILTIN, []);
    // 空查询返回全部
    expect(filterMentionItems(items, "")).toHaveLength(2);
    // 精确名
    expect(filterMentionItems(items, "model")).toEqual([builtin("model")]);
    // 前缀
    expect(filterMentionItems(items, "ef")).toEqual([builtin("effort")]);
    // 子序列（moel ⊂ model）
    expect(filterMentionItems(items, "moel")).toEqual([builtin("model")]);
    // 无匹配
    expect(filterMentionItems(items, "xyz")).toEqual([]);
  });
});
