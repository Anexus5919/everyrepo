import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser, Query } from "web-tree-sitter";

export const PARSEABLE_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "java",
  "rust",
  "python",
  "go",
] as const;
export type ParseableLanguage = (typeof PARSEABLE_LANGUAGES)[number];

interface GrammarSpec {
  pkg: string;
  wasm: string;
  // Tags queries are concatenated in order; TypeScript builds on the JavaScript queries
  queryPackages: string[];
}

const GRAMMARS: Record<ParseableLanguage, GrammarSpec> = {
  javascript: {
    pkg: "tree-sitter-javascript",
    wasm: "tree-sitter-javascript.wasm",
    queryPackages: ["tree-sitter-javascript"],
  },
  typescript: {
    pkg: "tree-sitter-typescript",
    wasm: "tree-sitter-typescript.wasm",
    queryPackages: ["tree-sitter-javascript", "tree-sitter-typescript"],
  },
  tsx: {
    pkg: "tree-sitter-typescript",
    wasm: "tree-sitter-tsx.wasm",
    queryPackages: ["tree-sitter-javascript", "tree-sitter-typescript"],
  },
  java: {
    pkg: "tree-sitter-java",
    wasm: "tree-sitter-java.wasm",
    queryPackages: ["tree-sitter-java"],
  },
  rust: {
    pkg: "tree-sitter-rust",
    wasm: "tree-sitter-rust.wasm",
    queryPackages: ["tree-sitter-rust"],
  },
  python: {
    pkg: "tree-sitter-python",
    wasm: "tree-sitter-python.wasm",
    queryPackages: ["tree-sitter-python"],
  },
  go: { pkg: "tree-sitter-go", wasm: "tree-sitter-go.wasm", queryPackages: ["tree-sitter-go"] },
};

export interface Grammar {
  language: Language;
  parser: Parser;
  query: Query;
}

const require = createRequire(import.meta.url);
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

let runtime: Promise<void> | undefined;
const grammars = new Map<ParseableLanguage, Promise<Grammar>>();

export function isParseable(language: string | undefined): language is ParseableLanguage {
  return (PARSEABLE_LANGUAGES as readonly string[]).includes(language ?? "");
}

export function loadGrammar(name: ParseableLanguage): Promise<Grammar> {
  let pending = grammars.get(name);
  if (!pending) {
    pending = (async () => {
      runtime ??= Parser.init();
      await runtime;
      const spec = GRAMMARS[name];
      const language = await Language.load(join(packageDir(spec.pkg), spec.wasm));
      const querySource = spec.queryPackages
        .map((pkg) => readFileSync(join(packageDir(pkg), "queries", "tags.scm"), "utf8"))
        .join("\n");
      const parser = new Parser();
      parser.setLanguage(language);
      return { language, parser, query: new Query(language, querySource) };
    })();
    grammars.set(name, pending);
  }
  return pending;
}
