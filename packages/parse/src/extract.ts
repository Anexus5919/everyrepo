import type { Node } from "web-tree-sitter";
import { loadGrammar, type ParseableLanguage } from "./grammars.ts";

export interface DefinitionSymbol {
  name: string;
  kind: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  signature: string;
  doc?: string;
}

export interface ReferenceSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface ParseResult {
  definitions: DefinitionSymbol[];
  references: ReferenceSymbol[];
  hasErrors: boolean;
}

// When one node matches several patterns, the more specific kind wins
const KIND_PRIORITY = ["method", "class", "interface", "enum", "type", "module", "function"];
const WRAPPERS = new Set([
  "export_statement",
  "lexical_declaration",
  "variable_declaration",
  "decorated_definition",
  "ambient_declaration",
]);
const MAX_NAME_LENGTH = 200;
const MAX_SIGNATURE_LENGTH = 240;
const MAX_DOC_LENGTH = 400;

function rank(kind: string): number {
  const index = KIND_PRIORITY.indexOf(kind);
  return index < 0 ? KIND_PRIORITY.length : index;
}

// Climbs through export and declaration wrappers so modifiers and comments are found
function outermost(node: Node): Node {
  let current = node;
  while (current.parent && WRAPPERS.has(current.parent.type)) current = current.parent;
  return current;
}

function hasAncestor(node: Node, type: string, stop: Node): boolean {
  for (let current: Node | null = node; current; current = current.parent) {
    if (current.type === type) return true;
    if (current.equals(stop)) break;
  }
  return false;
}

function isExported(
  language: ParseableLanguage,
  definition: Node,
  anchor: Node,
  name: string,
): boolean {
  switch (language) {
    case "typescript":
    case "tsx":
    case "javascript":
      return hasAncestor(definition, "export_statement", anchor);
    case "java":
      return definition.namedChildren.some(
        (child) => child?.type === "modifiers" && /\bpublic\b/.test(child.text),
      );
    case "rust":
      return definition.namedChildren.some((child) => child?.type === "visibility_modifier");
    case "go":
      return /^[A-Z]/.test(name);
    case "python":
      return !name.startsWith("_");
  }
}

function cleanComment(text: string): string {
  return text
    .replace(/^\/\*\*?|\*\/$/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(\/\/[/!]?|\*|#)\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/^["']{3}|["']{3}$/g, "")
    .trim();
}

function leadingDoc(
  language: ParseableLanguage,
  definition: Node,
  anchor: Node,
): string | undefined {
  if (language === "python") {
    const first = definition.childForFieldName("body")?.namedChildren[0];
    const literal = first?.type === "expression_statement" ? first.namedChildren[0] : undefined;
    if (literal?.type === "string") return clip(cleanComment(literal.text));
  }
  const comments: string[] = [];
  let expectedRow = anchor.startPosition.row;
  for (let sibling = anchor.previousSibling; sibling; sibling = sibling.previousSibling) {
    if (!sibling.type.includes("comment") || sibling.endPosition.row < expectedRow - 1) break;
    comments.unshift(sibling.text);
    expectedRow = sibling.startPosition.row;
  }
  return comments.length > 0 ? clip(cleanComment(comments.join("\n"))) : undefined;
}

function clip(text: string): string | undefined {
  if (!text) return undefined;
  return text.length > MAX_DOC_LENGTH ? `${text.slice(0, MAX_DOC_LENGTH - 3)}...` : text;
}

function signatureOf(anchor: Node): string {
  const firstLine = anchor.text.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = firstLine.replace(/\s*\{\s*$/, "").trim();
  return trimmed.length > MAX_SIGNATURE_LENGTH
    ? `${trimmed.slice(0, MAX_SIGNATURE_LENGTH - 3)}...`
    : trimmed;
}

export async function parseSource(
  language: ParseableLanguage,
  source: string,
): Promise<ParseResult> {
  const grammar = await loadGrammar(language);
  const tree = grammar.parser.parse(source);
  if (!tree) throw new Error(`Parser returned no tree for ${language}`);
  try {
    const definitions = new Map<string, DefinitionSymbol>();
    const references: ReferenceSymbol[] = [];

    for (const match of grammar.query.matches(tree.rootNode)) {
      let role: "definition" | "reference" | undefined;
      let kind = "";
      let target: Node | undefined;
      let nameNode: Node | undefined;
      for (const capture of match.captures) {
        if (capture.name === "name") {
          nameNode = capture.node;
        } else if (capture.name.startsWith("definition.")) {
          role = "definition";
          kind = capture.name.slice("definition.".length);
          target = capture.node;
        } else if (capture.name.startsWith("reference.")) {
          role = "reference";
          kind = capture.name.slice("reference.".length);
          target = capture.node;
        }
      }
      const name = nameNode?.text;
      if (!role || !target || !nameNode || !name || name.length > MAX_NAME_LENGTH) continue;

      if (role === "reference") {
        references.push({ name, kind, line: nameNode.startPosition.row + 1 });
        continue;
      }

      const startLine = target.startPosition.row + 1;
      const key = `${name}:${startLine}`;
      const existing = definitions.get(key);
      if (existing && rank(existing.kind) <= rank(kind)) continue;

      const anchor = outermost(target);
      const doc = leadingDoc(language, target, anchor);
      definitions.set(key, {
        name,
        kind,
        exported: isExported(language, target, anchor, name),
        startLine,
        endLine: target.endPosition.row + 1,
        signature: signatureOf(anchor),
        ...(doc ? { doc } : {}),
      });
    }

    return {
      definitions: [...definitions.values()].sort((a, b) => a.startLine - b.startLine),
      references,
      hasErrors: tree.rootNode.hasError,
    };
  } finally {
    tree.delete();
  }
}
