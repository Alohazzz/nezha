import { useEffect, useMemo, useState } from "react";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { kotlin, csharp } from "@codemirror/legacy-modes/mode/clike";
import { r } from "@codemirror/legacy-modes/mode/r";
import type { Extension } from "@codemirror/state";

function getFileExtension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function getSynchronousLanguageExtension(fileName: string): Extension {
  const nameMap: Record<string, () => Extension> = {
    dockerfile: () => StreamLanguage.define(dockerFile),
    "dockerfile.dev": () => StreamLanguage.define(dockerFile),
    "dockerfile.prod": () => StreamLanguage.define(dockerFile),
    makefile: () => StreamLanguage.define(shell),
    gnumakefile: () => StreamLanguage.define(shell),
    justfile: () => StreamLanguage.define(shell),
    gemfile: () => StreamLanguage.define(ruby),
    rakefile: () => StreamLanguage.define(ruby),
    vagrantfile: () => StreamLanguage.define(ruby),
    procfile: () => StreamLanguage.define(shell),
    "cmakelists.txt": () => StreamLanguage.define(shell),
    ".gitignore": () => StreamLanguage.define(shell),
    ".dockerignore": () => StreamLanguage.define(shell),
    ".env": () => StreamLanguage.define(shell),
    ".env.local": () => StreamLanguage.define(shell),
    ".env.example": () => StreamLanguage.define(shell),
    ".npmrc": () => StreamLanguage.define(toml),
    ".yarnrc": () => yaml(),
    "changelog.md": () => markdown(),
    readme: () => markdown(),
  };

  const lower = fileName.toLowerCase();
  if (nameMap[lower]) return nameMap[lower]();

  switch (getFileExtension(fileName)) {
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
      return json();
    case "rs":
      return rust();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
    case "sass":
      return css();
    case "md":
    case "mdx":
      return markdown();
    case "yaml":
    case "yml":
      return yaml();
    case "toml":
      return StreamLanguage.define(toml);
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return StreamLanguage.define(shell);
    case "py":
      return python();
    case "go":
      return go();
    case "java":
      return java();
    case "c":
    case "h":
      return cpp();
    case "cpp":
    case "cc":
    case "hpp":
      return cpp();
    case "sql":
      return sql();
    case "xml":
      return xml();
    case "swift":
      return StreamLanguage.define(swift);
    case "kt":
      return StreamLanguage.define(kotlin);
    case "cs":
    case "csx":
      return StreamLanguage.define(csharp);
    case "rb":
      return StreamLanguage.define(ruby);
    case "lua":
      return StreamLanguage.define(lua);
    case "r":
      return StreamLanguage.define(r);
    case "proto":
      return StreamLanguage.define(shell);
    default:
      return [];
  }
}

export async function loadLanguageExtension(fileName: string): Promise<Extension> {
  if (getFileExtension(fileName) === "vue") {
    const { vue } = await import("@codemirror/lang-vue");
    return vue();
  }

  return getSynchronousLanguageExtension(fileName);
}

export function useLanguageExtension(fileName: string): Extension {
  const fileExtension = getFileExtension(fileName);
  const fallbackExtension = useMemo(
    () => getSynchronousLanguageExtension(fileName),
    [fileName],
  );
  const [vueExtension, setVueExtension] = useState<Extension | null>(null);

  useEffect(() => {
    if (fileExtension !== "vue" || vueExtension) return;

    let cancelled = false;
    void loadLanguageExtension(fileName)
      .then((extension) => {
        if (!cancelled) setVueExtension(extension);
      })
      .catch((error: unknown) => {
        if (!cancelled && import.meta.env.DEV) {
          console.error("[file-viewer] Failed to load Vue syntax highlighting", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileExtension, fileName, vueExtension]);

  return fileExtension === "vue" && vueExtension ? vueExtension : fallbackExtension;
}
