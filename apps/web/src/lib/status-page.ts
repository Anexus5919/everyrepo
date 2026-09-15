import { formatRepoRef, readRepoInput, repoInputMessage } from "@everyrepo/core/repo-ref";
import type { RepoView } from "@everyrepo/core/requests";
import { ApiProblem, pollRepo, requestRepo, type Poller } from "./api.ts";
import { h, icon } from "./dom.ts";
import { formatCount, languageName } from "./format.ts";
import {
  milestones,
  pollDelay,
  primaryAction,
  relativeTime,
  sizeName,
  statusCopy,
} from "./repo-status.ts";
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
    fact(icon("files"), `${formatCount(view.estimate.sourceFiles)} source files`);
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
  const received = params.get("new") === "1";
  if (received) {
    params.delete("new");
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
      problem =
        error instanceof ApiProblem
          ? error
          : new ApiProblem(error instanceof Error ? error.message : "Try again.", 0, "check");
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
    const copy = statusCopy(view, now);
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
        progressBar(view),
        problem ? h("p", { class: "status-problem" }, problem.message) : null,
        actions(view),
        check,
      ),
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
  // Times such as "5 minutes ago" stay true while the page is open
  setInterval(() => latest && render(), 30_000);
}
