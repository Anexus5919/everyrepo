import type { EngineDb } from "@everyrepo/db";
import type { ChatMessage, LlmRouter } from "@everyrepo/llm";
import type { VectorIndex } from "@everyrepo/search";
import { formatSources, githubLink, loadSummaries, verifyPage, type Source } from "@everyrepo/wiki";
import { retrieveSources, type RetrieveOptions } from "./retrieve.ts";

type Sql = EngineDb["$client"];

export const ASK_PROMPT_VERSION = "ask-1";
export const QUESTION_LIMITS = { min: 3, max: 300 };

export type AskEvent =
  { type: "searching" } | { type: "reading"; files: string[] } | { type: "writing" };

export interface AskSource {
  number: number;
  path: string;
  startLine: number;
  endLine: number;
  url: string;
  excerpt: string;
}

export interface AskPage {
  slug: string;
  title: string;
}

export interface AskAnswer {
  status: "answered" | "not-found";
  question: string;
  markdown: string;
  // Cited excerpts in the order their numbers appear
  sources: AskSource[];
  // Every file that was read for the answer
  files: Array<{ path: string; url: string }>;
  pages: AskPage[];
  model: string;
  cached: boolean;
  // Blocks the model wrote and blocks that survived the source checks
  checks: { written: number; kept: number; missingNames: string[] };
}

export interface AskInput {
  engine: EngineDb;
  index: VectorIndex;
  router: LlmRouter;
  embedQuery: (text: string) => Promise<Float32Array>;
  repo: string;
  sha: string;
  question: string;
  retrieve?: RetrieveOptions;
  onEvent?: (event: AskEvent) => void;
}

// The question itself is at fault, so callers can show the message as is
export class AskInputError extends Error {
  override readonly name = "AskInputError";
}

const MAX_ANSWER_TOKENS = 1_800;
const NOT_FOUND = /^\s*NOT_FOUND\b/;

const SYSTEM = [
  "You answer questions about a software repository for developers who are new to it.",
  "Use only the numbered sources. Every paragraph and every list item must end with citations such as [S2] or [S1, S3] that name the sources supporting it.",
  "Put names in backticks only when they appear exactly in the cited sources.",
  "If the sources do not show the answer, reply with exactly NOT_FOUND and nothing else.",
  "Write plain, specific English in short paragraphs without headings. Do not use long dashes, emoji or marketing words.",
].join(" ");

export function cleanQuestion(text: string): string {
  const question = text.replace(/\s+/g, " ").trim();
  if (question.length < QUESTION_LIMITS.min) throw new AskInputError("Write a longer question.");
  if (question.length > QUESTION_LIMITS.max) {
    throw new AskInputError(`Keep the question under ${QUESTION_LIMITS.max} characters.`);
  }
  return question;
}

export function askMessages(
  repo: string,
  summary: string | undefined,
  question: string,
  sources: readonly Source[],
): ChatMessage[] {
  const user = [
    `Repository: ${repo}.${summary ? ` ${summary}` : ""}`,
    "",
    "Numbered sources:",
    formatSources(sources),
    "",
    `Question: ${question}`,
    "",
    "Instructions:",
    "- Start with the direct answer in one or two sentences, then explain how it works in the code: which functions run, what they read or change, and in which order.",
    "- Keep it between 80 and 280 words.",
    "- Add a short code excerpt only when it makes the answer clearer, copied exactly from a source.",
    "- End every paragraph and list item with citations like [S3].",
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// Written wiki pages that cover the cited files first, then the files that were read
export function relatedPages(
  sql: Sql,
  cited: readonly string[],
  read: readonly string[],
  limit = 3,
): AskPage[] {
  const rows = sql
    .prepare("SELECT slug, title, files FROM wiki_page WHERE status = 'written' ORDER BY position")
    .all() as Array<{ slug: string; title: string; files: string }>;
  const citedSet = new Set(cited);
  const readSet = new Set(read);
  return rows
    .map((row, position) => {
      const files = JSON.parse(row.files) as string[];
      const score = files.reduce(
        (sum, path) => sum + (citedSet.has(path) ? 2 : readSet.has(path) ? 1 : 0),
        0,
      );
      return { slug: row.slug, title: row.title, score, position };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, limit)
    .map(({ slug, title }) => ({ slug, title }));
}

// Models sometimes write typographic hyphens inside names or cite right after a closing code fence
export function normalizeAnswer(text: string): string {
  return text
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/^([ \t]*```)[ \t]*\[S\d+(?:\s*,\s*S\d+)*\][ \t]*$/gm, "$1");
}

export function fileUrl(repo: string, sha: string, path: string): string {
  return `https://github.com/${repo}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export async function askQuestion(input: AskInput): Promise<AskAnswer> {
  const { engine, repo, sha } = input;
  const question = cleanQuestion(input.question);
  input.onEvent?.({ type: "searching" });
  const query = await input.embedQuery(question);
  const sources = retrieveSources(engine, input.index, question, query, input.retrieve);
  const paths = [...new Set(sources.map((source) => source.path))];
  input.onEvent?.({ type: "reading", files: paths });

  let checks: AskAnswer["checks"] = { written: 0, kept: 0, missingNames: [] };
  const notFound = (model: string, cached: boolean): AskAnswer => ({
    status: "not-found",
    question,
    markdown: "",
    sources: [],
    files: paths.map((path) => ({ path, url: fileUrl(repo, sha, path) })),
    pages: relatedPages(engine.$client, [], paths),
    model,
    cached,
    checks,
  });
  if (sources.length === 0) return notFound("", false);

  input.onEvent?.({ type: "writing" });
  const summary = [...loadSummaries<{ summary?: string }>(engine.$client, "repo").values()][0]
    ?.content.summary;
  const result = await input.router.complete(
    "ask",
    {
      messages: askMessages(repo, summary, question, sources),
      maxTokens: MAX_ANSWER_TOKENS,
      temperature: 0.2,
    },
    { promptVersion: ASK_PROMPT_VERSION },
  );
  if (NOT_FOUND.test(result.text)) return notFound(result.model, result.cached);

  const verified = verifyPage(
    normalizeAnswer(result.text),
    sources,
    (source) => githubLink(repo, sha, source),
    [repo, repo.split("/")[1] ?? repo],
  );
  checks = {
    written: verified.stats.blocks,
    kept: verified.stats.kept,
    missingNames: verified.stats.missingNames,
  };
  if (verified.stats.kept === 0) return notFound(result.model, result.cached);

  const byLabel = new Map(sources.map((source) => [source.label, source]));
  const cited = verified.citations.map((citation) => ({
    number: citation.number,
    path: citation.path,
    startLine: citation.startLine,
    endLine: citation.endLine,
    url: citation.url,
    excerpt: byLabel.get(citation.label)?.content ?? "",
  }));
  return {
    status: "answered",
    question,
    markdown: verified.markdown,
    sources: cited,
    files: paths.map((path) => ({ path, url: fileUrl(repo, sha, path) })),
    pages: relatedPages(
      engine.$client,
      cited.map((source) => source.path),
      paths,
    ),
    model: result.model,
    cached: result.cached,
    checks,
  };
}
