import { openEngineDb, type EngineDb } from "@everyrepo/db";
import type { ChatMessage, LlmRouter } from "@everyrepo/llm";
import { hashInput } from "./cluster-context.ts";
import type { ClusterSummary } from "./cluster-summary.ts";
import { clusterDiagram, moduleDiagram } from "./diagrams.ts";
import type { RepoSummary } from "./repo-summary.ts";
import { candidateFiles, formatSources, selectSources, type Source } from "./sources.ts";
import { fileLink, readingOrder, sectionMarkdown } from "./reading-order.ts";
import { loadSummaries } from "./store.ts";
import { githubLink, verifyPage, type VerifyStats } from "./verify.ts";

type Sql = EngineDb["$client"];

export const PAGE_PROMPT_VERSION = "page-2";

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
  "Explain how the code works: what calls what, how data and state move, and in which order things happen, the way a senior engineer would walk a new teammate through it.",
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
    pages.some((other) => other.parentSlug === page.slug)
      ? `Its child pages, which go into detail, are: ${pages
          .filter((other) => other.parentSlug === page.slug)
          .map((other) => `${other.title} (${other.purpose})`)
          .join("; ")}. Introduce them and how they relate instead of repeating their details.`
      : "",
    summaries ? `Descriptions of the code this page covers:\n${summaries}` : "",
    page.slug === "overview"
      ? `Repository overview: ${repoSummary.overview}\nArchitecture: ${repoSummary.architecture}`
      : "",
    "",
    "Numbered sources:",
    formatSources(sources),
    "",
    "Instructions:",
    "- Do not add a top-level title. Start with 2 or 3 sentences on what this part does for people using the software and why it exists.",
    "- Explain mechanisms rather than listing files: walk through how a typical operation moves through the code, which functions or hooks run, what state they read or change, and where the feature plugs into the rest of the system.",
    "- Name the key functions, classes, hooks or types and say what each one does and who calls it.",
    "- Write explanations as short paragraphs. Use lists only for ordered steps or for a brief table of file roles.",
    "- Include one or two short code excerpts copied exactly from the sources where they make a mechanism clearer.",
    "- Use ## and ### sections, and finish with a short section on how this part connects to other pages. Aim for 500 to 1,100 words.",
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
      `UPDATE wiki_page SET status = ?, markdown = ?, citations = ?, reading_order = ?, model = ?, input_hash = ?,
         updated_at = ? WHERE slug = ?`,
    );
    const setReadingOrder = sql.prepare("UPDATE wiki_page SET reading_order = ? WHERE slug = ?");
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
      const children = pages.filter((other) => other.parentSlug === page.slug);
      const items = readingOrder(sql, page, children, clusterSummaries, (path) =>
        fileLink(snapshot.repo, snapshot.sha, path),
      );
      const diagramClusters =
        page.clusters.length > 0 ? page.clusters : children.flatMap((child) => child.clusters);

      // Section pages that only group child pages are built from the plan and the graph
      if (children.length > 0 && page.clusters.length === 0 && page.slug !== "overview") {
        const markdown = sectionMarkdown(
          page,
          children,
          items,
          clusterDiagram(sql, diagramClusters),
        );
        const sectionHash = hashInput("section-1", markdown);
        if (page.status === "written" && page.inputHash === sectionHash) {
          output.reused += 1;
          continue;
        }
        update.run(
          "written",
          markdown,
          "[]",
          JSON.stringify(items),
          "section",
          sectionHash,
          Date.now(),
          page.slug,
        );
        output.written += 1;
        input.log(`built section ${page.slug} from ${children.length} child pages`);
        continue;
      }

      const files = candidateFiles(sql, page, clusterSummaries, children);
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
        setReadingOrder.run(JSON.stringify(items), page.slug);
        output.reused += 1;
        continue;
      }
      let result = await input.router.complete(
        "page",
        { messages, maxTokens: 4_000, temperature: 0.3 },
        { promptVersion: PAGE_PROMPT_VERSION },
      );
      output.inputTokens += result.inputTokens;
      output.outputTokens += result.outputTokens;
      let verified = verifyPage(result.text, sources, link);
      if (!passes(verified.stats)) {
        // One rewrite with the verifier's findings; the better of the two versions is kept
        const repair = await input.router.complete(
          "page",
          {
            messages: [
              ...messages,
              { role: "assistant", content: result.text },
              { role: "user", content: repairInstructions(verified.stats) },
            ],
            maxTokens: 4_000,
            temperature: 0.2,
          },
          { promptVersion: PAGE_PROMPT_VERSION },
        );
        output.inputTokens += repair.inputTokens;
        output.outputTokens += repair.outputTokens;
        const repaired = verifyPage(repair.text, sources, link);
        input.log(
          `rewrote ${page.slug} after verification: kept ${verified.stats.kept}, then ${repaired.stats.kept}`,
        );
        if (passes(repaired.stats) || repaired.stats.kept > verified.stats.kept) {
          verified = repaired;
          result = repair;
        }
      }
      const diagram =
        page.slug === "overview" ? moduleDiagram(sql) : clusterDiagram(sql, diagramClusters);
      const ok = passes(verified.stats);
      const markdown = diagram ? insertDiagram(verified.markdown, diagram) : verified.markdown;
      update.run(
        ok ? "written" : "failed",
        markdown,
        JSON.stringify(verified.citations),
        JSON.stringify(items),
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

function passes(stats: VerifyStats): boolean {
  return stats.kept >= 2 && stats.kept / Math.max(1, stats.blocks) >= MIN_KEPT_SHARE;
}

function repairInstructions(stats: VerifyStats): string {
  const problems = [
    stats.uncited > 0 ? `${stats.uncited} paragraphs or list items had no citation` : "",
    stats.unknownNames > 0
      ? `${stats.unknownNames} used names in backticks that their cited sources do not contain (${stats.missingNames.join(", ")})`
      : "",
    stats.unmatchedCode > 0
      ? `${stats.unmatchedCode} code blocks were not copied from a source`
      : "",
  ].filter(Boolean);
  return [
    `Your page was checked against the sources and these parts were removed: ${problems.join("; ")}.`,
    "Rewrite the whole page. End every paragraph and list item with citations like [S3] to the sources that support it,",
    "put names in backticks only when the cited source contains them, copy code excerpts exactly, and leave out anything the sources do not show.",
  ].join(" ");
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
