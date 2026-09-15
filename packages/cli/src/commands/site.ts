import { join } from "node:path";
import { markPublished } from "@everyrepo/requests";
import { Command } from "commander";
import { openContext } from "../context.ts";
import { exportSite } from "../site-export.ts";

export function siteCommand(): Command {
  return new Command("site")
    .description("Write the JSON the website is built from")
    .option("--out <dir>", "output folder, defaults to site in dataDir")
    .action(async (options: { out?: string }) => {
      const context = await openContext();
      try {
        const out = options.out ?? join(context.config.dataDir, "site");
        const result = await exportSite(context.appDb, context.config.dataDir, out);
        // The site data now describes these wikis, so status pages link to them
        const at = new Date();
        for (const wiki of result.ready) {
          if (wiki.publishedSha !== wiki.sha) {
            markPublished(context.appDb, wiki.repoId, wiki.sha, at);
          }
        }
        console.log(
          `Wrote ${result.listed.length} repositories (${result.ready.length} with wikis) to ${out}`,
        );
      } finally {
        context.close();
      }
    });
}
