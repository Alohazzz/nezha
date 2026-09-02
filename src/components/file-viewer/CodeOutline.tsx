import { useState } from "react";
import { List } from "lucide-react";
import { useI18n } from "../../i18n";
import type { CodeSymbol } from "./codeSymbols";

const OPEN_STORAGE_KEY = "nezha:code-outline-open";

const KIND_GLYPH: Record<CodeSymbol["kind"], string> = {
  class: "C",
  interface: "I",
  enum: "E",
  struct: "S",
  trait: "T",
  type: "T",
  function: "ƒ",
  method: "ƒ",
  module: "M",
  other: "•",
};

/**
 * 代码符号大纲：列出当前文件里的类 / 函数 / 方法等符号，点击跳到对应行。
 * 交互与 Markdown 的 TOC 一致——右侧固定栏、可折叠、内存缩进层级。
 * 纯展示层：符号由上层 extractCodeSymbols 计算，点击只上报行号。
 */
export function CodeOutline({
  symbols,
  onJump,
}: {
  symbols: CodeSymbol[];
  onJump: (line: number) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(OPEN_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [activeLine, setActiveLine] = useState<number | null>(null);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore storage failure
      }
      return next;
    });
  };

  return (
    <div className={`code-outline${open ? "" : " code-outline-collapsed"}`}>
      <button
        type="button"
        className="code-outline-toggle"
        onClick={toggle}
        title={t("file.codeOutline")}
        aria-label={t("file.codeOutline")}
      >
        <List size={13} />
        {open && <span>{t("file.codeOutline")}</span>}
      </button>
      {open && (
        <nav className="code-outline-list">
          {symbols.length === 0 ? (
            <span className="code-outline-empty">{t("file.noSymbols")}</span>
          ) : (
            symbols.map((symbol, idx) => (
              <button
                key={`${symbol.line}-${symbol.kind}-${idx}`}
                type="button"
                data-depth={Math.min(symbol.depth, 6)}
                data-kind={symbol.kind}
                className={`code-outline-item${activeLine === symbol.line ? " active" : ""}`}
                title={`${symbol.name} · L${symbol.line}`}
                onClick={() => {
                  setActiveLine(symbol.line);
                  onJump(symbol.line);
                }}
              >
                <span className="code-outline-kind">{KIND_GLYPH[symbol.kind]}</span>
                <span className="code-outline-name">{symbol.name}</span>
                <span className="code-outline-line">L{symbol.line}</span>
              </button>
            ))
          )}
        </nav>
      )}
    </div>
  );
}
