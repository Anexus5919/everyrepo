import { z } from "zod";
import { openEngineDb, type EngineDb } from "@everyrepo/db";
import type { ChatMessage, LlmRouter } from "@everyrepo/llm";
import type { ClusterSummary } from "./cluster-summary.ts";
import type { RepoSummary } from "./repo-summary.ts";
import { formatSources, type Source } from "./sources.ts";
import { loadSummaries } from "./store.ts";
import { plainText } from "./text.ts";
import { githubLink, isGroundedName } from "./verify.ts";

type Sql = EngineDb["$client"];

export const GLOSSARY_PROMPT_VERSION = "glossary-1";

const MAX_TERMS = 30;
const MAX_SOURCE_CHARS = 1_500;

export interface TermCandidate {
  term: string;
  weight: number;
  pages: string[];
}

export const glossarySchema = z.object({
  terms: z
    .array(z.object({ term: z.string().min(1).max(80), definition: z.string().min(10).max(600) }))
    .max(60),
});

// Concepts named by several cluster summaries, weighted by how much code they describe
export function collectTerms(
  sql: Sql,
  clusterSummaries: ReadonlyMap<string, ClusterSummary>,
  technologies: readonly string[],
): TermCandidate[] {
  const tokens = new Map(
    (
      sql.prepare("SELECT key, token_count AS tokens FROM cluster").all() as Array<{
        key: string;
        tokens: number;
      }>
    ).map((row) => [row.key, row.tokens]),
  );
  const pagesByCluster = new Map<string, string[]>();
  for (const row of sql.prepare("SELECT slug, clusters FROM wiki_page").all() as Array<{
    slug: string;
    clusters: string;
  }>) {
    for (const key of JSON.parse(row.clusters) as string[]) {
      pagesByCluster.set(key, [...(pagesByCluster.get(key) ?? []), row.slug]);
    }
  }
  const skip = new Set(technologies.map((name) => name.toLowerCase()));
  const terms = new Map<string, TermCandidate>();
  for (const [key, summary] of clusterSummaries) {
    for (const raw of summary.concepts) {
      const term = raw.replace(/\s+/g, " ").trim();
      const lower = term.toLowerCase();
      if (term.length < 2 || term.length > 40 || skip.has(lower)) continue;
      const entry = terms.get(lower) ?? { term, weight: 0, pages: [] };
      entry.weight += 1 + Math.log10(1 + (tokens.get(key) ?? 0) / 1000);
      entry.pages = [...new Set([...entry.pages, ...(pagesByCluster.get(key) ?? [])])];
      terms.set(lower, entry);
    }
  }
  return [...terms.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_TERMS);
}

interface ChunkMatch {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

// The code that defines a term: an exported symbol with that name, or else the best keyword match
export function groundTerm(sql: Sql, term: string): ChunkMatch | undefined {
  const symbol = sql
    .prepare(
      `SELECT c.id, f.path, c.start_line AS startLine, c.end_line AS endLine, c.content
       FROM symbol s JOIN file f ON f.id = s.file_id
       JOIN chunk c ON c.file_id = s.file_id AND c.start_line <= s.start_line AND c.end_line >= s.start_line
       WHERE s.name = ? COLLATE NOCASE AND f.kind IN ('src', 'types')
       ORDER BY s.exported DESC, f.pagerank DESC NULLS LAST LIMIT 1`,
    )
    .get(term.replace(/\s+/g, "")) as ChunkMatch | undefined;
  if (symbol) return symbol;
  const words = term.match(/[\p{L}\p{N}_]+/gu);
  if (!words) return undefined;
  const query = words.map((word) => `"${word.toLowerCase()}"`).join(" ");
  return sql
    .prepare(
      `SELECT c.id, f.path, c.start_line AS startLine, c.end_line AS endLine, c.content
       FROM chunk_fts JOIN chunk c ON c.id = chunk_fts.rowid JOIN file f ON f.id = c.file_id
       WHERE chunk_fts MATCH ? AND f.kind IN ('src', 'types', 'docs')
       ORDER BY bm25(chunk_fts, 2.0, 1.0, 3.0) LIMIT 1`,
    )
    .get(query) as ChunkMatch | undefined;
}

const SYSTEM = [
  "You write glossary entries for a wiki that explains a software repository to newcomers.",
  "Define each term in one or two plain sentences, using only what its numbered source shows, and end with that source's citation such as [S4].",
  "Put names in backticks only when the source contains them. Do not use long dashes, emoji or marketing words.",
  "Reply with a single JSON object and nothing else.",
].join(" ");

export function glossaryMessages(
  repo: string,
  repoSummary: RepoSummary,
  entries: ReadonlyArray<{ term: string; source: Source }>,
): ChatMessage[] {
  const user = [
    `Repository: ${repo}. ${repoSummary.summary}`,
    "",
    "Terms and the source to define each from:",
    ...entries.map((entry) => `- ${entry.term}: ${entry.source.label}`),
    "",
    "Numbered sources:",
    formatSources(entries.map((entry) => entry.source)),
    "",
    'Reply as JSON: {"terms": [{"term": "exact term from the list", "definition": "1 or 2 sentences ending with [S1]"}]}',
    "Leave out any term its source does not explain.",
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

export interface GlossaryInput {
  enginePath: string;
  router: LlmRouter;
  log: (message: string) => void;
}

export interface GlossaryOutput {
  candidates: number;
  grounded: number;
  kept: number;
}

export async function buildGlossary(input: GlossaryInput): Promise<GlossaryOutput> {
  const engine = openEngineDb(input.enginePath);
  const sql = engine.$client;
  try {
    const snapshot = sql.prepare("SELECT repo, sha FROM snapshot").get() as {
      repo: string;
      sha: string;
    };
    const repoSummary = loadSummaries<RepoSummary>(sql, "repo").get("")?.content;
    if (!repoSummary) throw new Error("Run the summarize stage before building the glossary");
    const clusterSummaries = new Map(
      [...loadSummaries<ClusterSummary>(sql, "cluster")].map(([key, row]) => [key, row.content]),
    );
    const candidates = collectTerms(sql, clusterSummaries, repoSummary.technologies);
    const entries: Array<{ term: string; pages: string[]; source: Source }> = [];
    let used = 0;
    for (const candidate of candidates) {
      const match = groundTerm(sql, candidate.term);
      if (!match) continue;
      const content = match.content.slice(0, MAX_SOURCE_CHARS);
      entries.push({
        term: candidate.term,
        pages: candidate.pages,
        source: {
          label: `S${entries.length + 1}`,
          chunkId: match.id,
          path: match.path,
          startLine: match.startLine,
          endLine: match.endLine,
          content,
        },
      });
      used += content.length;
    }
    if (entries.length === 0) return { candidates: candidates.length, grounded: 0, kept: 0 };

    const { value, result } = await input.router.completeJson(
      "summary",
      {
        messages: glossaryMessages(snapshot.repo, repoSummary, entries),
        maxTokens: 4_000,
        temperature: 0.2,
      },
      glossarySchema,
      { promptVersion: GLOSSARY_PROMPT_VERSION },
    );
    const byTerm = new Map(entries.map((entry) => [entry.term.toLowerCase(), entry]));
    const insert = sql.prepare(
      "INSERT INTO glossary_term (term, definition, citations, pages, model, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let kept = 0;
    sql.transaction(() => {
      sql.prepare("DELETE FROM glossary_term").run();
      for (const answer of value.terms) {
        const entry = byTerm.get(answer.term.trim().toLowerCase());
        if (!entry) continue;
        const cited = answer.definition.includes(`[${entry.source.label}]`);
        const names = [...answer.definition.matchAll(/`([^`\n]+)`/g)].map((match) =>
          match[1]!.trim(),
        );
        const grounded = names.every((name) =>
          isGroundedName(name, entry.source.content, [entry.source.path]),
        );
        if (!cited || !grounded) continue;
        const definition = plainText(answer.definition.replace(/\s*\[S\d+(?:\s*,\s*S\d+)*\]/g, ""));
        const citation = {
          path: entry.source.path,
          startLine: entry.source.startLine,
          endLine: entry.source.endLine,
          url: githubLink(snapshot.repo, snapshot.sha, entry.source),
        };
        insert.run(
          entry.term,
          definition,
          JSON.stringify([citation]),
          JSON.stringify(entry.pages),
          result.model,
          Date.now(),
        );
        kept += 1;
      }
    })();
    input.log(
      `glossary: ${kept} of ${entries.length} grounded terms kept (${used} source characters)`,
    );
    return { candidates: candidates.length, grounded: entries.length, kept };
  } finally {
    sql.close();
  }
}
