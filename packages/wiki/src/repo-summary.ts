import { z } from "zod";
import type { EngineDb } from "@everyrepo/db";
import type { ChatMessage } from "@everyrepo/llm";
import type { ClusterSummary } from "./cluster-summary.ts";
import type { ModuleRow } from "./module-summary.ts";
import { plainText } from "./text.ts";

type Sql = EngineDb["$client"];

export const REPO_PROMPT_VERSION = "repo-1";

export const repoSummarySchema = z.object({
  summary: z.string().min(10).max(300),
  overview: z.string().min(40).max(1_500),
  architecture: z.string().min(20).max(1_200),
  mainAreas: z
    .array(
      z.object({
        title: z.string().min(2).max(80),
        description: z.string().min(10).max(500),
        modules: z.array(z.string()).max(20),
      }),
    )
    .max(10),
  technologies: z.array(z.string().min(1).max(60)).max(15),
});

export type RepoSummary = z.infer<typeof repoSummarySchema>;

const README_CHARS = 12_000;

// Badges, images and raw HTML carry no meaning for a model and use up the budget
export function readableReadme(markdown: string): string {
  return markdown
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function readmeText(sql: Sql): string {
  const file = sql
    .prepare(
      "SELECT id FROM file WHERE lower(path) IN ('readme.md', 'readme.mdx', 'readme.rst', 'readme') ORDER BY length(path) LIMIT 1",
    )
    .get() as { id: number } | undefined;
  if (!file) return "";
  const chunks = sql
    .prepare("SELECT content FROM chunk WHERE file_id = ? ORDER BY start_line")
    .all(file.id) as Array<{ content: string }>;
  return readableReadme(chunks.map((chunk) => chunk.content).join("\n")).slice(0, README_CHARS);
}

export function buildRepoContext(
  sql: Sql,
  repo: string,
  modules: ReadonlyArray<{ module: ModuleRow; tokenCount: number }>,
  moduleSummaries: ReadonlyMap<string, ClusterSummary>,
  maxChars: number,
): string {
  const stats = sql.prepare("SELECT stats FROM snapshot").get() as
    { stats: string | null } | undefined;
  const parsed = stats?.stats ? (JSON.parse(stats.stats) as Record<string, unknown>) : {};
  const languages = Array.isArray(parsed["languages"])
    ? (parsed["languages"] as Array<{ language: string; share?: number }>)
        .slice(0, 8)
        .map((entry) => entry.language)
    : [];
  const lines: string[] = [];
  let used = 0;
  for (const { module, tokenCount } of [...modules].sort((a, b) => b.tokenCount - a.tokenCount)) {
    const summary = moduleSummaries.get(module.path);
    if (!summary) continue;
    const line = `- ${module.path || "(root)"} [${module.name}, ${Math.round(tokenCount / 1000)}k tokens]: ${summary.title}. ${summary.purpose}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  const readme = readmeText(sql);
  return [
    `Repository: ${repo}`,
    languages.length > 0 ? `Main languages: ${languages.join(", ")}` : "",
    "",
    "Packages, largest first:",
    lines.join("\n"),
    "",
    readme ? `README:\n${readme}` : "The repository has no README.",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}

const SYSTEM = [
  "You explain software repositories to developers who are about to read or contribute to them.",
  "Use only facts from the package descriptions and README you are given.",
  "Write plain, specific sentences. Do not use long dashes, emoji or marketing words.",
  "Reply with a single JSON object and nothing else.",
].join(" ");

export function repoSummaryMessages(context: string): ChatMessage[] {
  const user = [
    context,
    "",
    "Describe the repository as JSON with exactly these fields:",
    '{"summary": "one sentence on what the repository is",',
    ' "overview": "3 to 5 sentences on what it does and who it is for",',
    ' "architecture": "2 to 4 sentences on how the main packages fit together",',
    ' "mainAreas": [{"title": "area name", "description": "1 or 2 sentences", "modules": ["exact package paths from the list"]}],',
    ' "technologies": ["languages, frameworks and tools the code relies on"]}',
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

export function cleanRepoSummary(
  summary: RepoSummary,
  modulePaths: ReadonlySet<string>,
): RepoSummary {
  const normalize = (path: string) => (path === "(root)" ? "" : path);
  return {
    summary: plainText(summary.summary),
    overview: plainText(summary.overview),
    architecture: plainText(summary.architecture),
    mainAreas: summary.mainAreas.map((area) => ({
      title: plainText(area.title),
      description: plainText(area.description),
      modules: area.modules.map(normalize).filter((path) => modulePaths.has(path)),
    })),
    technologies: summary.technologies.map(plainText),
  };
}
