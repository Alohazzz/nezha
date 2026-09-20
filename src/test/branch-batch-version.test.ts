import { describe, expect, it } from "vitest";
import { normalizeVersionSegment } from "../components/branch-batch/CreateBranchBatchDialog";

describe("normalizeVersionSegment", () => {
  it("strips the trailing .0 that Yunxiao version names carry", () => {
    expect(normalizeVersionSegment("v2.20260901.0")).toBe("v2.20260901");
    expect(normalizeVersionSegment("v2.20260501.0")).toBe("v2.20260501");
  });

  it("keeps a real sub-version segment (only drops .0, not .NN)", () => {
    expect(normalizeVersionSegment("v2.20260501.44")).toBe("v2.20260501.44");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeVersionSegment("  v2.20260901.0  ")).toBe("v2.20260901");
  });
});
