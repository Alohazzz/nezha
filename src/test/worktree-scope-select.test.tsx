import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorktreeScopeSelect } from "../components/branch-batch/WorktreeScopeSelect";

describe("WorktreeScopeSelect", () => {
  it("truncates a long worktree label instead of overflowing the trigger", () => {
    const longBranch = "feature/v2.20260501/master/补丁议题修改";
    render(
      <WorktreeScopeSelect
        options={[{ key: "/wt", label: `WorkTree · ${longBranch}` }]}
        value="/wt"
        onChange={() => undefined}
      />,
    );

    // The trigger's value text must carry the truncation class (flex:1 + ellipsis),
    // mirroring BranchBar / FontSelector. Without it, a long branch name pushes
    // the chevron out of the .radix-select-trigger box.
    const value = screen.getByRole("button").querySelector(".radix-select-trigger-value");
    expect(value).not.toBeNull();
    expect(value).toHaveTextContent(`WorkTree · ${longBranch}`);
    expect(value).toHaveClass("radix-select-trigger-value");
  });
});
