import { parseRepoRef, type RepoView } from "@everyrepo/core";
import { Command } from "commander";
import { openContext, openRequests, type CliContext } from "../context.ts";

function describe(view: RepoView): string {
  const parts = [
    view.repo.padEnd(40),
    view.state.padEnd(10),
    `${view.requests} ${view.requests === 1 ? "request " : "requests"}`,
    view.estimate ? `${view.estimate.sizeTier} ${view.estimate.sourceFiles} source files` : "",
    view.queue ? `position ${view.queue.position} of ${view.queue.total}` : "",
    view.progress ? `${view.progress.label} ${view.progress.percent}%` : "",
    view.resumeAt ? `resumes ${view.resumeAt}` : "",
    view.reason ? `(${view.reason.code})` : "",
  ];
  return parts.filter(Boolean).join("  ");
}

async function withService(
  action: (service: ReturnType<typeof openRequests>, context: CliContext) => Promise<void> | void,
): Promise<void> {
  const context = await openContext();
  try {
    await action(openRequests(context), context);
  } finally {
    context.close();
  }
}

export function requestsCommand(): Command {
  const requests = new Command("requests").description("Review repositories requested on the site");

  requests
    .command("list")
    .description("Show every request with its state")
    .action(() =>
      withService((service) => {
        const views = service.requests();
        if (views.length === 0) console.log("No requests yet");
        for (const view of views) console.log(describe(view));
      }),
    );

  requests
    .command("show")
    .description("Look a repository up the way the site does")
    .argument("<repo>", "owner/name or GitHub URL")
    .action((repo: string) =>
      withService(async (service) => {
        const view = await service.lookup(parseRepoRef(repo));
        console.log(describe(view));
        if (view.reason) console.log(view.reason.message);
      }),
    );

  requests
    .command("approve")
    .description("Approve a request, or add a repository nobody requested, and queue its build")
    .argument("<repo>", "owner/name or GitHub URL")
    .action((repo: string) =>
      withService(async (service) =>
        console.log(describe(await service.approve(parseRepoRef(repo)))),
      ),
    );

  requests
    .command("decline")
    .description("Decline a request; a queued build is cancelled")
    .argument("<repo>", "owner/name or GitHub URL")
    .action((repo: string) =>
      withService((service) => console.log(describe(service.decline(parseRepoRef(repo))))),
    );

  requests
    .command("retry")
    .description("Queue a failed build again")
    .argument("<repo>", "owner/name or GitHub URL")
    .action((repo: string) =>
      withService((service) => console.log(describe(service.retry(parseRepoRef(repo))))),
    );

  return requests;
}
