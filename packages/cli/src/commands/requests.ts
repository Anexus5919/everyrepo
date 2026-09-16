import { parseRepoRef, type RepoView } from "@everyrepo/core";
import { sql, users } from "@everyrepo/db";
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

  requests
    .command("rebuild")
    .description(
      "Write published wikis again behind every request, keeping them on the site until then",
    )
    .argument("<repos...>", "owner/name or GitHub URLs")
    .action((repos: string[]) =>
      withService((service) => {
        for (const repo of repos) console.log(describe(service.rebuild(parseRepoRef(repo))));
      }),
    );

  requests
    .command("assign")
    .description(
      "Link a request made before sign-in existed to the account of the person who made it",
    )
    .argument("<repo>", "owner/name or GitHub URL")
    .argument("<login>", "GitHub login of an account that has signed in on the site")
    .action((repo: string, login: string) =>
      withService((service, context) => {
        const user = context.appDb
          .select()
          .from(users)
          .where(sql`lower(${users.login}) = lower(${login})`)
          .get();
        if (!user)
          throw new Error(`No account for ${login}; they need to sign in on the site first`);
        console.log(describe(service.assign(parseRepoRef(repo), user.id)));
        console.log(`Linked to ${user.login}`);
      }),
    );

  return requests;
}
