import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 强制 CodeMirror 系列在测试图中单实例：vitest 全量并发下这些包
    // 偶发被解析出双实例副本，vue parser 的 parseMixed 跨实例失配会
    // 静默退化为裸 html 行为（file-viewer-language 间歇失败的根因）。
    dedupe: [
      "@codemirror/state",
      "@codemirror/language",
      "@codemirror/view",
      "@codemirror/lang-html",
      "@codemirror/lang-javascript",
      "@codemirror/lang-vue",
      "@lezer/common",
      "@lezer/lr",
      "@lezer/highlight",
    ],
  },
  test: {
    // jsdom 模拟浏览器环境，支持 DOM API 和 localStorage
    environment: "jsdom",
    // 重组件测试（YunxiaoView 整树渲染等）在 16 线程全量并发下单用例
    // 正常耗时可达 ~3s，默认 5000ms 在机器负载波动下偶发翻线（yunxiao-*
    // 随机超时的根因），放宽到 20s 只兜底慢场景，不影响失败判定。
    testTimeout: 20_000,
    // 全局注入 expect、describe、it 等，无需每个文件手动 import
    globals: true,
    // 在每个测试文件运行前执行的 setup（引入 @testing-library/jest-dom 扩展）
    setupFiles: ["./src/test/setup.ts"],
    // 排除智能体会话在 .agents/ 下留下的临时文件（如 codex 源码副本中的
    // jest 测试），它们不是项目测试，且引用项目未安装的依赖
    exclude: ["**/node_modules/**", "**/.agents/**"],
    // 覆盖率报告
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/vite-env.d.ts", "src/styles.ts"],
    },
  },
});
