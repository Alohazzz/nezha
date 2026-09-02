/**
 * 轻量符号提取器：在 CodeMirror 编辑器之外，纯字符串层面从代码行里提取
 * 「类 / interface / 函数 / 方法」等符号及其所在行号，供代码大纲侧栏做
 * 「点符号 → 跳转到对应行」的导航。
 *
 * 定位目标是 lexer 无法覆盖的尽够用场景：不依赖语言服务，按行号 + 正则
 * 扫描，跨主流语言（ts/js、python、rust、go、java、c/cpp、c#、swift、
 * kotlin、ruby、lua、php、shell）/ 识别声明。未知语言返回空数组，属预期。
 */

export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "struct"
  | "trait"
  | "type"
  | "function"
  | "method"
  | "module"
  | "other";

export interface CodeSymbol {
  name: string;
  /** 1-based 行号 */
  line: number;
  kind: SymbolKind;
  /** 大纲缩进层级，1 = 顶层，越大越深 */
  depth: number;
}

interface Rule {
  re: RegExp;
  kind: SymbolKind;
}

/** 控制流/关键字，用于方法识别时排除误报 */
const BLOCK_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "do", "else", "return", "throw",
  "try", "with", "function", "class", "interface", "type", "enum", "case",
  "finally", "as", "await", "yield", "new", "delete", "typeof", "void", "in",
  "of", "this", "super", "break", "continue", "debugger", "import", "export",
  "extends", "implements", "default", "match", "when", "where", "unless",
  "until", "begin", "then", "do", "end", "def", "fn", "func", "let", "var",
  "const", "struct", "trait", "impl", "use", "pub", "mod", "select",
]);

const MODIFIERS =
  "(?:(?:public|private|protected|static|async|readonly|abstract|override|get|set|" +
  "declare|final|internal|open|unsafe|virtual|extern|mut|const|pub|synchronized|" +
  "native|default|strictfp|sealed)\\s+)*";

// 大括号语言的方法识别：要求"缩进 + 名称(...) + {"，排除控制流关键字。
// 名称允许紧跟泛型 <...>，括号内允许任意参数，返回值类型以 : 开头且不含 '{'。
const METHOD_RE = new RegExp(
  "^(\\s+)" + MODIFIERS + "([A-Za-z_$][\\w$]*)\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{",
);

/** 从缩进推导大纲层级：0 缩进 = 1，每 2 格 +1，最深 5 */
function depthOfIndent(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 2;
    else break;
  }
  return Math.max(1, Math.min(5, Math.floor(n / 2) + 1));
}

function isCodeLine(trimmed: string): boolean {
  if (!trimmed) return false;
  return !(
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("'") ||
    trimmed.startsWith("<!--")
  );
}

function getFamily(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const lower = fileName.toLowerCase();
  if (ext === "ts" || ext === "tsx") return "ts";
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "ts";
  if (ext === "py" || ext === "pyw") return "py";
  if (ext === "rs") return "rs";
  if (ext === "go") return "go";
  if (ext === "java") return "java";
  if (ext === "c" || ext === "h" || ext === "cpp" || ext === "cxx" || ext === "cc" || ext === "hpp") return "c";
  if (ext === "cs") return "cs";
  if (ext === "swift") return "swift";
  if (ext === "kt" || ext === "kts") return "kt";
  if (ext === "rb" || ext === "rake" || ext === "ru") return "rb";
  if (ext === "lua") return "lua";
  if (ext === "php") return "php";
  if (ext === "sh" || ext === "bash" || ext === "zsh") return "sh";
  if (lower === "makefile" || lower === "gnumakefile" || lower === "justfile") return "sh";
  return "none";
}

const BRACE_FAMILIES = new Set(["ts", "c", "cs", "kt", "swift"]);

function rulesFor(family: string): Rule[] {
  switch (family) {
    case "ts":
      return [
        { re: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/, kind: "function" },
        { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
        { re: /^(?:export\s+)?(?:abstract\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
        { re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type" },
        { re: /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
        { re: /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|=>)/, kind: "function" },
      ];
    case "py":
      return [
        { re: /^\s*async\s+def\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
        { re: /^\s*def\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
        { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
      ];
    case "rs":
      return [
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/, kind: "function" },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: "type" },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: "module" },
      ];
    case "go":
      return [
        { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "function" },
        { re: /^\s*type\s+([A-Za-z_]\w*)\s+struct/, kind: "struct" },
        { re: /^\s*type\s+([A-Za-z_]\w*)\s+interface/, kind: "interface" },
      ];
    case "java":
      return [
        { re: /^\s*(?:public|protected|private|static|final|abstract|sealed|strictfp|@interface)\s+(?:class|interface|enum|@interface)\s+([A-Za-z_]\w*)/, kind: "other" },
        { re: /^\s*record\s+([A-Za-z_]\w*)/, kind: "class" },
      ];
    case "c":
      return [
        { re: /^\s*(?:typedef\s+)?(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:unsigned\s+)?(?:struct|class|union|enum)\s+([A-Za-z_]\w*)/, kind: "other" },
        { re: /^\s*(?:[A-Za-z_][\w]*\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/, kind: "function" },
      ];
    case "cs":
      return [
        { re: /^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|record)?\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
        { re: /^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|readonly)?\s*interface\s+([A-Za-z_]\w*)/, kind: "interface" },
        { re: /^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|readonly)?\s*enum\s+([A-Za-z_]\w*)/, kind: "enum" },
        { re: /^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|readonly)?\s*record\s+([A-Za-z_]\w*)/, kind: "class" },
        { re: /^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|readonly)?\s*struct\s+([A-Za-z_]\w*)/, kind: "struct" },
      ];
    case "swift":
      return [
        { re: /^\s*(?:public|private|internal|fileprivate|open|static|final|class|struct|enum|protocol|extension)\s+func\s+([A-Za-z_]\w*)\s*[<(]/, kind: "function" },
        { re: /^\s*(?:public|private|internal|fileprivate|open|final)?\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)/, kind: "other" },
        { re: /^\s*(?:public|private|internal|fileprivate|open)?\s*protocol\s+([A-Za-z_]\w*)/, kind: "interface" },
        { re: /^\s*(?:public|private|internal|fileprivate|open)?\s*extension\s+([A-Za-z_]\w*)/, kind: "module" },
      ];
    case "kt":
      return [
        { re: /^\s*(?:public|private|protected|internal|open|final|abstract|override|suspend|inline|data|sealed|inner)?\s*(?:fun)\s+([A-Za-z_]\w*)\s*[<(]/, kind: "function" },
        { re: /^\s*(?:public|private|protected|internal|open|final|abstract|data|sealed|enum|annotation)?\s*(?:class|interface|object|enum class)\s+([A-Za-z_]\w*)/, kind: "other" },
      ];
    case "rb":
      return [
        { re: /^\s*def\s+([A-Za-z_]\w*(?:[?.!]|=[^=])?)\s*(?:\(|$)/, kind: "function" },
        { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
        { re: /^\s*module\s+([A-Za-z_]\w*)/, kind: "module" },
      ];
    case "lua":
      return [
        { re: /^\s*(?:local\s+)?function\s+(?:[A-Za-z_]\w*[.:])?([A-Za-z_]\w*)\s*\(/, kind: "function" },
      ];
    case "php":
      return [
        { re: /^\s*(?:public|protected|private|static|abstract|final|function)?\s*function\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
        { re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
        { re: /^\s*interface\s+([A-Za-z_]\w*)/, kind: "interface" },
      ];
    case "sh":
      return [
        { re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/, kind: "function" },
      ];
    default:
      return [];
  }
}

/**
 * 从文件内容提取代码符号。纯同步、单次遍历，只在文件打开/编辑时调用，
 * 对超大文件有开销但可接受（大纲默认折叠，符号数量通常远小于行数）。
 */
export function extractCodeSymbols(fileName: string, content: string): CodeSymbol[] {
  const family = getFamily(fileName);
  if (family === "none") return [];

  const rules = rulesFor(family);
  const methodEnabled = BRACE_FAMILIES.has(family);
  const symbols: CodeSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!isCodeLine(trimmed)) continue;
    const line = i + 1;
    const depth = depthOfIndent(raw);

    let matched = false;
    for (const rule of rules) {
      const m = rule.re.exec(trimmed);
      if (m && m[1]) {
        symbols.push({ name: m[1], line, kind: rule.kind, depth });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 大括号语言：缩进的 "名称(...)  {" 视为方法
    if (methodEnabled && /^\s+/.test(raw)) {
      const m = METHOD_RE.exec(raw);
      if (m && m[2] && !BLOCK_KEYWORDS.has(m[2])) {
        symbols.push({ name: m[2], line, kind: "method", depth });
      }
    }
  }

  return symbols;
}
