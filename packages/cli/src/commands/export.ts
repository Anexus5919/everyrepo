import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatRepoRef, parseRepoRef, repoDirName } from "@everyrepo/core";
import { engineDbPath, findRepo, openEngineDb } from "@everyrepo/db";
import { Command } from "commander";
import { openContext } from "../context.ts";

interface PageRow {
  slug: string;
  parentSlug: string | null;
  title: string;
  purpose: string;
  status: string;
  markdown: string | null;
}

export function exportCommand(): Command {
  return new Command("export")
    .description("Write the generated wiki of a repository as Markdown files for review")
    .argument("<repo>", "owner/name or GitHub URL")
    .option("--out <dir>", "output folder, defaults to exports/<owner>__<repo> in dataDir")
    .action(async (repoArg: string, options: { out?: string }) => {
      const ref = parseRepoRef(repoArg);
      const context = await openContext();
      try {
        const repo = findRepo(context.appDb, ref);
        if (!repo?.lastIndexedSha)
          throw new Error(`${formatRepoRef(ref)} has not been indexed yet`);
        const engine = openEngineDb(
          engineDbPath(context.config.dataDir, repoDirName(ref), repo.lastIndexedSha),
        );
        const pages = engine.$client
          .prepare(
            "SELECT slug, parent_slug AS parentSlug, title, purpose, status, markdown FROM wiki_page ORDER BY position",
          )
          .all() as PageRow[];
        engine.$client.close();
        if (pages.length === 0) throw new Error("No wiki pages yet; run the wiki command first");

        const out = options.out ?? join(context.config.dataDir, "exports", repoDirName(ref));
        await mkdir(out, { recursive: true });
        const index = [`# ${formatRepoRef(ref)} wiki`, "", `Commit ${repo.lastIndexedSha}`, ""];
        for (const page of pages) {
          const indent = page.parentSlug ? "  " : "";
          const note = page.status === "written" ? "" : ` (${page.status})`;
          index.push(`${indent}- [${page.title}](${page.slug}.md)${note}: ${page.purpose}`);
          const body = page.markdown ?? "_Not written yet._";
          await writeFile(join(out, `${page.slug}.md`), `# ${page.title}\n\n${body}\n`);
        }
        await writeFile(join(out, "index.md"), `${index.join("\n")}\n`);
        console.log(`Wrote ${pages.length} pages to ${out}`);
      } finally {
        context.close();
      }
    });
}
