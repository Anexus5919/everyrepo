import type { EngineDb } from "@everyrepo/db";
import { loadSummaries } from "@everyrepo/wiki";

type Sql = EngineDb["$client"];

export interface WikiPageInfo {
  slug: string;
  parentSlug: string | null;
  title: string;
  purpose: string;
  files: string[];
  status: string;
  markdown: string | null;
}

export interface RepoKnowledge {
  summary?: string;
  overview?: string;
  architecture?: string;
  technologies: string[];
  mainAreas: Array<{ title: string; description: string }>;
  pages: WikiPageInfo[];
}

interface StoredRepoSummary {
  summary?: string;
  overview?: string;
  architecture?: string;
  technologies?: string[];
  mainAreas?: Array<{ title: string; description: string }>;
}

// What the wiki already knows about the repository, read from the engine database
export function loadKnowledge(sql: Sql): RepoKnowledge {
  const stored = [...loadSummaries<StoredRepoSummary>(sql, "repo").values()][0]?.content ?? {};
  const pages = (
    sql
      .prepare(
        `SELECT slug, parent_slug AS parentSlug, title, purpose, files, status, markdown
         FROM wiki_page ORDER BY position`,
      )
      .all() as Array<Omit<WikiPageInfo, "files"> & { files: string }>
  ).map((row) => ({ ...row, files: JSON.parse(row.files) as string[] }));
  return {
    ...(stored.summary ? { summary: stored.summary } : {}),
    ...(stored.overview ? { overview: stored.overview } : {}),
    ...(stored.architecture ? { architecture: stored.architecture } : {}),
    technologies: stored.technologies ?? [],
    mainAreas: stored.mainAreas ?? [],
    pages,
  };
}

// Page text without citation links or diagrams, so it can be quoted as a source
export function pageText(markdown: string, maxChars: number): string {
  const text = markdown
    .replace(/```mermaid[\s\S]*?```/g, "")
    .replace(/\[\[\d+\]\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars);
  return text.slice(0, cut > 0 ? cut : maxChars);
}

export function summaryText(knowledge: RepoKnowledge): string {
  const readable = knowledge.pages.filter((page) => page.status === "written");
  return [
    knowledge.summary,
    knowledge.overview,
    knowledge.architecture ? `Architecture: ${knowledge.architecture}` : "",
    knowledge.mainAreas.length > 0
      ? `Main areas:\n${knowledge.mainAreas.map((area) => `- ${area.title}: ${area.description}`).join("\n")}`
      : "",
    knowledge.technologies.length > 0 ? `Technologies: ${knowledge.technologies.join(", ")}` : "",
    readable.length > 0
      ? `Wiki pages:\n${readable.map((page) => `- ${page.title}: ${page.purpose}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
