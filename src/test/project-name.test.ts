import { describe, expect, it } from "vitest";
import {
  findProjectByName,
  normalizeProjectNameInput,
  projectNameKey,
  validateProjectName,
} from "../projectName";

const projects = [
  { id: "client", name: "Client App" },
  { id: "api", name: "API" },
];

describe("project name rules", () => {
  it("trims outer whitespace while preserving the display name", () => {
    expect(normalizeProjectNameInput("  Client   App  ")).toBe("Client   App");
  });

  it("rejects blank names and the cross-project mention separator", () => {
    expect(validateProjectName("   ", projects, "client")).toEqual({
      ok: false,
      error: "required",
    });
    expect(validateProjectName("client/api", projects, "client")).toEqual({
      ok: false,
      error: "reserved_separator",
    });
  });

  it("rejects names that collide after stable case and width normalization", () => {
    expect(projectNameKey("ＡＰＩ")).toBe("api");
    expect(validateProjectName("ＡＰＩ", projects, "client")).toEqual({
      ok: false,
      error: "duplicate",
    });
  });

  it("allows a unique name and returns the trimmed value", () => {
    expect(validateProjectName("  Client Web  ", projects, "client")).toEqual({
      ok: true,
      name: "Client Web",
    });
  });

  it("resolves mentions with the same canonical key used by validation", () => {
    expect(findProjectByName(projects, "ａｐｉ")).toEqual(projects[1]);
  });

  it("prefers a direct match when existing names share a canonical key", () => {
    const compatibleProjects = [
      { id: "ascii", name: "API" },
      { id: "fullwidth", name: "ＡＰＩ" },
    ];

    expect(findProjectByName(compatibleProjects, "api")).toEqual(compatibleProjects[0]);
    expect(findProjectByName(compatibleProjects, "ａｐｉ")).toEqual(compatibleProjects[1]);
  });
});
