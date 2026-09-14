import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseRepoRef,
  repoDirName,
  testRepos,
  type SiteCitation,
  type SitePage,
  type SiteRepo,
  type SiteWiki,
} from "@everyrepo/core";
import { engineDbPath, findRepo, openEngineDb } from "@everyrepo/db";
import { Command } from "commander";
import { openContext } from "../context.ts";

const EXCERPT_LINES = 80;

interface Stats {
  kinds?: Record<string, number>;
  languages?: Array<{ language: string; files: number }>;
}

export function siteCommand(): Command {
  return new Command("site")
    .description("Write the JSON the website is built from")
    .option("--out <dir>", "output folder, defaults to site in dataDir")
    .action(async (options: { out?: string }) => {
      const context = await openContext();
      try {
        const out = options.out ?? join(context.config.dataDir, "site");
        await mkdir(out, { recursive: true });
        const listed: SiteRepo[] = [];
        for (const { repo: name } of testRepos) {
          const ref = parseRepoRef(name);
          const row = findRepo(context.appDb, ref);
          if (!row?.lastIndexedSha) continue;
          const wiki = readWiki(
            engineDbPath(context.config.dataDir, repoDirName(ref), row.lastIndexedSha),
            row.status === "indexing",
            row.lastIndexedAt?.getTime() ?? null,
          );
          const { overview, architecture, technologies, wikiPages, glossary, ...repo } = wiki;
          listed.push(repo);
          if (repo.status === "ready") {
            await writeFile(
              join(out, `${repoDirName(ref)}.json`),
              JSON.stringify({
                ...repo,
                overview,
                architecture,
                technologies,
                wikiPages,
                glossary,
              }),
            );
          }
        }
        await writeFile(join(out, "repos.json"), JSON.stringify(listed, null, 2));
        const ready = listed.filter((repo) => repo.status === "ready").length;
        console.log(`Wrote ${listed.length} repositories (${ready} with wikis) to ${out}`);
      } finally {
        context.close();
      }
    });
}

function readWiki(enginePath: string, indexing: boolean, indexedAt: number | null): SiteWiki {
  const sql = openEngineDb(enginePath).$client;
  try {
    const snapshot = sql
      .prepare("SELECT repo, ref, sha, size_tier AS sizeTier, stats FROM snapshot")
      .get() as { repo: string; ref: string; sha: string; sizeTier: string | null; stats: string };
    const stats = JSON.parse(snapshot.stats ?? "{}") as Stats;
    const [owner = "", name = ""] = snapshot.repo.split("/");
    const summaryRow = sql
      .prepare("SELECT content FROM summary WHERE level = 'repo' AND target = ''")
      .get() as { content: string } | undefined;
    const summary = summaryRow
      ? (JSON.parse(summaryRow.content) as {
          summary: string;
          overview: string;
          architecture: string;
          technologies: string[];
        })
      : undefined;
    const packages = (
      sql.prepare("SELECT COUNT(*) AS count FROM module WHERE path != ''").get() as {
        count: number;
      }
    ).count;
    const excerpt = sql.prepare("SELECT content FROM chunk WHERE id = ?");
    const rows = sql
      .prepare(
        `SELECT slug, parent_slug AS parentSlug, title, purpose, status, markdown, citations, model,
           reading_order AS readingOrder FROM wiki_page ORDER BY position`,
      )
      .all() as Array<{
      slug: string;
      parentSlug: string | null;
      title: string;
      purpose: string;
      status: string;
      markdown: string | null;
      citations: string | null;
      model: string | null;
      readingOrder: string | null;
    }>;
    const wikiPages: SitePage[] = rows.map((row) => ({
      slug: row.slug,
      parentSlug: row.parentSlug,
      title: row.title,
      purpose: row.purpose,
      status: row.status,
      section: row.model === "section",
      markdown: row.status === "written" ? row.markdown : null,
      readingOrder: row.readingOrder ? JSON.parse(row.readingOrder) : [],
      citations: (row.citations ? (JSON.parse(row.citations) as SiteCitation[]) : []).map(
        (citation: SiteCitation & { chunkId?: number }) => {
          const chunk = citation.chunkId
            ? (excerpt.get(citation.chunkId) as { content: string } | undefined)
            : undefined;
          return {
            number: citation.number,
            path: citation.path,
            startLine: citation.startLine,
            endLine: citation.endLine,
            url: citation.url,
            excerpt: (chunk?.content ?? "").split("\n").slice(0, EXCERPT_LINES).join("\n"),
          };
        },
      ),
    }));
    const glossary = (
      sql
        .prepare(
          "SELECT term, definition, citations FROM glossary_term ORDER BY term COLLATE NOCASE",
        )
        .all() as Array<{ term: string; definition: string; citations: string }>
    ).map((row) => {
      const [citation] = JSON.parse(row.citations) as Array<{ url: string; path: string }>;
      return {
        term: row.term,
        definition: row.definition,
        url: citation?.url ?? null,
        path: citation?.path ?? null,
      };
    });
    const written = wikiPages.filter((page) => page.status === "written").length;
    const kinds = stats.kinds ?? {};
    return {
      repo: snapshot.repo,
      owner,
      name,
      status: indexing ? "indexing" : written > 0 ? "ready" : "queued",
      sha: snapshot.sha,
      branch: snapshot.ref,
      sizeTier: snapshot.sizeTier,
      summary: summary?.summary ?? null,
      files: Object.values(kinds).reduce((total, count) => total + count, 0),
      sourceFiles: kinds.src ?? 0,
      packages,
      languages: (stats.languages ?? []).map(({ language, files }) => ({ language, files })),
      pages: written,
      indexedAt,
      overview: summary?.overview ?? "",
      architecture: summary?.architecture ?? "",
      technologies: summary?.technologies ?? [],
      wikiPages,
      glossary,
    };
  } finally {
    sql.close();
  }
}
