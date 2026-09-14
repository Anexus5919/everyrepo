import type { EngineDb } from "@everyrepo/db";
import type { ClusterSummary } from "./cluster-summary.ts";
import type { PageRef } from "./sources.ts";

type Sql = EngineDb["$client"];

export interface ReadingItem {
  path: string;
  role: string;
  url: string;
}

export interface SectionPage extends PageRef {
  title: string;
  purpose: string;
}

const MAX_ITEMS = 8;

export function fileLink(repo: string, sha: string, path: string): string {
  return `https://github.com/${repo}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// Planner picks first, then key files of the page's clusters, then its children's starting files, by importance
export function readingOrder(
  sql: Sql,
  page: PageRef,
  children: readonly PageRef[],
  clusterSummaries: ReadonlyMap<string, ClusterSummary>,
  link: (path: string) => string,
): ReadingItem[] {
  const roles = new Map<string, string>();
  const clusterKeys = [...page.clusters, ...children.flatMap((child) => child.clusters)];
  for (const key of clusterKeys) {
    const summary = clusterSummaries.get(key);
    for (const file of summary?.keyFiles ?? []) {
      if (!roles.has(file.path)) roles.set(file.path, file.role);
    }
  }
  const candidates = [
    ...page.files,
    ...page.clusters.flatMap(
      (key) => clusterSummaries.get(key)?.keyFiles.map((file) => file.path) ?? [],
    ),
    ...children.flatMap((child) => child.files.slice(0, 2)),
  ];
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return [];
  const rank = new Map(
    (
      sql
        .prepare(
          `SELECT path, pagerank FROM file WHERE path IN (${unique.map(() => "?").join(",")})`,
        )
        .all(...unique) as Array<{ path: string; pagerank: number | null }>
    ).map((row) => [row.path, row.pagerank ?? 0]),
  );
  const planned = new Set(page.files);
  return unique
    .filter((path) => rank.has(path))
    .sort((a, b) => {
      const pinned = Number(planned.has(b)) - Number(planned.has(a));
      return pinned !== 0 ? pinned : (rank.get(b) ?? 0) - (rank.get(a) ?? 0);
    })
    .slice(0, MAX_ITEMS)
    .map((path) => ({ path, role: roles.get(path) ?? "", url: link(path) }));
}

// A section page introduces its child pages from the plan and the graph; nothing here needs a model
export function sectionMarkdown(
  page: SectionPage,
  children: readonly SectionPage[],
  items: readonly ReadingItem[],
  diagram: string | undefined,
): string {
  const parts = [page.purpose];
  if (diagram) parts.push(`\`\`\`mermaid\n${diagram}\n\`\`\``);
  parts.push(
    "## In this section",
    children.map((child) => `- [${child.title}](${child.slug}.md): ${child.purpose}`).join("\n"),
  );
  if (items.length > 0) {
    parts.push(
      "## Where to start reading",
      items
        .map((item) => `- [\`${item.path}\`](${item.url})${item.role ? `: ${item.role}` : ""}`)
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}
