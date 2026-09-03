import { describe, expect, test } from "vitest";
import { build } from "../styles/build";

// Mirrors the `:root` block in styles/themes.css for the tokens BuildPanel relies
// on. Keeping the values here (rather than reading the css file) avoids Node
// imports in the frontend test setup.
const lightTokens = new Map<string, string>([
  ["--bg-panel", "#ffffff"],
  ["--bg-card", "#ffffff"],
  ["--text-primary", "#171b24"],
  ["--text-muted", "#69758a"],
]);

function resolveVar(value: string, tokens: Map<string, string>, depth = 0): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^var\((--[\w-]+)(?:,\s*(.*))?\)$/);
  if (!match || depth > 8) return trimmed;
  const [, name, fallback] = match;
  if (tokens.has(name)) return resolveVar(tokens.get(name)!, tokens, depth + 1);
  return fallback ? resolveVar(fallback, tokens, depth + 1) : trimmed;
}

function hexLuminance(hex: string): number {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`expected hex color, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [hexLuminance(a), hexLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("Build panel light-theme styling", () => {
  const cardBg = resolveVar(build.card.background!, lightTokens);
  const pairs: [string, string][] = [
    ["card title", resolveVar(build.cardTitle.color!, lightTokens)],
    ["repo name", resolveVar(build.repoName.color!, lightTokens)],
    ["status line", resolveVar(build.statusLine.color!, lightTokens)],
    ["meta text", resolveVar(build.meta.color!, lightTokens)],
    ["log text", resolveVar(build.logScroll.color!, lightTokens)],
  ];

  test("cards use a light surface in the light theme", () => {
    expect(cardBg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hexLuminance(cardBg)).toBeGreaterThan(0.7);
  });

  test.each(pairs)("%s stays readable on the card background", (_label, color) => {
    expect(contrast(color, cardBg)).toBeGreaterThanOrEqual(4.5);
  });
});
