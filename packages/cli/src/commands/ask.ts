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
    .option("--page <slug>", "wiki page the question is asked from")
    .action(async (repo: string, words: string[], options: { page?: string }) => {
      const context = await openContext();
      const session = await openAskSession(context);
      try {
        const started = Date.now();
        const answer = await session.ask(
          { repo, question: words.join(" "), page: options.page ?? null },
          (event) => console.log(`${timestamp()} ${event.label}`),
        );
        console.log(`\nIntent: ${answer.intent}, ${answer.status}`);
        if (answer.issue) {
          console.log(`Issue #${answer.issue.number} ${answer.issue.title} ${answer.issue.url}`);
        }
        if (answer.note) console.log(answer.note);
        if (answer.markdown) {
          console.log(`\n${answer.markdown}\n\nSources`);
          for (const source of answer.sources) {
            const where =
              source.kind === "code"
                ? `${source.path}#L${source.startLine}-L${source.endLine}`
                : source.url;
            console.log(`  [${source.number}] ${source.kind} ${where}`);
          }
        } else if (answer.files.length > 0) {
          console.log("Files read:");
          for (const file of answer.files) console.log(`  ${file.path}`);
        }
        if (answer.otherIssues.length > 0) {
          console.log("\nOther issues");
          for (const issue of answer.otherIssues) console.log(`  #${issue.number} ${issue.title}`);
        }
        if (answer.pages.length > 0) {
          console.log("\nWiki pages");
          for (const page of answer.pages) console.log(`  ${page.title} (${page.slug})`);
        }
        const { written, kept, missingNames } = answer.checks;
        console.log(
          `\n${answer.model || "no answer model call"}, ${Date.now() - started} ms${answer.cached ? ", cached" : ""}, kept ${kept} of ${written} blocks`,
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
