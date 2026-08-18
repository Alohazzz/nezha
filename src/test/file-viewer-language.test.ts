import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { loadLanguageExtension } from "../components/file-viewer/languageExtensions";

describe("file viewer language extensions", () => {
  it("parses Vue SFC template, TypeScript, and style sections", async () => {
    const extension = await loadLanguageExtension("Component.VUE");
    const state = EditorState.create({
      doc: `<template><p>{{ message }}</p></template>
<script setup lang="ts">const count: number = 1</script>
<style>.message { color: red }</style>`,
      extensions: [extension],
    });
    const tree = syntaxTree(state).toString();

    expect(tree).toContain("Interpolation");
    expect(tree).toContain("TypeAnnotation");
    expect(tree).toContain("StyleSheet");
  });
});
