// 把 docs/ 下的帮助文档（HTML + 截图）同步到 public/help/。
//
// public/ 是 Vite 的静态资源目录：开发时按原路径直出，构建时整目录拷进 dist，
// 因此前端可以直接用相对路径 /help/xxx.html 引用，无需任何自定义协议或打包配置。
// 同步产物 public/help/ 已加入 .gitignore——源头始终是 docs/，避免两份副本漂移。
//
// 用法：
//   node scripts/sync-help-docs.mjs            # 一次性同步
//   node scripts/sync-help-docs.mjs --watch    # 监听 docs/ 变化自动重同步（dev 用）
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const outDir = join(root, "public", "help");

/** 需要同步进帮助中心的文件与目录（相对 docs/）。 */
const ENTRIES = [
  "operation-manual.html",
  "yunxiao-launch-modes.html",
  "screenshots/module-guide",
  "screenshots/yunxiao-launch-mode",
];

/** 文档里引用的截图目录，逐图校验可发现断链。 */
const REQUIRED_ASSETS = [
  "screenshots/module-guide/01-build-panel.png",
  "screenshots/module-guide/02-create-pr.png",
  "screenshots/module-guide/03-merge-hub.png",
  "screenshots/module-guide/04-knowledge-panel.png",
  "screenshots/module-guide/05-knowledge-graph-settings.png",
  "screenshots/yunxiao-launch-mode/01-issue-list-entries.png",
  "screenshots/yunxiao-launch-mode/02-direct-req-default.png",
  "screenshots/yunxiao-launch-mode/03-direct-req-clarify.png",
  "screenshots/yunxiao-launch-mode/04-direct-bug-locked.png",
  "screenshots/yunxiao-launch-mode/05-discussion-plan-dialog.png",
  "screenshots/yunxiao-launch-mode/06-todo-discussion-view.png",
  "screenshots/yunxiao-launch-mode/07-plan-preview.png",
  "screenshots/yunxiao-launch-mode/08-generate-todos.png",
  "screenshots/yunxiao-launch-mode/09-skills.png",
];

async function sync() {
  if (!existsSync(docsDir)) {
    console.error(`[help] 未找到 docs 目录：${docsDir}`);
    process.exit(1);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const missing = [];
  for (const entry of ENTRIES) {
    const src = join(docsDir, entry);
    if (!existsSync(src)) {
      missing.push(entry);
      continue;
    }
    const dest = join(outDir, entry);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true });
  }

  if (missing.length) {
    console.error(`[help] 缺少必需文件：\n  - ${missing.join("\n  - ")}`);
    process.exit(1);
  }

  const broken = REQUIRED_ASSETS.filter((rel) => !existsSync(join(outDir, rel)));
  if (broken.length) {
    console.error(`[help] 文档引用的截图未同步成功：\n  - ${broken.join("\n  - ")}`);
    process.exit(1);
  }

  const html = ENTRIES.filter((e) => e.endsWith(".html"));
  const size = (await stat(outDir)).size;
  console.log(`[help] 已同步 ${html.length} 份文档 + ${REQUIRED_ASSETS.length} 张截图 → public/help/`);
}

if (process.argv.includes("--watch")) {
  await sync();
  let timer = null;
  watch(docsDir, { recursive: true }, (_event, filename) => {
    if (!filename || !/(\.html|\.png)$/i.test(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      sync().catch((err) => console.error("[help] 同步失败：", err));
    }, 150);
  });
  console.log("[help] 监听 docs/ 变更中…（Ctrl+C 退出）");
} else {
  await sync();
}
