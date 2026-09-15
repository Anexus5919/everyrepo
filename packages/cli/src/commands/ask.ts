import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pruneSessions } from "@everyrepo/accounts";
import { pruneRateLimits } from "@everyrepo/db";
import { Command } from "commander";
import { createAskHandler } from "../ask-server.ts";
import { openAskSession, type AskSession } from "../ask-session.ts";
import { openContext, openRequests, timestamp } from "../context.ts";
import {
  allowedOriginsFromEnv,
  applyCors,
  BodyTooLargeError,
  clientAddress,
  sendWebResponse,
  toWebRequest,
} from "../http.ts";
import { createAuthApi, isAuthRoute } from "../auth-api.ts";
import { createRequestApi, isRequestRoute, REQUEST_BODY_BYTES } from "../request-api.ts";

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

const DAY_MS = 86_400_000;

export function serveCommand(): Command {
  return new Command("serve")
    .description("Serve the Ask and repository request API on this machine for the website")
    .option("--port <n>", "port to listen on", "8787")
    .action(async (options: { port: string }) => {
      const context = await openContext();
      const log = (message: string) => console.log(`${timestamp()} ${message}`);
      const port = Number(options.port);
      const siteUrl = (process.env["EVERYREPO_SITE_URL"] ?? "http://127.0.0.1:4323").replace(
        /\/+$/,
        "",
      );
      const apiUrl = (process.env["EVERYREPO_API_URL"] ?? `http://127.0.0.1:${port}`).replace(
        /\/+$/,
        "",
      );
      const allowedOrigins = [...allowedOriginsFromEnv(), new URL(siteUrl).origin];

      // Ask needs embeddings and models; requests keep working without them
      let session: AskSession | undefined;
      try {
        session = await openAskSession(context);
      } catch (error) {
        log(`Ask is off: ${error instanceof Error ? error.message : String(error)}`);
      }
      const ask = session ? createAskHandler(session, { log, allowedOrigins }) : undefined;

      let secret = process.env["EVERYREPO_REQUEST_SECRET"];
      if (!secret) {
        secret = randomBytes(32).toString("hex");
        log(
          "EVERYREPO_REQUEST_SECRET is not set, so requesters are told apart only until a restart",
        );
      }
      const clientId = process.env["GITHUB_CLIENT_ID"];
      const clientSecret = process.env["GITHUB_CLIENT_SECRET"];
      if (!clientId || !clientSecret) {
        log("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set, so signing in is off");
      }
      const auth = createAuthApi({
        db: context.appDb,
        github: clientId && clientSecret ? { clientId, clientSecret } : undefined,
        siteUrl,
        apiUrl,
        allowedOrigins,
        log,
      });
      const turnstileSecret = process.env["TURNSTILE_SECRET_KEY"];
      const requests = createRequestApi({
        service: openRequests(context),
        db: context.appDb,
        secret,
        turnstile: turnstileSecret ? { secret: turnstileSecret } : undefined,
        userFor: (request) => auth.userFor(request),
        allowedOrigins,
        log,
      });

      const json = (response: ServerResponse, status: number, code: string, message: string) => {
        response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: { code, message } }));
      };

      async function handleRequests(request: IncomingMessage, response: ServerResponse) {
        applyCors(request, response, allowedOrigins);
        if (request.method === "OPTIONS") {
          response.writeHead(204).end();
          return;
        }
        let web: Request;
        try {
          web = await toWebRequest(request, REQUEST_BODY_BYTES);
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            json(response, 413, "too-large", error.message);
            return;
          }
          throw error;
        }
        const reply = isAuthRoute(new URL(web.url).pathname)
          ? await auth.handle(web)
          : await requests(web, clientAddress(request));
        if (reply) await sendWebResponse(response, reply);
        else json(response, 404, "not-found", "Not found");
      }

      async function handleAskOff(request: IncomingMessage, response: ServerResponse) {
        applyCors(request, response, allowedOrigins);
        if (request.method === "OPTIONS") response.writeHead(204).end();
        else json(response, 503, "ask-off", "Ask is not available on this server right now.");
      }

      const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const work =
          isRequestRoute(path) || isAuthRoute(path)
            ? handleRequests(request, response)
            : ask
              ? ask(request, response)
              : handleAskOff(request, response);
        work.catch((error: unknown) => {
          console.error(error);
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      const prune = setInterval(() => {
        pruneRateLimits(context.appDb, 2 * DAY_MS);
        pruneSessions(context.appDb);
      }, 3_600_000);
      prune.unref();
      server.listen(port, "127.0.0.1", () => {
        log(`API listening on http://127.0.0.1:${port}`);
      });
      const stop = () => {
        clearInterval(prune);
        server.close();
        session?.close();
        context.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
}
