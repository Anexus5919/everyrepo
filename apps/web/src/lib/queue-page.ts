import type { QueueView, RepoView } from "@everyrepo/core/requests";
import { pollQueue, type ApiProblem } from "./api.ts";
import { h, icon } from "./dom.ts";
import { formatCount } from "./format.ts";
import { relativeTime, shortReadyTime, sizeName, statusCopy, statusHref } from "./repo-status.ts";

const REVIEW_REASONS: Record<string, string> = {
  large: "Large repository",
  "daily-limit": "Past today's automatic approvals",
  "queue-full": "Asked while the queue was full",
};

function name(repo: string): HTMLElement {
  const [owner = "", rest = ""] = repo.split("/");
  return h("span", { class: "row-name" }, h("span", { class: "owner" }, `${owner} / `), rest);
}

function meta(view: RepoView): HTMLElement {
  const parts: string[] = [];
  if (view.estimate) {
    parts.push(
      sizeName(view.estimate.sizeTier),
      `${formatCount(view.estimate.sourceFiles)} source files`,
    );
  }
  if (view.requests > 0)
    parts.push(`${view.requests} ${view.requests === 1 ? "request" : "requests"}`);
  return h("span", { class: "row-meta" }, parts.join(", "));
}

function section(
  title: string,
  count: number,
  empty: string,
  body: HTMLElement | null,
): HTMLElement {
  return h(
    "section",
    { class: "queue-section" },
    h(
      "header",
      { class: "queue-section-head" },
      h("h2", {}, title),
      h("span", { class: "count mono" }, String(count)),
    ),
    count === 0 ? h("p", { class: "queue-empty" }, empty) : body,
  );
}

function building(views: RepoView[], now: number): HTMLElement {
  return h(
    "div",
    { class: "building" },
    ...views.map((view) => {
      const copy = statusCopy(view, now);
      const percent = view.progress?.percent ?? 0;
      return h(
        "a",
        { class: "build-card", href: statusHref(view.repo) },
        h(
          "span",
          { class: "build-top" },
          name(view.repo),
          h("span", { class: "build-percent mono" }, `${percent}%`),
        ),
        h(
          "span",
          { class: "build-stage" },
          h("span", { class: "live-dot", "aria-hidden": "true" }),
          copy.title,
        ),
        h(
          "span",
          { class: "build-track", "aria-hidden": "true" },
          h("span", { style: `width: ${Math.max(2, percent)}%` }),
        ),
        copy.detail ? h("span", { class: "build-detail" }, copy.detail) : null,
        view.eta
          ? h("span", { class: "build-eta" }, `Ready by ${shortReadyTime(view.eta.readyAt)}`)
          : null,
      );
    }),
  );
}

function rows(
  views: RepoView[],
  lead: (view: RepoView) => Node | string,
  side: (view: RepoView) => Node | string | null,
): HTMLElement {
  return h(
    "ol",
    { class: "queue-rows" },
    ...views.map((view) =>
      h(
        "li",
        {},
        h(
          "a",
          { class: "queue-row", href: view.href ?? statusHref(view.repo) },
          h("span", { class: "row-lead mono" }, lead(view)),
          h("span", { class: "row-main" }, name(view.repo), meta(view)),
          h("span", { class: "row-side" }, side(view)),
          icon("arrow"),
        ),
      ),
    ),
  );
}

export function mountQueuePage(): void {
  const root = document.querySelector<HTMLElement>("[data-queue-root]");
  const summary = document.querySelector<HTMLElement>("[data-queue-summary]");
  const offline = document.querySelector<HTMLElement>("[data-queue-offline]");
  if (!root || !summary || !offline) return;
  let latest: QueueView | undefined;
  let problem: ApiProblem | undefined;

  function render() {
    const now = Date.now();
    if (!latest) {
      summary!.textContent = problem ? problem.message : "Loading the queue";
      return;
    }
    const queue = latest;
    summary!.replaceChildren(
      h("span", { class: `live-dot ${problem ? "is-off" : ""}`, "aria-hidden": "true" }),
      problem
        ? problem.message
        : `${queue.building.length} being written, ${queue.waiting.length} in line, ${queue.review.length} waiting for approval. Updates by itself.`,
    );
    offline!.hidden =
      queue.builder.online || (queue.building.length === 0 && queue.waiting.length === 0);
    offline!.replaceChildren(
      icon("clock"),
      "The builder is offline right now. Every place in line is kept, and the estimates assume it starts again soon.",
    );
    root!.replaceChildren(
      section(
        "Being written now",
        queue.building.length,
        "Nothing is being written right now.",
        building(queue.building, now),
      ),
      section(
        "In line",
        queue.waiting.length,
        "The line is empty. A requested repository starts right away.",
        rows(
          queue.waiting,
          (view) => (view.queue ? String(view.queue.position) : icon("clock")),
          (view) => {
            const ready = view.eta ? `Ready by ${shortReadyTime(view.eta.readyAt)}` : null;
            return view.queue
              ? ready
              : [statusCopy(view, now).title, ready].filter(Boolean).join(". ");
          },
        ),
      ),
      section(
        "Waiting for approval",
        queue.review.length,
        "No request is waiting for approval.",
        rows(
          queue.review,
          () => "",
          (view) => REVIEW_REASONS[view.reason?.code ?? ""] ?? "Waiting",
        ),
      ),
      section(
        "Recently published",
        queue.recent.length,
        "No wiki was published in the last month.",
        rows(
          queue.recent,
          () => "",
          (view) => (view.updatedAt ? relativeTime(view.updatedAt, now) : ""),
        ),
      ),
    );
  }

  pollQueue(
    (queue) => {
      latest = queue;
      problem = undefined;
      render();
    },
    (error) => {
      problem = error;
      render();
    },
  );
  setInterval(() => latest && render(), 30_000);
}
