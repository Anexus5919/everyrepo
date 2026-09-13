import { describe, expect, it } from "vitest";
import { parseSource, type ParseResult } from "./extract.ts";
import type { ParseableLanguage } from "./grammars.ts";

function defs(result: ParseResult) {
  return result.definitions.map(
    (symbol) => `${symbol.kind}:${symbol.name}:${symbol.exported ? "exported" : "local"}`,
  );
}

function refs(result: ParseResult) {
  return result.references.map((symbol) => symbol.name);
}

async function parse(language: ParseableLanguage, source: string) {
  return parseSource(language, source);
}

describe("parseSource", () => {
  it("extracts TypeScript definitions, exports, docs and calls", async () => {
    const result = await parse(
      "typescript",
      [
        "/**",
        " * Props for the grid.",
        " */",
        "export interface GridProps { rows: number }",
        "",
        "// Creates the grid API",
        "export function useGridApi(): void {",
        "  helper();",
        "}",
        "",
        "function helper() {}",
      ].join("\n"),
    );
    expect(defs(result)).toEqual([
      "interface:GridProps:exported",
      "function:useGridApi:exported",
      "function:helper:local",
    ]);
    expect(result.definitions[0]?.doc).toBe("Props for the grid.");
    expect(result.definitions[1]?.doc).toBe("Creates the grid API");
    expect(result.definitions[1]?.signature).toBe("export function useGridApi(): void");
    expect(refs(result)).toContain("helper");
    expect(result.hasErrors).toBe(false);
  });

  it("captures arrow function components and JSX calls in TSX", async () => {
    const result = await parse(
      "tsx",
      "export const Toolbar = () => <div onClick={() => refresh()} />;\nclass Local { render() { return null; } }",
    );
    expect(defs(result)).toEqual([
      "function:Toolbar:exported",
      "class:Local:local",
      "method:render:local",
    ]);
    expect(result.definitions[0]?.signature).toContain("export const Toolbar");
    expect(refs(result)).toContain("refresh");
  });

  it("reads JavaScript classes and methods", async () => {
    const result = await parse(
      "javascript",
      "class Logo { draw() { paint(); } }\nexport default Logo;",
    );
    expect(defs(result)).toEqual(["class:Logo:local", "method:draw:local"]);
    expect(refs(result)).toContain("paint");
  });

  it("marks public Java members as exported and keeps Javadoc", async () => {
    const result = await parse(
      "java",
      "package hudson;\n/** Entry point. */\npublic class Main {\n  public void run() { start(); }\n  private void start() {}\n}",
    );
    expect(defs(result)).toEqual([
      "class:Main:exported",
      "method:run:exported",
      "method:start:local",
    ]);
    expect(result.definitions[0]?.doc).toBe("Entry point.");
    expect(refs(result)).toContain("start");
  });

  it("prefers method over function for Rust impl items and reads pub visibility", async () => {
    const result = await parse(
      "rust",
      "/// Native bridge\npub fn init() { setup(); }\nstruct Store;\nimpl Store { pub fn open(&self) {} }",
    );
    expect(defs(result)).toEqual([
      "function:init:exported",
      "class:Store:local",
      "method:open:exported",
    ]);
    expect(result.definitions[0]?.doc).toBe("Native bridge");
  });

  it("uses docstrings and underscore privacy in Python", async () => {
    const result = await parse(
      "python",
      'class Turtle:\n    """Draws on the canvas."""\n    def _reset(self):\n        clear()\n\ndef main():\n    pass\n',
    );
    expect(defs(result)).toEqual([
      "class:Turtle:exported",
      "function:_reset:local",
      "function:main:exported",
    ]);
    expect(result.definitions[0]?.doc).toBe("Draws on the canvas.");
    expect(refs(result)).toContain("clear");
  });

  it("uses capitalization for Go exports", async () => {
    const result = await parse(
      "go",
      "package api\n// Serve starts the server\nfunc Serve() { listen() }\nfunc listen() {}\ntype Handler struct{}",
    );
    expect(defs(result)).toEqual([
      "function:Serve:exported",
      "function:listen:local",
      "type:Handler:exported",
    ]);
    expect(result.definitions[0]?.doc).toBe("Serve starts the server");
  });

  it("reports syntax errors without failing", async () => {
    const result = await parse("typescript", "export function broken( {");
    expect(result.hasErrors).toBe(true);
  });
});
