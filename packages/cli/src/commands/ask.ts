import { createServer } from "node:http";
import { Command } from "commander";
import { createAskHandler } from "../ask-server.ts";
import { openAskSession } from "../ask-session.ts";
import { openContext, timestamp } from "../context.ts";

export function askCommand(): Command {
  return new Command("ask")
    .description("Answer a question about a repository from its indexed code")
    .argument("<repo>", "owner/name or GitHub URL")
    .argument("<question...>", "the question")
    .action(async (repo: string, words: string[]) => {
      const context = await openContext();
      const session = await openAskSession(context);
      try {
        const started = Date.now();
        const answer = await session.ask(repo, words.join(" "), (event) => {
          if (event.type === "reading") {
            console.log(`${timestamp()} reading ${event.files.length} files`);
          }
        });
        if (answer.status === "not-found") {
          console.log("The indexed code did not answer this. These files came closest:");
          for (const file of answer.files) console.log(`  ${file.path}`);
        } else {
          console.log(`\n${answer.markdown}\n\nSources`);
          for (const source of answer.sources) {
            console.log(
              `  [${source.number}] ${source.path}#L${source.startLine}-L${source.endLine}`,
            );
          }
        }
        if (answer.pages.length > 0) {
          console.log("\nWiki pages");
          for (const page of answer.pages) console.log(`  ${page.title} (${page.slug})`);
        }
        const { written, kept, missingNames } = answer.checks;
        console.log(
          `\n${answer.model || "no model call"}, ${Date.now() - started} ms${answer.cached ? ", cached" : ""}, kept ${kept} of ${written} blocks`,
        );
        if (missingNames.length > 0) {
          console.log(`Names not found in the cited sources: ${missingNames.join(", ")}`);
        }
      } finally {
        session.close();
        context.close();
      }
    });
}

export function serveCommand(): Command {
  return new Command("serve")
    .description("Serve the Ask API on this machine for the website")
    .option("--port <n>", "port to listen on", "8787")
    .action(async (options: { port: string }) => {
      const context = await openContext();
      const session = await openAskSession(context);
      const handle = createAskHandler(session, {
        log: (message) => console.log(`${timestamp()} ${message}`),
      });
      const server = createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
          console.error(error);
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      const port = Number(options.port);
      server.listen(port, "127.0.0.1", () => {
        console.log(`Ask API listening on http://127.0.0.1:${port}`);
      });
      const stop = () => {
        server.close();
        session.close();
        context.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
}
