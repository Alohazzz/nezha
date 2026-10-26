import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
// 类型-only 导入（编译期擦除，不产生静态依赖；先例：AgentConfigPanel 的
// import type { Highlighter }）。运行时的 import("shiki") 仍是动态红线内的唯一入口。
import type { BundledLanguage, BundledTheme, CodeToTokensOptions } from "shiki";
import { useI18n } from "../../i18n";
import s from "../../styles";
import type { CodexThemeVariant } from "./useCodexThemeVariant";
import { useCodexThemeVariant } from "./useCodexThemeVariant";
import {
  guessDiffLanguage,
  truncateCodexDiffFile,
  type CodexDiffFile,
  type CodexDiffRow,
} from "./codexDiffParse";

// ── diff 两段式渲染（issue #117 T4）────────────────────────────────────────────
// 首帧：纯文本行级着色（data-type 选择器出 +/- 底色，零语法高亮成本）。
// 空闲时：动态 import("shiki") 补语法高亮——shiki 主包与语言包都不得静态导入
// （红线）。语言按扩展名小表猜测，未命中 / 加载失败 / 高亮失败一律停留纯文本。
//
// 实现走 codeToTokens（整文件一次调用）：tokens 与 diff 行 1:1 对位，token 色
// 以生成 HTML span 注入（先例：AgentConfigPanel 的 dangerouslySetInnerHTML +
// escapeHtml）。token 色是运行时值，属于生成 HTML 自带的 inline color，不是
// React style={{}}（规范禁的是后者）。
//
// 竞态防护：effect 内递增 requestId，异步完成时比对——卸载 / 条目变更 / 主题
// 切换产生的过期结果全部丢弃（先例：GitChanges 仓库竞态）。

/** 单文件 diff 行数护栏（spec：超 2000 行截断）。 */
export const CODEX_DIFF_MAX_ROWS = 2000;

/** 应用四主题 → shiki 内置主题（写死四项表，spec Implementation Decisions）。 */
const SHIKI_THEME_BY_VARIANT: Record<CodexThemeVariant, string> = {
  dark: "github-dark",
  midnight: "github-dark",
  light: "github-light",
  eyecare: "solarized-light",
};

type IdleHandle = number;

function scheduleIdle(cb: () => void): IdleHandle {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (typeof ric === "function") return ric(cb);
  return setTimeout(cb, 50) as unknown as number;
}

function cancelIdle(handle: IdleHandle): void {
  const cic = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
  if (typeof cic === "function") cic(handle);
  else clearTimeout(handle);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** shiki ThemedToken 的结构子集（避免静态类型导入，保持 import("shiki") 动态）。 */
type DiffTokenMap = Map<number, string>;

/**
 * 高亮入口：返回「diff 行下标 → token HTML」映射。shiki 主包与语言包都在这里
 * 才动态加载；getSingletonHighlighter 内部缓存语言与主题，重复调用只加载增量。
 * 任何失败（语言缺失 / 主题缺失 / 引擎错误）抛给调用方 → 停留纯文本。
 */
async function buildTokenHtml(
  rows: CodexDiffRow[],
  lang: string,
  shikiTheme: string,
): Promise<DiffTokenMap> {
  const shiki = await import("shiki");
  // 猜测语言未收录时 shiki 会抛错 → 调用方 catch 后停留纯文本（宽容语义）。
  // lang / theme 来自小表与运行时字符串，这里一次性收窄到 shiki 的字面量联合。
  type SingletonOptions = NonNullable<Parameters<typeof shiki.getSingletonHighlighter>[0]>;
  const options = { themes: [shikiTheme], langs: [lang] } as SingletonOptions;
  const highlighter = await shiki.getSingletonHighlighter(options);
  const code = rows.map((r) => r.content).join("\n");
  // lang/theme 是运行时字符串（小表 / 推导值），这里收窄到 shiki 的字面量联合
  const tokenOptions: CodeToTokensOptions<BundledLanguage, BundledTheme> = {
    lang: lang as BundledLanguage,
    theme: shikiTheme as BundledTheme,
  };
  const tokens = highlighter.codeToTokens(code, tokenOptions);
  const map: DiffTokenMap = new Map();
  tokens.tokens.forEach((lineTokens, lineIndex) => {
    if (lineIndex >= rows.length) return;
    const html = lineTokens
      .map((tk) => `<span style="color:${tk.color}">${escapeHtml(tk.content)}</span>`)
      .join("");
    map.set(lineIndex, html);
  });
  return map;
}

/** 单文件 diff 视图：hunk 行 + 行号 + 两段式高亮 + 截断 footer。 */
export const CodexDiffView = memo(function CodexDiffView({
  file,
  maxRows = CODEX_DIFF_MAX_ROWS,
  onOpenFullDiff,
}: {
  file: CodexDiffFile;
  /** 行数护栏（测试注入小值）；超出截断并在尾部给跳转入口。 */
  maxRows?: number;
  /** 截断时的跳转回调（接 GitChanges 右面板；缺省则 footer 只显示提示）。 */
  onOpenFullDiff?: () => void;
}): ReactNode {
  const { t } = useI18n();
  const variant = useCodexThemeVariant();
  const shikiTheme = SHIKI_THEME_BY_VARIANT[variant];
  // useMemo 稳定引用（fix review：直接 const 每渲染新对象 → effect 依赖比较
  // 永远不等 → 高亮 effect 无限循环：highlight → setState → 新 identity →
  // cleanup setState(null) → 再 highlight……）。file / maxRows 不变时保持同一引用。
  const truncated = useMemo(() => truncateCodexDiffFile(file, maxRows), [file, maxRows]);
  const lang = guessDiffLanguage(file.path);
  // tokenHtml：行下标 → 高亮 HTML；null = 纯文本阶段（首帧）或高亮失败
  const [tokenHtml, setTokenHtml] = useState<DiffTokenMap | null>(null);

  // 竞态防护：卸载 / file 变更 / 主题切换 → 过期结果丢弃
  useEffect(() => {
    let cancelled = false;
    setTokenHtml(null);
    if (!lang) return;

    const handle = scheduleIdle(() => {
      if (cancelled) return;
      buildTokenHtml(truncated.file.hunks.flatMap((h) => h.rows), lang, shikiTheme)
        .then((map) => {
          if (!cancelled) setTokenHtml(map);
        })
        .catch((err: unknown) => {
          // 高亮失败停留纯文本——dev 可见，不静默成黑箱（红线：silent catch 配 log）
          if (!cancelled) console.warn("[codex-diff] shiki highlight unavailable:", err);
        });
    });

    return () => {
      cancelled = true;
      cancelIdle(handle);
    };
  }, [lang, shikiTheme, truncated]);

  let flatIndex = -1;

  return (
    <div>
      {truncated.file.hunks.map((hunk, hunkIdx) => (
        <div key={hunkIdx}>
          <span className="codex-stream-diff-row" data-type="meta" style={s.codexDiffHunkHeader}>
            {hunk.header}
          </span>
          {hunk.rows.map((row, rowIdx) => {
            flatIndex += 1;
            const html = tokenHtml?.get(flatIndex);
            return (
              <span
                key={rowIdx}
                className="codex-stream-diff-row codex-stream-diff-code"
                data-type={row.type}
                style={s.codexDiffLineRow}
              >
                <span style={s.codexDiffLineNo}>
                  {row.oldLine !== undefined ? row.oldLine : ""}
                </span>
                <span style={s.codexDiffLineNo}>
                  {row.newLine !== undefined ? row.newLine : ""}
                </span>
                {html ? (
                  <span dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                  // React 文本节点自带转义——这里直接渲染原文（fix review：
                  // 之前 escapeHtml 后作为 JSX 文本会双重转义，`<` 显示成 `&lt;`）
                  <span>{row.content}</span>
                )}
              </span>
            );
          })}
        </div>
      ))}
      {truncated.truncated && (
        <div style={s.codexDiffTruncateFooter} data-testid="codex-diff-truncated">
          <span>
            {t("codex.diff.truncated", {
              count: truncated.omittedRows,
              limit: maxRows,
            })}
          </span>
          {onOpenFullDiff && (
            <button
              type="button"
              style={s.codexDiffTruncateJump}
              onClick={onOpenFullDiff}
              data-testid="codex-diff-jump"
            >
              {t("codex.diff.openGitChanges")}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
