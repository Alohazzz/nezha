# 第三方资产说明 · ppt/

本目录下的 `index.html` 是一个自包含的单文件演示稿，为了**离线可用**（本机与部分内网环境访问不到
Google Fonts），把下列第三方资产做了本地内联/自托管。各自许可以下：

| 资产 | 位置 | 许可 | 版权 |
|---|---|---|---|
| Lucide 图标库 | `assets/lucide.min.js` | ISC | © Lucide Contributors |
| Motion One | `assets/motion.min.js` | MIT | © Motion One / Matt Perry |
| Inter 字体（woff2 子集） | `assets/fonts/inter-*.woff2` | SIL OFL 1.1 | © Google Inc.（见 `assets/fonts/LICENSE-inter-OFL.txt`） |

`index.html` 会先加载本地副本，并保留 CDN 作为兜底（lucide 走 `unpkg.com`，Motion 走 `cdn.jsdelivr.net`）。

## 不随仓库分发

- **guizang-ppt-skill 模板**：生成本演示稿所用的 skill 以 **AGPL-3.0** 分发，其
  `assets/template-swiss.html` 不复制进本仓库。`ppt/tools/build.py` 会在需要重新生成时
  自动从本机已安装的 skill 目录解析模板（见 `TPL_CANDIDATES`）。
- 本地渲染校验产物（`ppt/.shots/`）已在 `.gitignore` 中排除。
