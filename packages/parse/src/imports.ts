import type { Node, Query } from "web-tree-sitter";
import type { ParseableLanguage } from "./grammars.ts";

export type ImportKind =
  "import" | "export" | "require" | "dynamic" | "static" | "wildcard" | "from" | "mod" | "use";

export interface ImportRef {
  specifier: string;
  kind: ImportKind;
  line: number;
  // Names pulled in by `from x import a, b`, used to resolve submodule imports
  names?: string[];
}

export interface ImportExtraction {
  imports: ImportRef[];
  packageName?: string;
}

const lineOf = (node: Node) => node.startPosition.row + 1;

function pythonNames(node: Node): string[] {
  return node
    .childrenForFieldName("name")
    .map((child) => (child.type === "aliased_import" ? child.childForFieldName("name") : child))
    .filter((child): child is Node => child !== null)
    .map((child) => child.text);
}

// Reduces a use path such as crate::a::{b, c} or self::x::* to its module path
function rustUsePath(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/::\{.*$/, "")
    .replace(/::\*$/, "")
    .replace(/\sas\s.*$/, "");
}

export function extractImports(
  language: ParseableLanguage,
  query: Query,
  root: Node,
): ImportExtraction {
  const imports: ImportRef[] = [];
  let packageName: string | undefined;

  for (const match of query.matches(root)) {
    const byName = new Map(match.captures.map((capture) => [capture.name, capture.node]));
    switch (language) {
      case "javascript":
      case "typescript":
      case "tsx": {
        for (const kind of ["import", "export", "dynamic"] as const) {
          const node = byName.get(kind);
          if (node) imports.push({ specifier: node.text, kind, line: lineOf(node) });
        }
        const required = byName.get("require");
        if (required && byName.get("require.fn")?.text === "require") {
          imports.push({ specifier: required.text, kind: "require", line: lineOf(required) });
        }
        break;
      }
      case "java": {
        const pkg = byName.get("package");
        if (pkg) packageName = /package\s+([\w.]+)/.exec(pkg.text)?.[1];
        const node = byName.get("import");
        const parsed = node && /^import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/.exec(node.text);
        if (node && parsed?.[2]) {
          const kind = parsed[3] ? "wildcard" : parsed[1] ? "static" : "import";
          imports.push({ specifier: parsed[2], kind, line: lineOf(node) });
        }
        break;
      }
      case "python": {
        const plain = byName.get("import");
        if (plain) {
          for (const name of pythonNames(plain)) {
            imports.push({ specifier: name, kind: "import", line: lineOf(plain) });
          }
        }
        const from = byName.get("from");
        const module = from?.childForFieldName("module_name");
        if (from && module) {
          imports.push({
            specifier: module.text,
            kind: "from",
            line: lineOf(from),
            names: pythonNames(from),
          });
        }
        break;
      }
      case "go": {
        const pkg = byName.get("package");
        if (pkg) packageName = pkg.text;
        const node = byName.get("import");
        if (node) {
          imports.push({
            specifier: node.text.replace(/^["`]|["`]$/g, ""),
            kind: "import",
            line: lineOf(node),
          });
        }
        break;
      }
      case "rust": {
        const mod = byName.get("mod");
        const name = mod?.childForFieldName("name");
        // Inline modules have a body and do not refer to another file
        if (mod && name && !mod.childForFieldName("body")) {
          imports.push({ specifier: name.text, kind: "mod", line: lineOf(mod) });
        }
        const use = byName.get("use");
        if (use) imports.push({ specifier: rustUsePath(use.text), kind: "use", line: lineOf(use) });
        break;
      }
    }
  }

  return { imports, ...(packageName ? { packageName } : {}) };
}
