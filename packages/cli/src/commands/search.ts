import { formatRepoRef, parseRepoRef, repoDirName } from "@everyrepo/core";
import { engineDbPath, findRepo, openEngineDb } from "@everyrepo/db";
import { searchKeyword } from "@everyrepo/search";
import { Command } from "commander";
import { openContext } from "../context.ts";

export function searchCommand(): Command {
  return new Command("search")
    .description("Keyword search over the indexed chunks of a repository")
    .argument("<repo>", "owner/name or GitHub URL")
    .argument("<query...>", "words to search for")
    .option("--limit <n>", "number of results", "10")
    .action(async (repoArg: string, words: string[], options: { limit: string }) => {
      const ref = parseRepoRef(repoArg);
      const context = await openContext();
      try {
        const repo = findRepo(context.appDb, ref);
        if (!repo?.lastIndexedSha) {
          throw new Error(`${formatRepoRef(ref)} has not been indexed yet`);
        }
        const engine = openEngineDb(
          engineDbPath(context.config.dataDir, repoDirName(ref), repo.lastIndexedSha),
        );
        try {
          const hits = searchKeyword(engine, words.join(" "), Number(options.limit));
          if (hits.length === 0) console.log("No matches");
          for (const [index, hit] of hits.entries()) {
            console.log(
              `${String(index + 1).padStart(2)}. ${hit.path}#L${hit.startLine}-L${hit.endLine}  ${hit.score.toFixed(2)}`,
            );
            console.log(`    ${hit.header}`);
          }
        } finally {
          engine.$client.close();
        }
      } finally {
        context.close();
      }
    });
}
