import { afterEach, describe, expect, it, vi } from "vitest";

// `$` 选择器数据源切换到 list_composer_skills 合并视图（SkillHub + 用户级/项目级
// agent 技能目录，后端已去重）。前端侧验证：缓存按 projectPath 分桶、失效后重拉、
// 后端报错按空列表兜底（不打扰输入体验）。invoke 走 mock，不碰 Tauri。

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { invalidateMentionCaches, loadSkills } from "../components/new-task/ComposerMention";
import type { Skill } from "../types";

function skill(name: string, source?: Skill["source"]): Skill {
  return { name, path: `C:\\skills\\${name}`, source };
}

afterEach(() => {
  invalidateMentionCaches();
  invokeMock.mockReset();
});

describe("loadSkills (composer merge view)", () => {
  it("passes projectPath through and caches per project", async () => {
    invokeMock.mockResolvedValueOnce([skill("alpha", "project")]);
    await expect(loadSkills("C:\\proj")).resolves.toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("list_composer_skills", {
      projectPath: "C:\\proj",
    });
    // 同 projectPath 命中缓存，不再 invoke
    await loadSkills("C:\\proj");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // 另一项目是独立缓存桶
    invokeMock.mockResolvedValueOnce([]);
    await loadSkills("C:\\other");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("invalidateMentionCaches forces a refetch", async () => {
    invokeMock.mockResolvedValueOnce([skill("a")]);
    await loadSkills(null);
    invalidateMentionCaches();
    invokeMock.mockResolvedValueOnce([skill("a"), skill("b", "codex")]);
    await expect(loadSkills(null)).resolves.toHaveLength(2);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to an empty list when the backend errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("command not found"));
    await expect(loadSkills(null)).resolves.toEqual([]);
    // 失败结果同样入缓存，避免每次按键都撞同一个错
    await expect(loadSkills(null)).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
