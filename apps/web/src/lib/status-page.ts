import { formatRepoRef, readRepoInput, repoInputMessage } from "@everyrepo/core/repo-ref";
import type { RepoView } from "@everyrepo/core/requests";
import { ApiProblem, pollRepo, requestRepo, type Poller } from "./api.ts";
import { h, icon } from "./dom.ts";
import { formatCount, languageName, sourceFileCount } from "./format.ts";
import { showOneRequestNotice } from "./notice.ts";
import {
  estimateReasons,
  inAbout,
  milestones,
  pollDelay,
  primaryAction,
  readyTime,
  relativeTime,
  sizeName,
  statusCopy,
} from "./repo-status.ts";
import {
  getAccount,
  isSignInProblem,
  requestIntentPath,
  signInPage,
  type Account,
} from "./session.ts";
import { turnstileToken } from "./turnstile.ts";

function heading(view: RepoView, asked: string): HTMLElement {
  const [owner = "", name = ""] = view.repo.split("/");
  const github = view.github;
  const facts: HTMLElement[] = [];
  const fact = (...parts: Array<Node | string>) =>
    facts.push(h("span", { class: "fact" }, ...parts));
  if (github?.stars !== null && github?.stars !== undefined)
    fact(icon("star"), formatCount(github.stars));
  if (github?.language) fact(github.language);
  else if (view.estimate?.languages[0]) fact(languageName(view.estimate.languages[0].language));
  if (view.estimate) {
    fact(sizeName(view.estimate.sizeTier));
    fact(icon("files"), sourceFileCount(view.estimate.sourceFiles));
  }
  if (github?.archived) fact("Archived");
  if (github?.parent) fact(`Fork of ${github.parent}`);
  // A repository GitHub does not show publicly gets no link
  if (view.state !== "unavailable" || github) {
    facts.push(
      h(
        "a",
        {
          class: "fact github-link",
          href: github?.url ?? `https://github.com/${view.repo}`,
          target: "_blank",
          rel: "noopener",
        },
        icon("github"),
        "View on GitHub",
      ),
    );
  }
  const moved = asked.toLowerCase() !== view.repo.toLowerCase();
  return h(
    "header",
    { class: "status-head" },
    h("span", { class: "eyebrow" }, "Request status"),
    h("h1", { class: "status-title" }, h("span", { class: "owner" }, `${owner} / `), name),
    github?.description ? h("p", { class: "status-description" }, github.description) : null,
    moved
      ? h("p", { class: "status-moved" }, `${asked} now lives at ${view.repo} on GitHub.`)
      : null,
    facts.length > 0 ? h("div", { class: "status-facts" }, ...facts) : null,
  );
}

function progressBar(view: RepoView): HTMLElement | null {
  if (!view.progress || view.state === "ready") return null;
  const percent = Math.max(2, view.progress.percent);
  return h(
    "div",
    { class: "progress" },
    h(
      "div",
      {
        class: "progress-track",
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": view.progress.percent,
        "aria-label": "Share of the whole build",
      },
      h("span", { class: "progress-fill", style: `width: ${percent}%` }),
    ),
    h("span", { class: "progress-value mono" }, `${view.progress.percent}%`),
  );
}

const LABELS = {
  line: "Estimated ready",
  "if-requested": "If you request it now",
  "if-approved": "If it is approved now",
} as const;

// When the wiki should be ready, and what that time is made of
function estimatePanel(view: RepoView, now: number): HTMLElement | null {
  const eta = view.eta;
  if (!eta) return null;
  return h(
    "section",
    { class: "estimate", "aria-label": "Estimate" },
    h(
      "div",
      { class: "estimate-head" },
      h("span", { class: "estimate-label" }, LABELS[eta.basis]),
      h("strong", { class: "estimate-when" }, readyTime(eta.readyAt, now)),
      h("span", { class: "estimate-in" }, inAbout(eta.readyAt, now)),
    ),
    h(
      "ul",
      { class: "estimate-reasons" },
      ...estimateReasons(view, now).map((reason) => h("li", {}, reason)),
    ),
    h(
      "p",
      { class: "estimate-note" },
      "Estimates follow the free model allowances, the builds ahead and the size of the code, and they update as work finishes.",
    ),
  );
}

const WAITING_STATES = new Set(["queued", "building", "paused", "review"]);

function offlineBanner(view: RepoView, now: number): HTMLElement | null {
  if (view.builder.online || !WAITING_STATES.has(view.state)) return null;
  const seen = view.builder.lastSeenAt
    ? ` It was last seen ${relativeTime(view.builder.lastSeenAt, now)}.`
    : "";
  return h(
    "p",
    { class: "offline" },
    icon("clock"),
    `The builder is offline right now. Your place in line is kept, and building carries on when it is back.${seen}`,
  );
}

function details(view: RepoView, now: number): HTMLElement | null {
  const rows: Array<[string, string]> = [];
  if (view.requestedAt) rows.push(["First requested", relativeTime(view.requestedAt, now)]);
  if (view.requests > 0) {
    rows.push(["People asking", `${view.requests} ${view.requests === 1 ? "person" : "people"}`]);
  }
  if (view.queue) rows.push(["Place in line", `${view.queue.position} of ${view.queue.total}`]);
  if (view.resumeAt) rows.push(["Carries on", relativeTime(view.resumeAt, now)]);
  if (view.updatedAt) rows.push(["Last activity", relativeTime(view.updatedAt, now)]);
  if (rows.length === 0) return null;
  return h(
    "dl",
    { class: "status-details" },
    ...rows.map(([term, value]) => h("div", {}, h("dt", {}, term), h("dd", {}, value))),
  );
}

export function mountStatusPage(): void {
  const root = document.querySelector<HTMLElement>("[data-status-root]");
  const pick = document.querySelector<HTMLElement>("[data-status-pick]");
  const pickNote = document.querySelector<HTMLElement>("[data-status-pick-note]");
  const announce = document.querySelector<HTMLElement>("[data-status-announce]");
  if (!root || !pick) return;

  const params = new URLSearchParams(window.location.search);
  const raw = params.get("repo") ?? "";
  const parsed = readRepoInput(raw);
  if (!parsed.ok) {
    root.hidden = true;
    pick.hidden = false;
    if (raw && pickNote) pickNote.textContent = repoInputMessage(parsed.problem, parsed.owner);
    return;
  }

  let repo = formatRepoRef(parsed.ref);
  const asked = repo;
  let latest: RepoView | undefined;
  let problem: ApiProblem | undefined;
  let requesting = false;
  let copied = false;
  let account: Account | undefined;
  const received = params.get("new") === "1";
  // Set when someone chose to request this repository and was sent to sign in first
  let intent = params.get("intent") === "request";
  if (received || intent) {
    params.delete("new");
    params.delete("intent");
    history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  function actions(view: RepoView): HTMLElement {
    const action = primaryAction(view);
    const buttons: HTMLElement[] = [];
    if (view.state === "unavailable") {
      buttons.push(
        h(
          "button",
          { class: "btn btn-line", type: "button", "data-open-repo": true },
          "Try another repository",
        ),
      );
      return h("div", { class: "status-actions" }, ...buttons);
    }
    if (action.kind === "open" && view.href) {
      buttons.push(
        h("a", { class: "btn btn-solid", href: view.href }, action.label, icon("arrow")),
      );
    } else if (action.kind === "request" && account?.reachable && !account.user) {
      buttons.push(
        h(
          "a",
          { class: "btn btn-solid", href: signInPage(requestIntentPath(view.repo)) },
          icon("github"),
          "Sign in to request",
        ),
      );
    } else if (action.kind === "request") {
      const button = h(
        "button",
        { class: "btn btn-solid", type: "button", disabled: requesting },
        requesting ? "Requesting" : action.label,
      );
      button.addEventListener("click", () => void request(view));
      buttons.push(button);
    }
    const copy = h(
      "button",
      { class: "btn btn-line", type: "button" },
      copied ? "Link copied" : "Copy link",
    );
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(window.location.href).then(() => {
        copied = true;
        render();
        setTimeout(() => {
          copied = false;
          render();
        }, 2_000);
      });
    });
    buttons.push(copy);
    return h("div", { class: "status-actions" }, ...buttons);
  }

  const check = h("div", { class: "check" });

  async function request(view: RepoView) {
    requesting = true;
    render();
    try {
      const token = await turnstileToken(check);
      const result = await requestRepo(view.repo, token);
      latest = result.view;
      problem = undefined;
      poller?.refresh();
    } catch (error) {
      if (isSignInProblem(error)) {
        window.location.href = signInPage(requestIntentPath(view.repo));
      } else if (error instanceof ApiProblem && error.code === "one-at-a-time") {
        showOneRequestNotice(error.active, error.message);
      } else {
        problem =
          error instanceof ApiProblem
            ? error
            : new ApiProblem(error instanceof Error ? error.message : "Try again.", 0, "check");
      }
    } finally {
      requesting = false;
      render();
    }
  }

  function render() {
    const now = Date.now();
    if (!latest) {
      root!.replaceChildren(
        problem
          ? h(
              "div",
              { class: "status-card tone-attention" },
              h("h2", {}, "Could not load the status"),
              h("p", {}, problem.message),
            )
          : h(
              "div",
              { class: "status-loading" },
              h("span", { class: "spinner", "aria-hidden": "true" }),
              `Looking up ${repo}`,
            ),
      );
      return;
    }
    const view = latest;
    const copy = statusCopy(view, now, { withEta: false });
    const steps = milestones(view, now);
    const live = pollDelay(view) !== null;
    // Screen readers hear a change of state once, not every redraw
    if (announce && announce.textContent !== copy.title) announce.textContent = copy.title;
    const settled = view.state === "unavailable";
    const parts: Array<HTMLElement | null> = [
      heading(view, asked),
      received && view.state !== "available"
        ? h(
            "p",
            { class: "banner" },
            icon("check"),
            "Request received. This page follows the build by itself.",
          )
        : null,
      h(
        "section",
        { class: `status-card tone-${copy.tone}` },
        h(
          "div",
          { class: "status-top" },
          h("span", { class: "status-mark", "aria-hidden": "true" }),
          h("div", {}, h("h2", {}, copy.title), copy.detail ? h("p", {}, copy.detail) : null),
        ),
        offlineBanner(view, now),
        progressBar(view),
        problem ? h("p", { class: "status-problem" }, problem.message) : null,
        actions(view),
        primaryAction(view).kind === "request" && account?.reachable && !account.user
          ? h(
              "p",
              { class: "status-signin" },
              "Requests belong to a GitHub account, and each person has one request in progress at a time. Reading needs no account.",
            )
          : null,
        check,
      ),
      estimatePanel(view, now),
      settled
        ? null
        : h(
            "ol",
            { class: "steps" },
            ...steps.map((step) =>
              h(
                "li",
                { class: `step is-${step.state}` },
                h(
                  "span",
                  { class: "step-mark", "aria-hidden": "true" },
                  step.state === "done" ? icon("check") : null,
                ),
                h(
                  "span",
                  { class: "step-text" },
                  h("span", { class: "step-label" }, step.label),
                  step.note ? h("span", { class: "step-note" }, step.note) : null,
                ),
              ),
            ),
          ),
      details(view, now),
      settled
        ? null
        : h(
            "p",
            { class: `live ${live ? "is-live" : ""}` },
            h("span", { class: "live-dot", "aria-hidden": "true" }),
            live ? "Updates by itself" : view.state === "ready" ? "Finished" : "Up to date",
          ),
    ];
    root!.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
  }

  // Carries on with the request someone started before signing in, once both answers are in
  function continueIntent() {
    if (!intent || !latest || !account) return;
    if (!account.user || primaryAction(latest).kind !== "request") {
      intent = false;
      return;
    }
    intent = false;
    void request(latest);
  }

  let poller: Poller | undefined;
  const start = () => {
    poller?.stop();
    poller = pollRepo(
      repo,
      (view) => {
        latest = view;
        problem = undefined;
        // Renamed repositories and different letter case settle on GitHub's own name
        if (view.repo !== repo) {
          repo = view.repo;
          params.set("repo", repo);
          history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
        }
        document.title = `${view.repo}: request status, EveryRepo`;
        render();
        continueIntent();
      },
      (error) => {
        problem = error;
        render();
      },
      pollDelay,
    );
  };

  render();
  start();
  void getAccount().then((result) => {
    account = result;
    render();
    continueIntent();
  });
  // Times such as "5 minutes ago" stay true while the page is open
  setInterval(() => latest && render(), 30_000);
}
