import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom 模拟浏览器环境，支持 DOM API 和 localStorage
    environment: "jsdom",
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
