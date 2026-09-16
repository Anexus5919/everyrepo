import type {
  AdminAccount,
  AdminActivity,
  AdminModel,
  AdminOverview,
  AdminPage,
  AdminPageText,
  AdminQueueItem,
  AdminRequest,
  AdminWiki,
} from "@everyrepo/core/admin";
import { formatRepoRef, readRepoInput, repoInputMessage } from "@everyrepo/core/repo-ref";
import type { RepoView } from "@everyrepo/core/requests";
import { ApiProblem, call, lookupRepo } from "./api.ts";
import { h } from "./dom.ts";
import { renderPreviewCard } from "./opener.ts";
import { relativeTime, statusHref } from "./repo-status.ts";
import { githubSignInUrl, signInPage } from "./session.ts";

type Tab = "status" | "queue" | "requests" | "add" | "wikis" | "accounts" | "activity";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "status", label: "Status" },
  { id: "queue", label: "Queue" },
  { id: "requests", label: "Requests" },
  { id: "add", label: "Add repositories" },
  { id: "wikis", label: "Wikis" },
  { id: "accounts", label: "Accounts" },
  { id: "activity", label: "Activity" },
];

// Tabs that change on their own are asked again while they are open
const LIVE_TABS: ReadonlySet<Tab> = new Set(["status", "queue", "activity"]);
const REFRESH_MS = 20_000;

const get = async <T>(path: string) => (await call<T>(path)).body as T;

// Changes carry a header only this page sends, which the API requires alongside the site origin
const post = async <T>(path: string, body: unknown) =>
  (
    await call<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-everyrepo-admin": "1" },
      body: JSON.stringify(body),
    })
  ).body as T;

const clock = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

const when = (iso: string | null) =>
  iso ? `${clock(iso)} (${relativeTime(iso, Date.now())})` : "";

function table(headers: string[], rows: HTMLElement[], empty: string): HTMLElement {
  if (rows.length === 0) return h("p", { class: "admin-empty" }, empty);
  return h(
    "div",
    { class: "admin-table-wrap" },
    h(
      "table",
      { class: "admin-table" },
      h("thead", {}, h("tr", {}, ...headers.map((label) => h("th", {}, label)))),
      h("tbody", {}, ...rows),
    ),
  );
}

const cell = (...children: Array<Node | string | null>) => h("td", {}, ...children);

const repoLink = (repo: string, href = statusHref(repo)) =>
  h("a", { class: "admin-repo", href }, repo);

function button(
  label: string,
  action: () => Promise<void> | void,
  tone: "plain" | "solid" | "danger" = "plain",
) {
  const element = h("button", { class: `admin-button is-${tone}`, type: "button" }, label);
  element.addEventListener("click", async () => {
    element.disabled = true;
    try {
      await action();
    } finally {
      element.disabled = false;
    }
  });
  return element;
}

function pill(text: string, tone: "good" | "warn" | "bad" | "quiet") {
  return h("span", { class: `admin-pill is-${tone}` }, text);
}

function modelState(model: AdminModel): HTMLElement {
  if (model.restingUntil) {
    return h(
      "span",
      {},
      pill("Resting", "bad"),
      ` until ${when(model.restingUntil)}`,
      // The provider's own explanation is long, so only its first part is shown
      model.restReason
        ? h("span", { class: "admin-note" }, model.restReason.split(" (")[0]!)
        : null,
    );
  }
  if (model.freesAt) return h("span", {}, pill("Used up", "warn"), ` frees ${when(model.freesAt)}`);
  return pill("Available", "good");
}

function meter(used: number, limit: number): HTMLElement {
  const share = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return h(
    "span",
    { class: "admin-meter" },
    h("span", { class: "admin-meter-bar" }, h("span", { style: `width: ${share}%` })),
    `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")}`,
  );
}

export function mountAdminPage(): void {
  const root = document.querySelector<HTMLElement>("[data-admin-root]");
  if (!root) return;
  const params = new URLSearchParams(window.location.search);
  let tab: Tab = (TABS.find((item) => item.id === params.get("tab"))?.id ?? "status") as Tab;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let overview: AdminOverview | undefined;
  const notice = h("p", { class: "admin-notice", role: "status", "aria-live": "polite" });
  const body = h("div", { class: "admin-body" });
  const tabs = h("nav", { class: "admin-tabs", "aria-label": "Admin sections" });
  const header = h("div", { class: "admin-top" });

  const say = (message: string, tone: "info" | "error" = "info") => {
    notice.textContent = message;
    notice.dataset.tone = tone;
  };

  // Changes run through here so a refusal shows its reason and the view refreshes afterwards
  async function act(message: string, work: () => Promise<unknown>) {
    try {
      await work();
      say(message);
      await render();
    } catch (error) {
      if (error instanceof ApiProblem && gate(error)) return;
      say(error instanceof Error ? error.message : "That did not work.", "error");
    }
  }

  // Answers that mean the person may not be here replace the whole page
  function gate(problem: ApiProblem): boolean {
    if (problem.status === 401 && problem.code === "reauth") {
      root!.replaceChildren(
        h(
          "section",
          { class: "admin-gate" },
          h("h1", {}, "Sign in again"),
          h(
            "p",
            {},
            "The dashboard needs a GitHub sign-in from the last 12 hours before it shows anything or makes changes.",
          ),
          h(
            "a",
            { class: "btn btn-solid", href: githubSignInUrl("/admin/") },
            "Sign in with GitHub",
          ),
        ),
      );
      return true;
    }
    if (problem.status === 401) {
      root!.replaceChildren(
        h(
          "section",
          { class: "admin-gate" },
          h("h1", {}, "Admin"),
          h("p", {}, "Sign in to continue."),
          h("a", { class: "btn btn-solid", href: signInPage("/admin/") }, "Sign in with GitHub"),
        ),
      );
      return true;
    }
    if (problem.status === 404 && problem.code === "not-found") {
      root!.replaceChildren(
        h(
          "section",
          { class: "admin-gate" },
          h("h1", {}, "Page not found"),
          h("p", {}, "There is nothing here."),
        ),
      );
      return true;
    }
    return false;
  }

  function renderHeader() {
    const builder = overview?.builder;
    const status = !builder
      ? pill("Checking", "quiet")
      : builder.paused
        ? pill("Builder paused", "warn")
        : builder.online
          ? pill("Builder online", "good")
          : pill("Builder offline", "bad");
    const toggle = builder
      ? button(
          builder.paused ? "Resume builder" : "Pause builder",
          () =>
            act(
              builder.paused
                ? "The builder takes new jobs again."
                : "The builder finishes its current job and then waits.",
              () => post("/api/admin/builder", { paused: !builder.paused }),
            ),
          builder.paused ? "solid" : "plain",
        )
      : null;
    header.replaceChildren(
      h(
        "div",
        {},
        h("span", { class: "eyebrow" }, "Admin"),
        h("h1", { class: "admin-title" }, "Dashboard"),
      ),
      h(
        "div",
        { class: "admin-top-actions" },
        status,
        toggle,
        button("Refresh", () => render()),
      ),
    );
  }

  function renderTabs() {
    tabs.replaceChildren(
      ...TABS.map((item) => {
        const link = h(
          "button",
          {
            class: "admin-tab",
            type: "button",
            "aria-current": item.id === tab ? "page" : undefined,
          },
          item.label,
        );
        link.addEventListener("click", () => {
          tab = item.id;
          params.set("tab", tab);
          history.replaceState(null, "", `/admin/?${params.toString()}`);
          say("");
          void render();
        });
        return link;
      }),
    );
  }

  async function statusView(): Promise<HTMLElement> {
    overview = await get<AdminOverview>("/api/admin/overview");
    renderHeader();
    const { counts, builder } = overview;
    const facts: Array<[string, number]> = [
      ["Published wikis", counts.publishedWikis],
      ["Building", counts.building],
      ["In line", counts.inLine],
      ["Waiting for allowance", counts.paused],
      ["Waiting for review", counts.inReview],
      ["Failed today", counts.failedLastDay],
      ["Accounts", counts.accounts],
    ];
    return h(
      "div",
      { class: "admin-stack" },
      h(
        "div",
        { class: "admin-facts" },
        ...facts.map(([label, value]) =>
          h("div", { class: "admin-fact" }, h("strong", {}, String(value)), h("span", {}, label)),
        ),
      ),
      h(
        "section",
        { class: "admin-card" },
        h("h2", {}, "Builder"),
        h(
          "p",
          {},
          builder.current
            ? `Working on ${builder.current.repo} (${builder.current.kind})${builder.current.progress ? `: ${builder.current.progress.label}, ${builder.current.progress.percent}%` : ""}.`
            : builder.online
              ? "Online and waiting for the next job."
              : `Offline${builder.lastSeenAt ? `, last seen ${relativeTime(builder.lastSeenAt, Date.now())}` : ""}. Start it with pnpm everyrepo worker --poll 60.`,
        ),
      ),
      h(
        "section",
        { class: "admin-card" },
        h("h2", {}, "Model allowances"),
        table(
          ["Model", "Used in the last day", "Tasks", "State"],
          overview.models.map((model) =>
            h(
              "tr",
              {},
              cell(h("strong", {}, model.id), h("span", { class: "admin-note" }, model.model)),
              cell(meter(model.usedLastDay, model.limitPerDay)),
              cell(model.tasks.join(", ")),
              cell(modelState(model)),
            ),
          ),
          "No models are configured.",
        ),
      ),
      h(
        "section",
        { class: "admin-card" },
        h("h2", {}, "Embeddings and GitHub"),
        table(
          ["Service", "Usage", "State"],
          [
            overview.embeddings
              ? h(
                  "tr",
                  {},
                  cell(`Embeddings (${overview.embeddings.provider}, neurons)`),
                  cell(meter(overview.embeddings.usedLastDay, overview.embeddings.budgetPerDay)),
                  cell(
                    overview.embeddings.freesAt
                      ? h(
                          "span",
                          {},
                          pill("Used up", "warn"),
                          ` frees ${when(overview.embeddings.freesAt)}`,
                        )
                      : pill("Available", "good"),
                  ),
                )
              : null,
            overview.github
              ? h(
                  "tr",
                  {},
                  cell(`GitHub API${overview.github.token ? "" : " (no token)"}`),
                  cell(
                    meter(
                      overview.github.core.limit - overview.github.core.remaining,
                      overview.github.core.limit,
                    ),
                  ),
                  cell(`resets ${when(overview.github.core.resetsAt)}`),
                )
              : h(
                  "tr",
                  {},
                  cell("GitHub API"),
                  cell("Could not be asked"),
                  cell(pill("Unknown", "quiet")),
                ),
            overview.github
              ? h(
                  "tr",
                  {},
                  cell("GitHub search"),
                  cell(
                    meter(
                      overview.github.search.limit - overview.github.search.remaining,
                      overview.github.search.limit,
                    ),
                  ),
                  cell(`resets ${when(overview.github.search.resetsAt)}`),
                )
              : null,
          ].filter((row): row is HTMLTableRowElement => row !== null),
          "",
        ),
      ),
    );
  }

  async function queueView(): Promise<HTMLElement> {
    const queue = await get<AdminQueueItem[]>("/api/admin/queue");
    const lane = (item: AdminQueueItem) =>
      item.published
        ? pill("Rewrite", "quiet")
        : item.asked
          ? pill(`Requested (${item.requests})`, "good")
          : pill("Added by you", "quiet");
    const move = (item: AdminQueueItem, direction: string, label: string) =>
      button(label, () =>
        act(
          `Moved ${item.repo} ${direction === "top" || direction === "bottom" ? `to the ${direction}` : direction}.`,
          () => post("/api/admin/queue/move", { jobId: item.jobId, direction }),
        ),
      );
    return h(
      "section",
      { class: "admin-card" },
      h("h2", {}, "Build line"),
      h(
        "p",
        { class: "admin-help" },
        "The worker takes builds from the top. Requests from people start above repositories you add, and rewrites of published wikis come last, unless you move them.",
      ),
      table(
        ["", "Repository", "Step", "State", "Lane", "Actions"],
        queue.map((item, index) =>
          h(
            "tr",
            {},
            cell(String(index + 1)),
            cell(
              repoLink(item.repo),
              item.error ? h("span", { class: "admin-note" }, item.error.slice(0, 180)) : null,
            ),
            cell(item.kind),
            cell(
              item.status === "running"
                ? h(
                    "span",
                    {},
                    pill("Running", "good"),
                    item.progress ? ` ${item.progress.label} ${item.progress.percent}%` : "",
                  )
                : item.runAfter && Date.parse(item.runAfter) > Date.now()
                  ? h("span", {}, pill("Waiting", "warn"), ` until ${clock(item.runAfter)}`)
                  : pill("Ready to start", "quiet"),
            ),
            cell(lane(item)),
            cell(
              item.status === "running"
                ? h("span", { class: "admin-note" }, "Running builds stay put")
                : h(
                    "span",
                    { class: "admin-actions" },
                    move(item, "top", "Top"),
                    move(item, "up", "Up"),
                    move(item, "down", "Down"),
                    move(item, "bottom", "Bottom"),
                    button(
                      "Cancel",
                      () => {
                        if (!window.confirm(`Cancel the ${item.kind} build of ${item.repo}?`))
                          return;
                        return act(`Cancelled ${item.repo}.`, () =>
                          post("/api/admin/queue/cancel", { jobId: item.jobId }),
                        );
                      },
                      "danger",
                    ),
                  ),
            ),
          ),
        ),
        "Nothing is building or waiting.",
      ),
    );
  }

  async function requestsView(): Promise<HTMLElement> {
    const requests = await get<AdminRequest[]>("/api/admin/requests");
    const review = requests.filter((request) => request.decision === "review");
    const row = (request: AdminRequest) =>
      h(
        "tr",
        {},
        cell(
          repoLink(request.repo),
          request.reason ? h("span", { class: "admin-note" }, `Reason: ${request.reason}`) : null,
        ),
        cell(request.state),
        cell(
          request.requesters.length > 0
            ? request.requesters.join(", ")
            : request.count > 0
              ? `${request.count} before accounts`
              : "Added by you",
        ),
        cell(
          request.sizeTier
            ? `${request.sizeTier}${request.sourceFiles !== null ? `, ${request.sourceFiles} source files` : ""}`
            : "",
        ),
        cell(when(request.firstAt)),
        cell(
          h(
            "span",
            { class: "admin-actions" },
            request.decision !== "approved"
              ? button(
                  "Approve",
                  () =>
                    act(`Approved ${request.repo}.`, () =>
                      post("/api/admin/requests/approve", { repo: request.repo }),
                    ),
                  "solid",
                )
              : null,
            request.decision !== "rejected" && request.state !== "ready"
              ? button(
                  "Decline",
                  () => {
                    if (!window.confirm(`Decline ${request.repo}? A waiting build is cancelled.`))
                      return;
                    return act(`Declined ${request.repo}.`, () =>
                      post("/api/admin/requests/decline", { repo: request.repo }),
                    );
                  },
                  "danger",
                )
              : null,
            request.state === "failed"
              ? button("Retry", () =>
                  act(`Queued ${request.repo} again.`, () =>
                    post("/api/admin/requests/retry", { repo: request.repo }),
                  ),
                )
              : null,
          ),
        ),
      );
    const headers = ["Repository", "State", "Asked by", "Size", "First asked", "Actions"];
    return h(
      "div",
      { class: "admin-stack" },
      h(
        "section",
        { class: "admin-card" },
        h("h2", {}, `Waiting for your review (${review.length})`),
        table(headers, review.map(row), "No request is waiting for review."),
      ),
      h(
        "section",
        { class: "admin-card" },
        h("h2", {}, `All requests (${requests.length})`),
        table(
          headers,
          requests.filter((request) => request.decision !== "review").map(row),
          "No requests yet.",
        ),
      ),
    );
  }

  function addView(): HTMLElement {
    const input = h("input", {
      class: "admin-input",
      type: "text",
      placeholder: "owner/name or a GitHub link",
      autocomplete: "off",
      spellcheck: "false",
    });
    const result = h("div", { class: "admin-stack" });
    const lookup = async () => {
      const read = readRepoInput(input.value);
      if (!read.ok) {
        say(repoInputMessage(read.problem, read.owner), "error");
        return;
      }
      const repo = formatRepoRef(read.ref);
      result.replaceChildren(h("p", { class: "admin-note" }, `Looking up ${repo} on GitHub`));
      let view: RepoView;
      try {
        view = await lookupRepo(repo);
      } catch (error) {
        result.replaceChildren(
          h(
            "p",
            { class: "admin-empty" },
            error instanceof Error ? error.message : "The lookup failed.",
          ),
        );
        return;
      }
      const canAdd =
        view.state === "available" || view.state === "review" || view.state === "rejected";
      result.replaceChildren(
        h("div", { class: "admin-preview" }, renderPreviewCard(view)),
        canAdd
          ? button(
              `Add ${view.repo} to the queue`,
              () =>
                act(`Added ${view.repo}. It waits behind requests from people.`, () =>
                  post("/api/admin/repos/add", { repo: view.repo }),
                ),
              "solid",
            )
          : h(
              "p",
              { class: "admin-note" },
              view.state === "unavailable"
                ? "This repository cannot have a wiki."
                : "This repository is already built or on its way.",
            ),
      );
    };
    const form = h(
      "form",
      { class: "admin-add" },
      input,
      h("button", { class: "admin-button is-solid", type: "submit" }, "Look up"),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void lookup();
    });
    return h(
      "section",
      { class: "admin-card" },
      h("h2", {}, "Add a repository"),
      h(
        "p",
        { class: "admin-help" },
        "Repositories you add wait behind every request from people. Large ones take days on the free models.",
      ),
      form,
      result,
    );
  }

  async function wikisView(): Promise<HTMLElement> {
    const wikis = await get<AdminWiki[]>("/api/admin/wikis");
    const detail = h("div", { class: "admin-stack" });
    const openPages = async (wiki: AdminWiki) => {
      const pages = await get<AdminPage[]>(
        `/api/admin/wikis/pages?repo=${encodeURIComponent(wiki.repo)}`,
      );
      const chosen = new Set<string>();
      const reader = h("div", {});
      const rows = pages.map((page) => {
        const box = h("input", { type: "checkbox", "aria-label": `Choose ${page.title}` });
        box.addEventListener("change", () =>
          box.checked ? chosen.add(page.slug) : chosen.delete(page.slug),
        );
        return h(
          "tr",
          {},
          cell(wiki.publishedAt ? box : null),
          cell(
            page.parentSlug ? `  ${page.title}` : page.title,
            h("span", { class: "admin-note" }, page.slug),
          ),
          cell(
            pill(
              page.status,
              page.status === "written" ? "good" : page.status === "planned" ? "quiet" : "bad",
            ),
          ),
          cell(String(page.words)),
          cell(String(page.citations)),
          cell(
            button("Read", async () => {
              const text = await get<AdminPageText>(
                `/api/admin/wikis/page?repo=${encodeURIComponent(wiki.repo)}&slug=${encodeURIComponent(page.slug)}`,
              );
              reader.replaceChildren(
                h(
                  "section",
                  { class: "admin-card" },
                  h("h3", {}, text.title),
                  h("p", { class: "admin-note" }, text.purpose),
                  h("pre", { class: "admin-markdown" }, text.markdown ?? "This page has no text."),
                  wiki.publishedAt
                    ? h(
                        "a",
                        {
                          class: "admin-repo",
                          href: `/${wiki.repo}/${page.slug}`,
                          target: "_blank",
                          rel: "noopener",
                        },
                        "Open on the site",
                      )
                    : null,
                ),
              );
              reader.scrollIntoView({ block: "start" });
            }),
          ),
        );
      });
      detail.replaceChildren(
        h(
          "section",
          { class: "admin-card" },
          h("h2", {}, `Pages of ${wiki.repo}`),
          table(
            ["", "Page", "Status", "Words", "Citations", ""],
            rows,
            "This wiki has no planned pages.",
          ),
          wiki.publishedAt
            ? h(
                "div",
                { class: "admin-actions" },
                button("Rewrite chosen pages", () => {
                  if (chosen.size === 0) {
                    say("Choose the pages to write again first.", "error");
                    return;
                  }
                  return act(
                    `Queued ${chosen.size} pages of ${wiki.repo} to be written again.`,
                    () => post("/api/admin/wikis/rewrite", { repo: wiki.repo, pages: [...chosen] }),
                  );
                }),
              )
            : null,
        ),
        reader,
      );
      detail.scrollIntoView({ block: "start" });
    };
    return h(
      "div",
      { class: "admin-stack" },
      h(
        "section",
        { class: "admin-card" },
        h("h2", {}, "Wikis"),
        table(
          ["Repository", "Published", "Pages", "Problems", "Building", "Actions"],
          wikis.map((wiki) =>
            h(
              "tr",
              {},
              cell(
                repoLink(wiki.repo, wiki.publishedAt ? `/${wiki.repo}` : statusHref(wiki.repo)),
                wiki.sizeTier ? h("span", { class: "admin-note" }, `Size ${wiki.sizeTier}`) : null,
              ),
              cell(wiki.publishedAt ? when(wiki.publishedAt) : pill("Not yet", "quiet")),
              cell(`${wiki.pages.written} of ${wiki.pages.total} written`),
              cell(
                wiki.pages.failed + wiki.pages.empty > 0
                  ? pill(`${wiki.pages.failed} failed, ${wiki.pages.empty} empty`, "warn")
                  : "",
              ),
              cell(wiki.openJob ?? ""),
              cell(
                h(
                  "span",
                  { class: "admin-actions" },
                  button("Pages", () => openPages(wiki)),
                  wiki.publishedAt && !wiki.openJob
                    ? button("Rewrite wiki", () => {
                        if (
                          !window.confirm(
                            `Write every page of ${wiki.repo} again? The published version stays until the new one is ready.`,
                          )
                        )
                          return;
                        return act(`Queued ${wiki.repo} to be written again.`, () =>
                          post("/api/admin/wikis/rewrite", { repo: wiki.repo }),
                        );
                      })
                    : null,
                ),
              ),
            ),
          ),
          "No repository has been read yet.",
        ),
      ),
      detail,
    );
  }

  async function accountsView(): Promise<HTMLElement> {
    const accounts = await get<AdminAccount[]>("/api/admin/accounts");
    return h(
      "section",
      { class: "admin-card" },
      h("h2", {}, `Accounts (${accounts.length})`),
      table(
        ["Account", "Email", "Joined", "Last seen", "Requests"],
        accounts.map((account) =>
          h(
            "tr",
            {},
            cell(
              h(
                "a",
                {
                  class: "admin-repo",
                  href: `https://github.com/${encodeURIComponent(account.login)}`,
                  target: "_blank",
                  rel: "noopener",
                },
                account.login,
              ),
              account.name ? h("span", { class: "admin-note" }, account.name) : null,
            ),
            cell(account.email ?? ""),
            cell(when(account.createdAt)),
            cell(when(account.lastSeenAt)),
            cell(String(account.requests)),
          ),
        ),
        "No one has signed in yet.",
      ),
    );
  }

  async function activityView(): Promise<HTMLElement> {
    const activity = await get<AdminActivity[]>("/api/admin/activity");
    return h(
      "section",
      { class: "admin-card" },
      h("h2", {}, "Activity"),
      table(
        ["When", "Who", "What", "Repository", "Detail"],
        activity.map((item) =>
          h(
            "tr",
            {},
            cell(when(item.at)),
            cell(item.who ?? "Builder"),
            cell(item.action),
            cell(item.target),
            cell(item.detail ? h("span", { class: "admin-note" }, item.detail.slice(0, 220)) : ""),
          ),
        ),
        "Nothing has happened yet.",
      ),
    );
  }

  const views: Record<Tab, () => Promise<HTMLElement> | HTMLElement> = {
    status: statusView,
    queue: queueView,
    requests: requestsView,
    add: addView,
    wikis: wikisView,
    accounts: accountsView,
    activity: activityView,
  };

  async function render() {
    clearTimeout(timer);
    renderTabs();
    try {
      if (!overview && tab !== "status") {
        overview = await get<AdminOverview>("/api/admin/overview");
        renderHeader();
      }
      const view = await views[tab]();
      if (!root!.contains(body)) root!.replaceChildren(header, tabs, notice, body);
      body.replaceChildren(view);
    } catch (error) {
      if (error instanceof ApiProblem && gate(error)) return;
      say(error instanceof Error ? error.message : "The dashboard could not load.", "error");
      if (!root!.contains(body)) root!.replaceChildren(header, tabs, notice, body);
    }
    if (LIVE_TABS.has(tab)) {
      timer = setTimeout(() => {
        if (!document.hidden && !document.querySelector(".admin-body :focus")) void render();
        else timer = setTimeout(() => void render(), REFRESH_MS);
      }, REFRESH_MS);
    }
  }

  renderHeader();
  void render();
}
