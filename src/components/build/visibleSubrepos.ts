/** 构建面板「可选子仓库」白名单的共享定义。
 *
 * 默认行为是**不限制**：未配置（空列表 / 字段缺失）时列出全部发现的仓库
 * （主仓库恒显示）。需要收缩的用户在项目设置页勾选；与后端
 * `src-tauri/src/build.rs` 的 `visible_subrepos` 缺省语义保持一致。
 */

/** 仓库是否需要按白名单过滤的最小结构（主仓库 / 子模块 / 嵌套仓库）。 */
interface FilterableRepo {
  name: string;
  path: string;
  is_submodule: boolean;
}

/** 按白名单过滤仓库：主仓库（路径等于 rootPath）恒显示；其余仓库（子模块 /
 * 嵌套仓库）的名称或路径命中任一关键字（忽略大小写）才展示。`patterns` 缺省
 * 或为空数组均表示不限制，展示全部仓库。 */
export function filterVisibleRepos<T extends FilterableRepo>(
  list: T[],
  patterns?: string[],
  rootPath?: string,
): T[] {
  const keys = (patterns ?? [])
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (keys.length === 0) return list;
  const root = rootPath?.replace(/\\/g, "/").toLowerCase();
  return list.filter((r) => {
    if (root !== undefined && r.path.replace(/\\/g, "/").toLowerCase() === root) {
      return true;
    }
    // 兜底：discover 保证主仓库在列表首位；rootPath 未传时不误杀它。
    if (root === undefined && r === list[0]) return true;
    return keys.some(
      (k) => r.name.toLowerCase().includes(k) || r.path.toLowerCase().includes(k),
    );
  });
}

/** 把配置里保存的关键字对齐到实际发现的仓库名（多选下拉的值必须是真实存在的选项）。
 *
 * 匹配口径与 `filterVisibleRepos`（及后端 build.rs 的过滤）保持一致：关键字是**子串**，
 * 同时比对名称与路径。这样才能让历史配置里的 `DrugInOut` 这类缩写关键字正确勾中
 * `Nto.His/Nto.His.DrugInOut`；直接按字面比较会出现「已选 N 项但一个都没勾上」。
 *
 * 匹配不到任何仓库的关键字原样保留：仓库可能只是当前未初始化 / 目录缺失，
 * 不能因为这一刻发现不到就把用户的配置悄悄丢掉。
 */
export function resolveVisibleSubrepos(
  saved: string[],
  repos: Array<{ name: string; path: string }>,
): string[] {
  const out: string[] = [];
  for (const raw of saved) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const hit = repos.find(
      (r) => r.name.toLowerCase().includes(key) || r.path.toLowerCase().includes(key),
    );
    const value = hit ? hit.name : raw.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}
