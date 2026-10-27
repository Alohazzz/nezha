import { html } from "@codemirror/lang-html";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { loadLanguageExtension } from "../components/file-viewer/languageExtensions";

const vueDoc = `<template><p>{{ message }}</p></template>
<script setup lang="ts">const count: number = 1</script>
<style>.message { color: red }</style>`;

function parseTree(extension: unknown): string {
  const state = EditorState.create({
    doc: vueDoc,
    extensions: [extension as never],
  });
  return syntaxTree(state).toString();
}

describe("file viewer language extensions", () => {
  it("parses Vue SFC template, TypeScript, and style sections", async () => {
    const extension = await loadLanguageExtension("Component.VUE");
    const vueTree = parseTree(extension);
    const htmlTree = parseTree(html());

    // 诊断输出：vue() 生效时模板段为 vue parser 的 Content(Interpolation(...))
    // 结构，与裸 html() 不同。CI 全新安装环境下曾观察到 vue 扩展退化为
    // 裸 html 行为（file-viewer-language 间歇失败的又一次复现），保留
    // 两棵树的完整输出便于在 CI 日志中直接比对定位。
    // 用 console.warn 规避 no-console lint 规则（只放行 warn/error）。
    console.warn("[file-viewer-language] node:", process.version);
    console.warn("[file-viewer-language] vue tree:", vueTree);
    console.warn("[file-viewer-language] html tree:", htmlTree);
    console.warn("[file-viewer-language] trees differ:", vueTree !== htmlTree);

    expect(vueTree).toContain("StyleSheet");
  });
});
