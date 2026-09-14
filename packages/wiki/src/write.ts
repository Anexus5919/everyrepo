import { openEngineDb, type EngineDb } from "@everyrepo/db";
import type { ChatMessage, LlmRouter } from "@everyrepo/llm";
import { hashInput } from "./cluster-context.ts";
import type { ClusterSummary } from "./cluster-summary.ts";
import { clusterDiagram, moduleDiagram } from "./diagrams.ts";
import type { RepoSummary } from "./repo-summary.ts";
import { candidateFiles, formatSources, selectSources, type Source } from "./sources.ts";
import { loadSummaries } from "./store.ts";
import { githubLink, verifyPage, type VerifyStats } from "./verify.ts";

type Sql = EngineDb["$client"];

export const PAGE_PROMPT_VERSION = "page-1";

interface PageRow {
  slug: string;
  parentSlug: string | null;
  title: string;
  purpose: string;
  clusters: string[];
  files: string[];
  status: string;
  inputHash: string | null;
}

export interface WriteInput {
  enginePath: string;
  router: LlmRouter;
  log: (message: string) => void;
  heartbeat: () => void;
  maxSourceChars?: number;
  // Limits the run to these page slugs
  only?: readonly string[];
}

export interface WriteOutput {
  pages: number;
  written: number;
  reused: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_SOURCE_CHARS = 40_000;
// A page keeps its text only if most of what the model wrote survived verification
const MIN_KEPT_SHARE = 0.5;

const SYSTEM = [
  "You write one page of a wiki that explains a software repository to developers who are new to it.",
  "Every paragraph and every list item must end with citations such as [S2] or [S1, S4] that name the numbered sources supporting it.",
  "State only facts that the cited sources show. Put names in backticks only when they appear exactly in the cited sources.",
  "Write plain, specific English. Do not use long dashes, emoji or marketing words.",
  "Reply with GitHub-flavored Markdown only.",
].join(" ");

function loadPages(sql: Sql): PageRow[] {
  return (
    sql
      .prepare(
        `SELECT slug, parent_slug AS parentSlug, title, purpose, clusters, files, status, input_hash AS inputHash
         FROM wiki_page ORDER BY position`,
      )
      .all() as Array<Omit<PageRow, "clusters" | "files"> & { clusters: string; files: string }>
  ).map((row) => ({
    ...row,
    clusters: JSON.parse(row.clusters) as string[],
    files: JSON.parse(row.files) as string[],
  }));
}

export function pageMessages(
  repo: string,
  repoSummary: RepoSummary,
  pages: readonly PageRow[],
  page: PageRow,
  clusterSummaries: ReadonlyMap<string, ClusterSummary>,
  sources: readonly Source[],
): ChatMessage[] {
  const parent = pages.find((other) => other.slug === page.parentSlug);
  const summaries = page.clusters
    .map((key) => clusterSummaries.get(key))
    .filter((summary): summary is ClusterSummary => summary !== undefined)
    .map((summary) => `- ${summary.title}: ${summary.purpose}`)
    .join("\n");
  const user = [
    `Repository: ${repo}. ${repoSummary.summary}`,
    `Other pages in this wiki: ${pages
      .filter((other) => other.slug !== page.slug)
      .map((other) => other.title)
      .join("; ")}`,
    "",
    `Write the page "${page.title}".`,
    `Purpose: ${page.purpose}`,
    parent ? `It sits under the page "${parent.title}".` : "",
    summaries ? `Descriptions of the code this page covers:\n${summaries}` : "",
    page.slug === "overview"
      ? `Repository overview: ${repoSummary.overview}\nArchitecture: ${repoSummary.architecture}`
      : "",
    "",
    "Numbered sources:",
    formatSources(sources),
    "",
    "Instructions:",
    "- Do not add a top-level title; start with 2 or 3 sentences on what this part is and why it matters.",
    "- Then use ## and ### sections that explain how it works, the main files and concepts, and how it connects to other pages.",
    "- Keep paragraphs short and prefer lists for steps and file roles. Aim for 350 to 900 words.",
    "- Short code excerpts are welcome when copied exactly from a source.",
    "- End every paragraph and list item with citations like [S3].",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

export async function writePages(input: WriteInput): Promise<WriteOutput> {
  const engine = openEngineDb(input.enginePath);
  const sql = engine.$client;
  try {
    const snapshot = sql.prepare("SELECT repo, sha FROM snapshot").get() as
      { repo: string; sha: string } | undefined;
    if (!snapshot) throw new Error("The engine database has no snapshot");
    const repoSummary = loadSummaries<RepoSummary>(sql, "repo").get("")?.content;
    if (!repoSummary) throw new Error("Run the summarize stage before writing pages");
    const clusterSummaries = new Map(
      [...loadSummaries<ClusterSummary>(sql, "cluster")].map(([key, row]) => [key, row.content]),
    );
    const pages = loadPages(sql);
    if (pages.length === 0) throw new Error("Run the plan stage before writing pages");
    const update = sql.prepare(
      `UPDATE wiki_page SET status = ?, markdown = ?, citations = ?, model = ?, input_hash = ?, updated_at = ?
       WHERE slug = ?`,
    );
    const output: WriteOutput = {
      pages: pages.length,
      written: 0,
      reused: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const link = (source: Source) => githubLink(snapshot.repo, snapshot.sha, source);

    for (const page of pages) {
      if (input.only && !input.only.includes(page.slug)) continue;
      const files = candidateFiles(sql, page, clusterSummaries);
      const sources = selectSources(sql, files, input.maxSourceChars ?? DEFAULT_SOURCE_CHARS);
      const messages = pageMessages(
        snapshot.repo,
        repoSummary,
        pages,
        page,
        clusterSummaries,
        sources,
      );
      const inputHash = hashInput(
        PAGE_PROMPT_VERSION,
        messages.map((message) => message.content).join("\n"),
      );
      if (page.status === "written" && page.inputHash === inputHash) {
        output.reused += 1;
        continue;
      }
      const result = await input.router.complete(
        "page",
        { messages, maxTokens: 4_000, temperature: 0.3 },
        { promptVersion: PAGE_PROMPT_VERSION },
      );
      output.inputTokens += result.inputTokens;
      output.outputTokens += result.outputTokens;
      const verified = verifyPage(result.text, sources, link);
      const diagram =
        page.slug === "overview" ? moduleDiagram(sql) : clusterDiagram(sql, page.clusters);
      const ok =
        verified.stats.kept >= 2 &&
        verified.stats.kept / Math.max(1, verified.stats.blocks) >= MIN_KEPT_SHARE;
      const markdown = diagram ? insertDiagram(verified.markdown, diagram) : verified.markdown;
      update.run(
        ok ? "written" : "failed",
        markdown,
        JSON.stringify(verified.citations),
        result.model,
        inputHash,
        Date.now(),
        page.slug,
      );
      if (ok) output.written += 1;
      else output.failed += 1;
      input.heartbeat();
      input.log(
        `${ok ? "wrote" : "failed"} ${page.slug}: ${describe(verified.stats)}, ${verified.citations.length} citations`,
      );
    }
    return output;
  } finally {
    sql.close();
  }
}

function describe(stats: VerifyStats): string {
  const missing =
    stats.missingNames.length > 0 ? `; missing: ${stats.missingNames.join(", ")}` : "";
  return `kept ${stats.kept}/${stats.blocks} blocks (uncited ${stats.uncited}, unknown names ${stats.unknownNames}, code not in sources ${stats.unmatchedCode})${missing}`;
}

// The diagram follows the opening paragraph so readers see the structure before the details
function insertDiagram(markdown: string, diagram: string): string {
  const blocks = markdown.split("\n\n");
  const firstHeading = blocks.findIndex((block) => /^#{2,6}\s/.test(block));
  const at = firstHeading === -1 ? blocks.length : firstHeading;
  blocks.splice(at, 0, `\`\`\`mermaid\n${diagram}\n\`\`\``);
  return blocks.join("\n\n");
}
