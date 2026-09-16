# 调研：Nezha 内嵌 HTML 预览 / 浏览器选型（2026-09）

> 目的：回答「是否需要引入一个第三方 HTML 浏览器组件来实现本地 HTML 文件预览，还是用 Tauri 原生能力即可」。
> 结论先行：**不需要第三方组件。** GitHub / npm 上没有适合 Nezha 的可复用轻量组件；Tauri 原生已有三条可用路线，其中「sandboxed iframe + 同步读取文件内容」是与 Nezha 现有架构最契合的一条。
> 调研方法：一手来源优先（上游仓库源码、crates.io 本地 registry 源码、npm registry API、GitHub REST API 与 Tauri 官方文档），并在 Chromium 内核实测 CSP / sandbox 行为（见第 5 节）。
> 下游：本文是选型对比 + 实测记录。实施已按 `AGENTS.md` 的 issue-first 流程落为 issue [#86](https://github.com/Alohazzz/nezha/issues/86)。

---

## 0. 前置结论：上游没有实现

先确认这件事在 Nezha 生态里的现状（避免重复造轮子或撞车）：

- **上游 [hanshuaikang/nezha](https://github.com/hanshuaikang/nezha)（HEAD `8b1068a`，v0.4.7）没有任何 HTML 预览 / 内嵌浏览器。**
  - `git grep -n "iframe"` 在 `src/` 命中 0 处。
  - `git grep -n "WebviewWindow\|WebviewBuilder\|WebviewUrl\|add_child"` 在 `src-tauri/src/` 命中 0 处。
  - `Cargo.toml` 只挂 `tauri-plugin-opener` / `dialog` / `single-instance`；`tauri.conf.json` 未配置 `assetProtocol`。
  - 文件名维度搜 `browser|webview|html|preview`，只有 `ImagePreviewPane.tsx`、`MarkdownPreviewContent.tsx`、`GitFileBrowser.tsx`、`index.html`。
- 上游 `.html` 被当**普通代码文件**：走 CodeMirror `lang-html` 高亮编辑，不渲染。外链一律交给系统浏览器（commit `d1ce42d`，#391）。
- 上游 issue [#328「feat: 希望提供 html 直接预览的功能」](https://github.com/hanshuaikang/nezha/issues/328) 正是该需求，2026-06-19 提出、2026-07-30 被标 `completed` 关闭，但 **timeline 只有一条 `closed` 事件**（无评论、无 cross-reference、无关联 commit），以 `html` 为标题的 PR 数为 0，0.4.6→0.4.7 的提交里也无相关改动 —— **是被人工关闭的，代码层面未实现**。

当前 workspace（`Alohazzz/nezha`，`7b45fd9`）同样没有 HTML 文件预览；唯一的 HTML 渲染是帮助中心的 iframe（`src/components/help/HelpView.tsx`），但它依赖文档就放在同源 `public/help/` 下，与「预览任意本地 HTML」是两回事。

---

## 1. Nezha 的既有约束（决定选型的硬事实）

| 约束 | 事实 | 来源 |
|---|---|---|
| Tauri 版本 | `tauri` 2.10.3 / `wry` 0.54.3 / `tao` 0.34.6 | `src-tauri/Cargo.lock` |
| 已启用 tauri features | `tray-icon`、`devtools`（**仅此两项**） | `src-tauri/Cargo.toml:28` |
| CSP（全平台共一份） | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;` | `src-tauri/tauri.conf.json`（`tauri.windows.conf.json` 无 csp 覆盖） |
| 现有 iframe 能力 | CSP **无 `frame-src`**，回落 `default-src 'self'` → 仅同源 iframe 可加载 | 同上 |
| 文件读取上限 | `read_file_content` 硬限 **2 MB** | `src-tauri/src/fs.rs:542` |
| 路径校验 | `validate_path_within(target, root, allow_symlink_escape)`：canonicalize + `starts_with(root)` | `src-tauri/src/fs.rs:53` |
| 图片预览实现方式 | Rust 读字节 → base64 `data:` URL 返前端（`read_image_preview`，上限 10 MB） | `src-tauri/src/fs.rs:556` |
| 右面板内容层 | React DOM 层（`partition` 右列 / `fullscreen` 前景），非独立窗口 | `src/components/ProjectPage.tsx:603`、`src/hooks/useProjectPanels.ts:3` |
| 渲染前净化 | 已有 `DOMPurify`（v3.3.3）用于 Markdown | `src/utils/markdown.ts:40`、`package.json:62` |

两条最重要的推论：

1. **CSP 的成本集中体现在 asset 协议（B-2）上，而非 srcdoc（B-1）。** 当前的 `frame-src` 回落 `'self'` 会挡掉 `asset.localhost`，走 B-2 就必须放宽 `frame-src`/`img-src`。但**实测确认 srcdoc 不受此限制**（见第 5 节）—— 这是 B-1 相对 B-2 的关键优势：零 CSP 改动。远程 CDN 资源无论哪条路线都会被现有 `img-src`/`script-src` 拦下。
2. **右面板是 React DOM，不是窗口。** 任何「原生子 Webview」方案都是 OS 层浮层，不在 React 布局流里，只能靠手工同步坐标 —— 与现有 `partition`/`fullscreen` 布局直接冲突。

---

## 2. 候选 A：第三方组件（GitHub / npm 调研结果）

我把这两类都搜了：可复用的库，以及「同样是给 agent 看 HTML 的完整应用」。

### 2.1 完整应用（不可复用，但验证了需求）

| 项目 | ★ | 技术栈 | 与 Nezha 的关系 |
|---|---|---|---|
| [YiChin-17/html-agent-collab](https://github.com/YiChin-17/html-agent-collab) | 0 | Rust + Tauri 2 + WKWebView | 场景几乎一模一样（给 Claude Code / Codex 看单个 HTML 页面、页内批注）。但它是**独立 macOS 应用 + 自己的 `collab` CLI 协议**，不是库；且仅 macOS 15+，`source-only` 无签名包。不可嵌入。 |
| [claudecraft/claude-artifact-viewer](https://github.com/claudecraft/claude-artifact-viewer) | 2 | Windows: WPF + WebView2；macOS: Tauri | 「监听文件夹 → 渲染 HTML/MD/PDF」的独立应用，正是 Nezha 想做的功能的**外部竞品**。但它是 app 不是组件（Windows 用 WPF，无法复用）。 |
| [ericmaster/artifacts-manager](https://github.com/ericmaster/artifacts-manager) | 4 | — | 管理 agent 生成的 HTML/MD artifact 的独立 hub，同样非组件。 |

**结论**：这一档全部是独立应用，没有可嵌入 Nezha 的形态。它们只证明「这个需求真实且有人在单独做」。

### 2.2 可复用库（能装进 Nezha 的）

| 包 | 版本 / 许可 | 依赖 | 判定 |
|---|---|---|---|
| [`@mcp-ui/client`](https://www.npmjs.com/package/@mcp-ui/client) | 7.1.1 / Apache-2.0 | `@modelcontextprotocol/sdk`、`@modelcontextprotocol/ext-apps`、`zod`（peer: react） | **不采纳。** 它的 `HtmlResource` 确实是「sandboxed iframe 渲染 HTML」，但整套设计面向 **MCP resource + JSON-RPC postMessage 协议**，为「渲染一个本地 HTML 文件」引入 MCP SDK + zod 是概念错配且显著增重。Nezha 自己也还没有 MCP 宿主角色。 |
| [`safe-content-frame`](https://www.npmjs.com/package/safe-content-frame) | **0.0.30** / MIT | 无 | **不采纳。** 定位精准（"Secure iframe rendering for untrusted content"）、零依赖，但版本 **0.0.x 预发布**（2026-09-11 发布，距调研仅数天），不适合进生产。而且它解决的问题（iframe 沙箱）**浏览器原生 `sandbox` 属性已经解决**，属于零收益依赖。 |
| [`react-iframe`](https://www.npmjs.com/package/react-iframe) | 2.0.1 / ISC | 无（peer: react） | **不采纳。** 只是 iframe 的零依赖 typed 包装，写 5 行 JSX 即可达到同等效果，无引入价值。 |
| [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) | 0.0.76 | — | **不相关。** 名字像但用途是给 agent **执行代码**加安全边界（进程级沙箱），不是 HTML 渲染。列此排除。 |

**候选 A 总结：没有一个值得引入。** 原因不是"它们不好"，而是「在 iframe 里渲染本地 HTML」这件事的复杂度极低 —— 浏览器原生的 `sandbox` 属性 + 读文件就够，第三方库只会带来依赖、版本风险和 API 耦合。

---

## 3. 候选 B：Tauri 原生三条路线

这才是真正的对比。三条路线我都核到了源码级事实。

### B-1. iframe + `srcdoc`（前端读内容注入）

**做法**：前端 `invoke("read_file_content", …)` 拿到 HTML 字符串（受 2 MB 上限约束，`fs.rs:542`），注入 `<iframe sandbox srcdoc={html} />`。

| 维度 | 评估 |
|---|---|
| 依赖 / feature | **零**。不改 `Cargo.toml`。 |
| CSP 改动 | 需放开 `script-src`（若被预览页面要加载外部脚本）与 `img-src`（`asset.localhost` 不在 `img-src` 白名单）。srcdoc 文档继承父文档 CSP，因此**内联脚本**靠现有的 `'unsafe-inline'` 可跑。 |
| 隔离性 | `sandbox` 属性给 iframe **不透明源**（opaque origin），脚本无法触达父窗口 DOM/`localStorage`。这是浏览器级硬隔离，强于任何 JS 方案。 |
| 相对资源 | **主要短板，但可绕过。** srcdoc 的 base URL 是 `about:srcdoc`，页面里的 `<img src="./x.png">`、`<link href="style.css">` 全部失效。后续实现改为**在渲染前把项目内的相对资源读出来内联**（见第 7 节第 2 条），不需要 base/asset 重写。 |
| 文件大小 | 受 `read_file_content` 的 **2 MB** 上限约束；AI 生成的单文件 HTML 通常远小于此，但含内联 base64 图片的会超。 |
| 与现有架构契合度 | **最高。** 纯粹的 React DOM 节点，天然落在 `partition` 右列 / `fullscreen` 前景里，随布局自动伸缩。 |

### B-2. iframe + asset 协议（原生文件 URL）

**做法**：开 `app.security.assetProtocol`，`convertFileSrc(path)` 得到 URL，直接作为 iframe `src`。

| 维度 | 评估 |
|---|---|
| 依赖 / feature | **必须启用 `protocol-asset` feature** —— 它**不在** `default`（`tauri/Cargo.toml:114`，default 仅 `wry, compression, common-controls-v6, dynamic-acl, x11`）。同时要在 `tauri.conf.json` 配 `assetProtocol.scope`。 |
| URL 形态 | Windows/Android: `http://asset.localhost/<path>`；macOS/Linux: `asset://localhost/<path>`（`tauri/src/app.rs:1978`、`plugin.rs:632`）。**跨平台形态不一致**，需要分支处理。 |
| CSP 改动 | 必须显式加 `frame-src`（及 `img-src`）放行 `asset:` 与 `http://asset.localhost`（Tauri 官方 CSP 文档示例即 `"asset: http://asset.localhost"`）。 |
| 隔离性 | 与宿主 `tauri.localhost` 是**不同 host → 跨源**，脚本天然拿不到父窗口；但仍可加载远程资源、可导航，**建议叠加 `sandbox` 属性**收紧。 |
| 相对资源 | **优势：天然可用。** `src` 是真实 URL，页面内的相对路径按 asset URL 解析。 |
| 安全隐患 | **`scope` 是主要问题。** Nezha 的项目目录由用户任选、可位于磁盘任意位置，`scope` 想覆盖就得写得很宽（如 `$HOME/**`），等于把「读任意文件」的 URL 能力开放给 webview。这比 B-1 的「显式读指定文件」防线更弱，**与 `AGENTS.md`「所有接受路径参数的 Tauri 命令必须验证路径合法性」的精神相悖**。 |
| 附带发现 | asset 协议**不注入 CSP**（`tauri/src/protocol/asset.rs` 全文无 csp 处理），只设 `Content-Type` 并按 mime 探测 —— 即被预览 HTML 的脚本在该 frame 内不受 CSP 约束。 |

### B-3. 原生子 Webview（`add_child`）

**做法**：Rust 侧 `Window::add_child(WebviewBuilder::new(...).url(...), position, size)` 在主窗口内嵌一个真正的 webview。

| 维度 | 评估 |
|---|---|
| 依赖 / feature | **必须启用 `unstable` feature。** `add_child` 的 gate 是 `#[cfg(any(test, all(desktop, feature = "unstable")))]`（`tauri/src/window/mod.rs:1051`）。Tauri 也把 `Window::builder` 标为 `unstable`（`mod.rs:1040`）。引入 `unstable` 是**对整个应用的持续承诺**，不是局部改动。 |
| 若改用 `data:` URL | 需要 **`webview-data-url`** feature，同样**不在 default**（`tauri/Cargo.toml:128`，且依赖 `tauri-utils/html-manipulation`）。 |
| 与现有架构契合度 | **最差。** 子 webview 是 OS 层浮层，不在 React DOM 里 → 不参与 `partition`/`fullscreen` 的 flex 布局，需手工同步坐标、z-order、DPI、面板开合与窗口 resize。`AGENTS.md` 明确要求新功能往既有子目录下沉、组件 ≤400 行，此方案引入的坐标同步状态会直接违背这条。 |
| 其他成本 | Windows 上 `dragDropEnabled` 与 HTML5 拖拽冲突（`webview.d.ts` 有明确注释）；`transparent` 在 macOS 要 `macos-private-api`（影响 App Store 上架）。 |
| 隔离性 | 最强（独立 webview 进程边界），但 Nezha 的场景（用户自己项目里的 AI 生成 HTML）不需要这个级别的隔离。 |

---

## 4. 推荐

**推荐 B-1（sandboxed iframe + `srcdoc`）；相对资源由前端内联解决（见第 7 节第 2 条），残余的远程资源作为已知限制标注。**

理由：

1. **零新增依赖、零 feature 改动、零 CSP 改动** —— 而 B-2 要开 `protocol-asset` 且必须放宽 CSP、B-3 要开 `unstable`。对 Nezha 这种已经把终端性能红线当命脉的项目，`unstable` feature 尤其不该为了一个预览面板引入。
2. **与现有架构零摩擦** —— 纯 React DOM 节点，直接落在既有 `partition`/`fullscreen` 内容层（`ProjectPage.tsx:603`）与右面板 union（`useProjectPanels.ts:3`）里；B-3 的坐标同步则与这套布局正面冲突。
3. **安全模型最保守** —— 复用既有的 `validate_path_within` 路径校验（`fs.rs:53`）+ 显式读取单个文件，而不是 B-2 那种"把 asset 协议 scope 开宽"的隐式授权。`sandbox` 属性再给一层浏览器级硬隔离（实测有效，见第 5 节）。
4. **复用既有实现范式** —— 与图片预览（Rust 读字节回传前端，`fs.rs:556`）同构，维护者心智负担最低。

**实施要点（已落地于 issue [#86](https://github.com/Alohazzz/nezha/issues/86)）：**

- 落点：`src/components/file-viewer/HtmlPreviewPane.tsx` 新增预览组件（该目录已有 `ImagePreviewPane.tsx` 先例）；`FileViewer.tsx` 的类型分流处加 `html` 分支；`previewModes` 默认开预览与 `.md` 一致。
- iframe 用 `sandbox="allow-scripts"`，**不含** `allow-same-origin`（实测：加上即让子文档可读写宿主 `document` 与 `localStorage`）。
- 相对资源在渲染前内联（`src/utils/htmlPreview.ts`）；仍未加载的引用（远程 CDN、超限、缺失）由预览内提示告知。
- **无需改 CSP**（与本节第 1 条的实测结论一致）。

---

## 5. 实测验证（2026-09，Chromium 内核）

用与 `tauri.conf.json` **逐字相同**的 CSP（meta 形式）在 Chromium 内核（WebView2 同内核）实测，覆盖三组结论：

| 验证项 | 方法 | 结果 |
|---|---|---|
| srcdoc 是否被现有 CSP 挡下 | 同款 CSP 下创建 `<iframe srcdoc>` | **不被挡**。`frame-src` 回落 `default-src 'self'` 不拦 srcdoc，加载并触发 `load` ✓ |
| 内联脚本能否运行 | iframe `sandbox="allow-scripts"`，子文档内联 `<script>` 回 postMessage | **可以运行** ✓ |
| 沙箱是否隔离宿主 | 子文档尝试读 `parent.document` / `parent.__secret` / `parent.localStorage` | `allow-scripts`：**全部 BLOCKED** ✓<br>`allow-scripts allow-same-origin`：**全部 REACHABLE**（可读到父窗口 `document` 与 `localStorage`）✗ |
| 内联 / data: / blob: 图片 | 分别用 base64 与 `URL.createObjectURL` | data: **LOADED** ✓、blob: **LOADED** ✓ |
| 远程资源 | `https://example.com/*.png` 与远程 `<script src>` | 图片 **ERROR**、脚本 **BLOCKED**（被 `img-src` / `script-src` 拦）——符合预期 |

**两条对实现有直接影响的结论：**

1. **基础预览零 CSP 改动即可工作。** 不需要为了 srcdoc 去动 `frame-src`。原调研中"无论选哪条路都要动 CSP"的判断，对 B-1 并不成立（只对 B-2 的 asset 协议成立）。
2. **`allow-same-origin` 绝不可加。** 实测下它会让被预览文档直接读写宿主 `document` 与 `localStorage`，沙箱隔离完全失效。已固化进实现与测试（`html-preview.test.tsx` 断言 sandbox 排除该标志）。

### 5.1 残留风险：nonce 会静默废掉 `'unsafe-inline'`

Tauri 在生产构建会做 **CSP nonce 注入**（`tauri/src/manager/mod.rs::set_csp`）：把 asset HTML 里的 `__TAURI_SCRIPT_NONCE__` / `__TAURI_STYLE_NONCE__` 占位符替换为随机 nonce，并把 `'nonce-…'` **追加**（不会移除 `'unsafe-inline'`）进 `script-src` / `style-src`。

但按 CSP 规范，**指令中一旦出现 nonce 或 hash，`'unsafe-inline'` 即被忽略**。实测 A/B 确认：

- 仅 `script-src 'self' 'unsafe-inline'` → srcdoc 内联脚本 **执行**；
- `script-src 'self' 'unsafe-inline' 'nonce-abc123'` → srcdoc 内联脚本 **被阻断**。

**当前 Nezha 不受影响**：`index.html` 只有外部 module script、无内联 `<script>`/`<style>`（构建产物 `dist/index.html` 中亦无 nonce 占位符），因此 `nonces` 与 `hashes` 均为空，`set_csp` 的 `if !(nonces.is_empty() && hashes.is_empty())` 不成立 → **不注入 nonce** → `'unsafe-inline'` 保持有效，预览脚本在 dev 与生产都能跑。

**但这是隐式依赖。** 若日后有人在 `index.html` 里加内联脚本或样式（或引入会内联脚本的插件），Tauri 会开始注入 nonce，届时**预览内的内联脚本会静默失效**（HTML/CSS 仍渲染，只有脚本不跑，很难排查）。改动 `index.html` 或升级 Tauri 大版本时需回归此项。

---

## 6. 结论

- **第三方组件**：无值得引入者（`@mcp-ui/client` 概念错配且重；`safe-content-frame` 停在 0.0.x 预发布）；三个同类开源项目均为独立应用，不可嵌入。
- **三条原生路线**：推荐 **B-1（sandboxed iframe + `srcdoc`）**；B-2（asset 协议）因 `scope` 过宽与跨平台 URL 差异不推荐；B-3（子 Webview）因需 `unstable` feature 且与 React 布局冲突而排除。
- **实测确认**：B-1 在现有 CSP 下**开箱可用**，不需要放宽 CSP；安全边界由 `sandbox="allow-scripts"`（且**不含** `allow-same-origin`）提供，已实测隔离有效。
- **已实现**：见 `src/components/file-viewer/HtmlPreviewPane.tsx`（issue [#86](https://github.com/Alohazzz/nezha/issues/86)）。

## 7. 已知限制

1. **2 MB 上限**：`read_file_content` 硬限 2 MB（`fs.rs:542`）。含内联 base64 大图的 HTML 会超限报错。
2. **相对资源已内联（2026-09 后续实现）**：早期实现里 srcdoc 的 base URL 为 `about:srcdoc`，`./x.css`、`../assets/q.js` 一律不加载，结果是「HTML 渲染出来了但完全没有样式」。现由 `src/utils/htmlPreview.ts` 在渲染前把项目内的相对资源读出来内联（`<link>` → `<style>`、`<script src>` → `<script>`、`<img src>` → data URL、CSS `url()` / `@import` → 内联），**不需要开 asset 协议、不需要改 CSP**；解析后仍用项目根做包含校验，`../../` 逃逸引用不会被读取。
   - 仍未覆盖：远程 CDN 引用（被应用 CSP 拦下）、单个资源超 2 MB、文件缺失、正文含 `</script` / `</style`（无法安全内联）。这些计入「未加载」并各出一行提示。
   - 内联总量上限 8 MB、`@import` 递归深度上限 4 层（`HtmlPreviewPane.tsx`）。
3. **不可导航**：`allow-scripts` 不含 `allow-top-navigation`，页面内链接不会劫持宿主窗口（符合预期）。页间链接（`href="./0002-….html"`）因此仍跳不动。
4. **nonce 残留风险**：见 5.1。


---

## 附：证据索引

| 事实 | 一手来源 |
|---|---|
| 上游无 iframe / webview / assetProtocol | `git grep` on `upstream/main`；`git show upstream/main:src-tauri/Cargo.toml`、`:src-tauri/tauri.conf.json` |
| issue #328 timeline 只有 closed 事件 | GitHub REST `repos/hanshuaikang/nezha/issues/328/timeline` |
| `tauri` 2.10.3 / `wry` 0.54.3 | `src-tauri/Cargo.lock` |
| `protocol-asset` / `webview-data-url` / `unstable` 均非 default feature | `tauri-2.10.3/Cargo.toml:82-131` |
| `add_child` gate `feature = "unstable"` | `tauri-2.10.3/src/window/mod.rs:1051`、`:1040` |
| asset 协议 URL 形态 `http://<scheme>.localhost` | `tauri-2.10.3/src/app.rs:1978`、`src/plugin.rs:632` |
| asset 协议不注入 CSP | `tauri-2.10.3/src/protocol/asset.rs`（全文无 csp） |
| CSP `frame-src` 回落 `default-src`、需放行 `asset:` | Tauri 官方文档 `v2.tauri.app/security/csp` |
| srcdoc 不被 CSP 拦 / sandbox 隔离 / nonce 使 unsafe-inline 失效 | 本次 Chromium 内核实测（第 5 节）；nonce 注入逻辑见 `tauri-2.10.3/src/manager/mod.rs:50-145`、token 字面量 `tauri-utils-2.8.3/src/assets.rs:16-18` |
| `read_file_content` 2 MB 上限 / `read_image_preview` 10 MB | `src-tauri/src/fs.rs:542`、`:570` |
| `validate_path_within` | `src-tauri/src/fs.rs:53` |
| 右面板 union / 内容层 | `src/hooks/useProjectPanels.ts:3`、`src/components/ProjectPage.tsx:603` |
| 已装 DOMPurify | `src/utils/markdown.ts:40`、`package.json:62` |
| npm 包元数据 | npm registry API（`@mcp-ui/client` 7.1.1、`safe-content-frame` 0.0.30、`react-iframe` 2.0.1） |
