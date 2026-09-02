import { describe, expect, it } from "vitest";
import { extractCodeSymbols } from "../components/file-viewer/codeSymbols";

describe("extractCodeSymbols", () => {
  it("extracts TS classes, functions, arrow consts, and skips control flow", () => {
    const symbols = extractCodeSymbols(
      "App.tsx",
      `export async function loadUser(id: number) {
  return id
}

class Store {
  async fetch() {}
  save(x: string) { return x }
  if (a) { return }
}

export interface Props { name: string }
export const useThing = (x: string) => x
`,
    );
    const names = symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("function:loadUser");
    expect(names).toContain("class:Store");
    expect(names).toContain("method:fetch");
    expect(names).toContain("method:save");
    expect(names).toContain("interface:Props");
    expect(names).toContain("function:useThing");
    expect(names.some((n) => n.includes(":if"))).toBe(false);
    // 行号应准确指向声明所在行
    const loadUser = symbols.find((s) => s.name === "loadUser");
    expect(loadUser?.line).toBe(1);
  });

  it("extracts Python defs and classes", () => {
    const symbols = extractCodeSymbols(
      "mod.py",
      `async def main():
    pass

class Service:
    def run(self):
        pass
`,
    );
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "function:main",
      "class:Service",
      "function:run",
    ]);
  });

  it("extracts Rust functions, structs, and traits", () => {
    const symbols = extractCodeSymbols(
      "lib.rs",
      `pub fn new(data: Vec<u8>) -> Self { data }
pub struct Config { pub port: u16 }
pub trait Runner { fn run(&self); }
`,
    );
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "function:new",
      "struct:Config",
      "trait:Runner",
    ]);
  });

  it("extracts Go functions including method receivers", () => {
    const symbols = extractCodeSymbols(
      "server.go",
      `func main() {}
func (s *Server) Handle() {}
`,
    );
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "function:main",
      "function:Handle",
    ]);
  });

  it("returns empty for unknown extensions or empty content", () => {
    expect(extractCodeSymbols("README.md", "# hi")).toEqual([]);
    expect(extractCodeSymbols("App.tsx", "// nothing here")).toEqual([]);
  });
});
