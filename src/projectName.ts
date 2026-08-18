import type { Project } from "./types";

export type ProjectNameValidationError = "required" | "reserved_separator" | "duplicate";

export type ProjectRenameError = ProjectNameValidationError | "save_failed";

export type ProjectRenameResult =
  | { ok: true; name: string }
  | { ok: false; error: ProjectRenameError };

export function normalizeProjectNameInput(value: string): string {
  return value.trim();
}

export function projectNameKey(value: string): string {
  return normalizeProjectNameInput(value).normalize("NFKC").toLowerCase();
}

export function findProjectByName<T extends Pick<Project, "name">>(
  projects: readonly T[],
  name: string,
): T | undefined {
  // Preserve the old case-insensitive lookup before falling back to compatibility
  // normalization. This keeps canonically equivalent but visibly distinct existing
  // projects addressable (for example, "API" and "ＡＰＩ").
  const directKey = normalizeProjectNameInput(name).toLowerCase();
  const directMatch = projects.find(
    (project) => normalizeProjectNameInput(project.name).toLowerCase() === directKey,
  );
  if (directMatch) return directMatch;

  const key = projectNameKey(name);
  return projects.find((project) => projectNameKey(project.name) === key);
}

export function validateProjectName(
  input: string,
  projects: readonly Pick<Project, "id" | "name">[],
  projectId: string,
): ProjectRenameResult {
  const name = normalizeProjectNameInput(input);
  if (!name) return { ok: false, error: "required" };
  if (name.includes("/")) return { ok: false, error: "reserved_separator" };

  const key = projectNameKey(name);
  const duplicate = projects.some(
    (project) => project.id !== projectId && projectNameKey(project.name) === key,
  );
  if (duplicate) return { ok: false, error: "duplicate" };

  return { ok: true, name };
}
