import type { Node } from "web-tree-sitter";
import { loadGrammar, type ParseableLanguage } from "./grammars.ts";

export type SyntaxNode = Node;

// Parses source and hands the root node to a callback; the tree is freed afterwards
export async function withSyntaxTree<T>(
  language: ParseableLanguage,
  source: string,
  use: (root: SyntaxNode) => T,
): Promise<T> {
  const grammar = await loadGrammar(language);
  const tree = grammar.parser.parse(source);
  if (!tree) throw new Error(`Parser returned no tree for ${language}`);
  try {
    return use(tree.rootNode);
  } finally {
    tree.delete();
  }
}
