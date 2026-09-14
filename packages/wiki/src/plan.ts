import { z } from "zod";
import { openEngineDb, type EngineDb } from "@everyrepo/db";
import type { ChatMessage, LlmRouter } from "@everyrepo/llm";
import { hashInput, listClusters } from "./cluster-context.ts";
import type { ClusterSummary } from "./cluster-summary.ts";
import { listModulesWithClusters } from "./module-summary.ts";
import type { RepoSummary } from "./repo-summary.ts";
import { loadSummaries } from "./store.ts";
import { plainText } from "./text.ts";

type Sql = EngineDb["$client"];

export const PLAN_PROMPT_VERSION = "plan-2";
const PLAN_CHECK_VERSION = "check-2";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PAGE_FILES = 10;

export const planSchema = z.object({
  pages: z
    .array(
      z.object({
        slug: z.string().min(2).max(60),
        title: z.string().min(2).max(80),
        parent: z.string().nullable(),
        purpose: z.string().min(10).max(500),
        clusters: z.array(z.string()).max(300),
        files: z.array(z.string()).max(40),
      }),
    )
    .min(2)
    .max(70),
});

export type PlanAnswer = z.infer<typeof planSchema>;

export interface PlannedPage {
  slug: string;
  parentSlug: string | null;
  position: number;
  title: string;
  purpose: string;
  clusters: string[];
  files: string[];
}

// Page counts that keep a wiki readable for the repository size
const PAGE_RANGE: Record<string, [number, number]> = {
  S: [4, 10],
  M: [8, 20],
  L: [18, 40],
  XL: [25, 50],
};

export interface RepoTopics {
  sizeTier: string;
  tests: number;
  locales: number;
  changelogs: number;
  ci: string[];
  contributing: string[];
  manifests: string[];
  docsSources: string[];
}

export function detectTopics(sql: Sql): RepoTopics {
  const snapshot = sql.prepare("SELECT size_tier AS sizeTier, stats FROM snapshot").get() as
    { sizeTier: string | null; stats: string | null } | undefined;
  const stats = snapshot?.stats ? (JSON.parse(snapshot.stats) as Record<string, unknown>) : {};
  const count = (kind: string) =>
    (sql.prepare("SELECT COUNT(*) AS n FROM file WHERE kind = ?").get(kind) as { n: number }).n;
  const paths = (where: string, limit = 6) =>
    (
      sql
        .prepare(`SELECT path FROM file WHERE ${where} ORDER BY length(path) LIMIT ${limit}`)
        .all() as Array<{
        path: string;
      }>
    ).map((row) => row.path);
  const docsSources = Array.isArray(stats["docsSources"])
    ? (stats["docsSources"] as Array<{ kind?: string; path?: string }>).map(
        (source) => `${source.kind ?? "docs"} at ${source.path ?? "?"}`,
      )
    : [];
  return {
    sizeTier: snapshot?.sizeTier ?? "M",
    tests: count("test"),
    locales: count("locale"),
    changelogs: count("changelog"),
    ci: paths(
      "path LIKE '.github/workflows/%' OR lower(path) IN ('jenkinsfile', '.gitlab-ci.yml', '.circleci/config.yml')",
    ),
    contributing: paths(
      "lower(path) LIKE '%contributing%' OR lower(path) LIKE '%developing%' OR lower(path) LIKE '%building%'",
    ),
    manifests: paths(
      "path IN ('package.json', 'pnpm-workspace.yaml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Makefile')",
    ),
    docsSources,
  };
}

export function buildPlanContext(
  sql: Sql,
  repo: string,
  repoSummary: RepoSummary,
  clusterSummaries: ReadonlyMap<string, ClusterSummary>,
  moduleSummaries: ReadonlyMap<string, ClusterSummary>,
  topics: RepoTopics,
): string {
  const clusters = listClusters(sql);
  const lines: string[] = [];
  for (const { module, clusters: moduleClusters } of listModulesWithClusters(sql)) {
    const moduleSummary = moduleSummaries.get(module.path);
    lines.push(
      `## Package ${module.path || "(root)"} [${module.name}]${moduleSummary ? `: ${moduleSummary.title}. ${moduleSummary.purpose}` : ""}`,
    );
    for (const { key } of moduleClusters) {
      const summary = clusterSummaries.get(key);
      const row = clusters.find((cluster) => cluster.key === key);
      if (!summary || !row) continue;
      const firstSentence = summary.purpose.split(/(?<=\.)\s/)[0] ?? summary.purpose;
      const files = summary.keyFiles
        .slice(0, 3)
        .map((file) => file.path)
        .join(", ");
      lines.push(
        `- cluster ${key} (${Math.round(row.tokenCount / 1000)}k tokens): ${summary.title}. ${firstSentence}${files ? ` Key files: ${files}` : ""}`,
      );
    }
  }
  const [low, high] = PAGE_RANGE[topics.sizeTier] ?? PAGE_RANGE["M"]!;
  return [
    `Repository: ${repo} (size tier ${topics.sizeTier})`,
    `Summary: ${repoSummary.summary}`,
    `Overview: ${repoSummary.overview}`,
    `Architecture: ${repoSummary.architecture}`,
    `Main areas: ${repoSummary.mainAreas.map((area) => `${area.title} (${area.modules.join(", ") || "various"})`).join("; ")}`,
    `Technologies: ${repoSummary.technologies.join(", ")}`,
    "",
    "Detected project facts:",
    `- test files: ${topics.tests}`,
    `- localization files: ${topics.locales}`,
    `- changelog files: ${topics.changelogs}`,
    topics.ci.length > 0
      ? `- CI configuration: ${topics.ci.join(", ")}`
      : "- no CI configuration found",
    topics.contributing.length > 0 ? `- contributor docs: ${topics.contributing.join(", ")}` : "",
    topics.manifests.length > 0 ? `- build manifests: ${topics.manifests.join(", ")}` : "",
    topics.docsSources.length > 0
      ? `- documentation sources: ${topics.docsSources.join(", ")}`
      : "",
    "",
    "Packages and their clusters of files:",
    ...lines,
    "",
    `Plan between ${low} and ${high} pages.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const SYSTEM = [
  "You plan the structure of a wiki that explains a software repository to new contributors.",
  "Group related clusters into pages that follow how the code is organized and how a newcomer learns it.",
  "Use only cluster keys and file paths that appear in the input.",
  "Write plain titles and purposes. Do not use long dashes, emoji or marketing words.",
  "Reply with a single JSON object and nothing else.",
].join(" ");

export function planMessages(context: string): ChatMessage[] {
  const user = [
    context,
    "",
    "Rules:",
    '- The first page has slug "overview" and no parent; it introduces the repository.',
    "- Add pages for architecture, each major package or feature area, and the detected facts that matter to contributors (for example build and tooling, testing, localization, documentation, CI and releases).",
    "- Use at most two levels: a page either has no parent or its parent has no parent.",
    "- Every cluster key should appear in exactly one page; small related clusters can share a page.",
    "- files lists up to 8 exact paths from the key files that a reader of the page should open first.",
    "",
    "Reply as JSON:",
    '{"pages": [{"slug": "kebab-case-id", "title": "Page title", "parent": null or "parent-slug",',
    '  "purpose": "1 or 2 sentences on what the page explains", "clusters": ["cluster keys"], "files": ["paths"]}]}',
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// Models sometimes copy the list wording, as in "cluster src#1" or a backticked key
export function normalizeClusterKey(key: string): string {
  return key
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^cluster\s+/i, "")
    .trim();
}

function toSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "page";
}

// Repairs a model plan: unique slugs, two levels, real clusters and files, every cluster placed
export function validatePlan(
  answer: PlanAnswer,
  clusterModules: ReadonlyMap<string, string>,
  knownFiles: ReadonlySet<string>,
): { pages: PlannedPage[]; unplaced: number; dropped: { clusters: number; files: number } } {
  const pages: PlannedPage[] = [];
  const slugs = new Map<string, string>();
  const dropped = { clusters: 0, files: 0 };
  const placed = new Set<string>();

  for (const page of answer.pages) {
    let slug = SLUG.test(page.slug) ? page.slug : toSlug(page.slug || page.title);
    for (let suffix = 2; [...slugs.values()].includes(slug); suffix += 1) {
      slug = `${toSlug(page.slug || page.title)}-${suffix}`;
    }
    slugs.set(page.slug, slug);
    const clusters = page.clusters.map(normalizeClusterKey).filter((key) => {
      const ok = clusterModules.has(key) && !placed.has(key);
      if (!ok) dropped.clusters += 1;
      else placed.add(key);
      return ok;
    });
    const files = [...new Set(page.files)]
      .filter((path) => {
        const ok = knownFiles.has(path);
        if (!ok) dropped.files += 1;
        return ok;
      })
      .slice(0, MAX_PAGE_FILES);
    pages.push({
      slug,
      parentSlug: page.parent,
      position: pages.length,
      title: plainText(page.title),
      purpose: plainText(page.purpose),
      clusters,
      files,
    });
  }

  if (!pages.some((page) => page.slug === "overview")) {
    pages.unshift({
      slug: "overview",
      parentSlug: null,
      position: -1,
      title: "Overview",
      purpose: "What the repository is, what it contains and where to start.",
      clusters: [],
      files: [],
    });
  }

  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  for (const page of pages) {
    const parent =
      page.parentSlug === null
        ? undefined
        : bySlug.get(slugs.get(page.parentSlug) ?? page.parentSlug);
    if (!parent || parent.slug === page.slug) {
      page.parentSlug = null;
    } else {
      // Flatten deeper trees to two levels
      page.parentSlug = parent.parentSlug === null ? parent.slug : parent.parentSlug;
    }
  }

  // Clusters the model left out join a page holding clusters of the same package, or a catch-all page
  let unplaced = 0;
  for (const [key, module] of clusterModules) {
    if (placed.has(key)) continue;
    unplaced += 1;
    const best = pages
      .filter((page) => page.slug !== "overview")
      .map((page) => ({
        page,
        score: page.clusters.filter((other) => clusterModules.get(other) === module).length,
      }))
      .sort((a, b) => b.score - a.score)[0];
    let home =
      best && best.score > 0 ? best.page : pages.find((page) => page.slug === "other-code");
    if (!home) {
      home = {
        slug: "other-code",
        parentSlug: null,
        position: pages.length,
        title: "Other parts of the code",
        purpose: "Smaller parts of the repository that do not belong to a larger area.",
        clusters: [],
        files: [],
      };
      pages.push(home);
    }
    home.clusters.push(key);
    placed.add(key);
  }

  pages.forEach((page, index) => {
    page.position = index;
  });
  return { pages, unplaced, dropped };
}

export interface PlanInput {
  enginePath: string;
  repo: string;
  router: LlmRouter;
  log: (message: string) => void;
}

export interface PlanOutput {
  pages: number;
  reused: boolean;
  unplacedClusters: number;
  droppedClusters: number;
  droppedFiles: number;
}

export async function planWiki(input: PlanInput): Promise<PlanOutput> {
  const engine = openEngineDb(input.enginePath);
  const sql = engine.$client;
  try {
    const repoSummary = loadSummaries<RepoSummary>(sql, "repo").get("")?.content;
    if (!repoSummary) throw new Error("Run the summarize stage before planning");
    const clusterSummaries = new Map(
      [...loadSummaries<ClusterSummary>(sql, "cluster")].map(([key, row]) => [key, row.content]),
    );
    const moduleSummaries = new Map(
      [...loadSummaries<ClusterSummary>(sql, "module")].map(([key, row]) => [key, row.content]),
    );
    const topics = detectTopics(sql);
    const context = buildPlanContext(
      sql,
      input.repo,
      repoSummary,
      clusterSummaries,
      moduleSummaries,
      topics,
    );
    // The check version is part of the hash so a better plan check replans from the cached answer
    const inputHash = hashInput(`${PLAN_PROMPT_VERSION}:${PLAN_CHECK_VERSION}`, context);
    const stored = sql.prepare("SELECT value FROM wiki_meta WHERE key = 'plan_hash'").get() as
      { value: string } | undefined;
    const existingPages = (
      sql.prepare("SELECT COUNT(*) AS n FROM wiki_page").get() as { n: number }
    ).n;
    if (existingPages > 0 && stored?.value === inputHash) {
      return {
        pages: existingPages,
        reused: true,
        unplacedClusters: 0,
        droppedClusters: 0,
        droppedFiles: 0,
      };
    }

    const messages = planMessages(context);
    const first = await input.router.completeJson(
      "plan",
      { messages, maxTokens: 16_000, temperature: 0.3 },
      planSchema,
      { promptVersion: PLAN_PROMPT_VERSION },
    );
    const clusterModules = new Map(
      listClusters(sql).map((cluster) => [cluster.key, cluster.moduleName] as const),
    );
    const knownFiles = new Set(
      (sql.prepare("SELECT path FROM file").all() as Array<{ path: string }>).map(
        (row) => row.path,
      ),
    );
    let plan = validatePlan(first.value, clusterModules, knownFiles);
    let result = first.result;

    // Plans that are too coarse for the repository get one request to split their largest pages
    const [low, high] = PAGE_RANGE[topics.sizeTier] ?? PAGE_RANGE["M"]!;
    if (plan.pages.length < low) {
      const largest = [...plan.pages]
        .sort((a, b) => b.clusters.length - a.clusters.length)
        .slice(0, 5)
        .map((page) => `${page.slug} (${page.clusters.length} clusters)`)
        .join(", ");
      const retry = await input.router.completeJson(
        "plan",
        {
          messages: [
            ...messages,
            { role: "assistant", content: JSON.stringify(first.value) },
            {
              role: "user",
              content: `This plan has ${plan.pages.length} pages, but a repository of this size needs between ${low} and ${high}. Split the pages that cover many clusters, such as ${largest}, into focused child pages whose parent is the original page, for example one child page per package or feature. Keep every cluster in exactly one page and reply with the complete corrected JSON.`,
            },
          ],
          maxTokens: 16_000,
          temperature: 0.3,
        },
        planSchema,
        { promptVersion: PLAN_PROMPT_VERSION },
      );
      const retried = validatePlan(retry.value, clusterModules, knownFiles);
      input.log(
        `plan had ${plan.pages.length} pages, the revised plan has ${retried.pages.length}`,
      );
      if (retried.pages.length > plan.pages.length) {
        plan = retried;
        result = retry.result;
      }
    }

    const insert = sql.prepare(
      `INSERT INTO wiki_page (slug, parent_slug, position, title, purpose, clusters, files, status, model, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
    );
    sql.transaction(() => {
      sql.prepare("DELETE FROM wiki_page").run();
      for (const page of plan.pages) {
        insert.run(
          page.slug,
          page.parentSlug,
          page.position,
          page.title,
          page.purpose,
          JSON.stringify(page.clusters),
          JSON.stringify(page.files),
          result.model,
          Date.now(),
        );
      }
      sql
        .prepare(
          "INSERT INTO wiki_meta (key, value) VALUES ('plan_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(inputHash);
    })();
    for (const page of plan.pages) {
      input.log(
        `${page.parentSlug ? "  " : ""}${page.slug}: ${page.title} (${page.clusters.length} clusters)`,
      );
    }
    return {
      pages: plan.pages.length,
      reused: false,
      unplacedClusters: plan.unplaced,
      droppedClusters: plan.dropped.clusters,
      droppedFiles: plan.dropped.files,
    };
  } finally {
    sql.close();
  }
}
