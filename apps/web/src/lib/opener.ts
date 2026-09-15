import { formatRepoRef, readRepoInput, repoInputMessage } from "@everyrepo/core/repo-ref";
import type { RepoView } from "@everyrepo/core/requests";
import { ApiProblem, lookupRepo, requestRepo } from "./api.ts";
import { h, icon } from "./dom.ts";
import { formatCount, languageName } from "./format.ts";
import { primaryAction, sizeName, statusCopy, statusHref } from "./repo-status.ts";
import { prepareTurnstile, turnstileToken } from "./turnstile.ts";

export interface KnownWiki {
  repo: string;
  status: string;
  summary: string | null;
  pages: number;
}

export function readKnownWikis(): KnownWiki[] {
  try {
    return JSON.parse(document.getElementById("known-wikis")?.textContent ?? "[]") as KnownWiki[];
  } catch {
    return [];
  }
}

const LOOKUP_DELAY_MS = 350;
const SUGGESTIONS = 6;

type Preview =
  | { kind: "none" }
  | { kind: "checking"; repo: string }
  | { kind: "view"; view: RepoView; wiki?: KnownWiki | undefined }
  | { kind: "problem"; message: string };

function knownView(wiki: KnownWiki): RepoView {
  return {
    repo: wiki.repo,
    state: "ready",
    reason: null,
    github: null,
    estimate: null,
    queue: null,
    progress: null,
    requests: 0,
    requestedAt: null,
    updatedAt: null,
    resumeAt: null,
    href: `/${wiki.repo}`,
  };
}

function repoName(repo: string): HTMLElement {
  const [owner = "", name = ""] = repo.split("/");
  return h("span", { class: "repo-name" }, h("span", { class: "repo-owner" }, `${owner} / `), name);
}

function facts(view: RepoView, wiki: KnownWiki | undefined): HTMLElement | null {
  const items: Array<Node | string> = [];
  const add = (...parts: Array<Node | string>) =>
    items.push(h("span", { class: "fact" }, ...parts));
  if (view.github?.stars !== null && view.github?.stars !== undefined) {
    add(icon("star"), formatCount(view.github.stars));
  }
  if (view.github?.language) add(view.github.language);
  else if (view.estimate?.languages[0]) add(languageName(view.estimate.languages[0].language));
  if (view.estimate) {
    add(icon("files"), `${formatCount(view.estimate.sourceFiles)} source files`);
    add(sizeName(view.estimate.sizeTier));
  }
  if (wiki) add(`${wiki.pages} pages`);
  if (view.github?.archived) add("Archived");
  if (view.github?.parent) add(`Fork of ${view.github.parent}`);
  return items.length > 0 ? h("span", { class: "facts" }, ...items) : null;
}

// Starts a monogram from the owner's first letter, so previews need no images from elsewhere
function monogram(repo: string): HTMLElement {
  return h("span", { class: "monogram", "aria-hidden": "true" }, (repo[0] ?? "?").toUpperCase());
}

export function renderPreviewCard(view: RepoView, wiki?: KnownWiki): HTMLElement {
  const copy = statusCopy(view, Date.now());
  const description = wiki?.summary ?? view.github?.description ?? null;
  return h(
    "div",
    { class: `preview-card tone-${copy.tone}` },
    monogram(view.repo),
    h(
      "span",
      { class: "preview-main" },
      repoName(view.repo),
      description ? h("span", { class: "preview-description" }, description) : null,
      facts(view, wiki),
      h(
        "span",
        { class: "preview-status" },
        h("span", { class: "status-mark", "aria-hidden": "true" }),
        h("strong", {}, copy.title),
        copy.detail ? h("span", { class: "status-detail" }, copy.detail) : null,
      ),
    ),
  );
}

export function mountOpener(form: HTMLFormElement, known: readonly KnownWiki[]): void {
  if (form.dataset.mounted) return;
  form.dataset.mounted = "true";
  const input = form.querySelector<HTMLInputElement>("[data-opener-input]")!;
  const field = form.querySelector<HTMLElement>("[data-opener-field]")!;
  const list = form.querySelector<HTMLUListElement>("[data-opener-list]")!;
  const listWrap = form.querySelector<HTMLElement>("[data-opener-suggestions]")!;
  const preview = form.querySelector<HTMLElement>("[data-opener-preview]")!;
  const note = form.querySelector<HTMLElement>("[data-opener-note]")!;
  const submit = form.querySelector<HTMLButtonElement>("[data-opener-submit]")!;
  const label = form.querySelector<HTMLElement>("[data-opener-label]")!;
  const clear = form.querySelector<HTMLButtonElement>("[data-opener-clear]")!;
  const check = form.querySelector<HTMLElement>("[data-opener-check]")!;
  const defaultLabel = label.textContent ?? "Open";

  const ready = known.filter((wiki) => wiki.status === "ready");
  const byKey = new Map(known.map((wiki) => [wiki.repo.toLowerCase(), wiki]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lookup: AbortController | undefined;
  let current: { key: string; view: RepoView } | undefined;
  let shown: KnownWiki[] = [];
  let active = -1;
  let busy = false;

  const typedRef = () => {
    const parsed = readRepoInput(input.value);
    return parsed.ok ? formatRepoRef(parsed.ref) : undefined;
  };

  function setNote(message: string, tone: "error" | "info" = "error") {
    note.textContent = message;
    note.dataset.tone = tone;
    field.classList.toggle("is-invalid", tone === "error" && message !== "");
  }

  function updateLabel() {
    if (busy) return;
    const action = current ? primaryAction(current.view) : undefined;
    label.textContent =
      !action || action.kind === "none"
        ? defaultLabel
        : action.kind === "request"
          ? current!.view.reason
            ? "Ask for approval"
            : "Request the wiki"
          : action.kind === "follow"
            ? "See progress"
            : "Open the wiki";
  }

  function renderPreview(state: Preview) {
    preview.hidden = state.kind === "none";
    preview.dataset.kind = state.kind;
    if (state.kind === "none") {
      preview.replaceChildren();
    } else if (state.kind === "checking") {
      preview.replaceChildren(
        h(
          "div",
          { class: "preview-card is-checking" },
          h("span", { class: "spinner", "aria-hidden": "true" }),
          h("span", { class: "preview-main" }, "Looking up ", repoName(state.repo), " on GitHub"),
        ),
      );
    } else if (state.kind === "problem") {
      preview.replaceChildren(
        h(
          "div",
          { class: "preview-card tone-attention" },
          h("span", { class: "preview-icon" }, icon("alert")),
          h("span", { class: "preview-main" }, state.message),
        ),
      );
    } else {
      preview.replaceChildren(renderPreviewCard(state.view, state.wiki));
    }
    field.classList.toggle("is-match", state.kind === "view" && state.view.state === "ready");
  }

  function renderList(open: boolean) {
    const text = input.value.trim().toLowerCase();
    const typed = typedRef()?.toLowerCase();
    shown =
      !open || (typed !== undefined && byKey.get(typed)?.status === "ready")
        ? []
        : ready
            .filter((wiki) => text === "" || wiki.repo.toLowerCase().includes(typed ?? text))
            .slice(0, SUGGESTIONS);
    if (active >= shown.length) active = shown.length - 1;
    list.replaceChildren(
      ...shown.map((wiki, index) =>
        h(
          "li",
          {
            role: "option",
            id: `${list.id}-${index}`,
            class: "option",
            "aria-selected": index === active ? "true" : "false",
            "data-index": index,
          },
          repoName(wiki.repo),
          h("span", { class: "option-meta" }, `${wiki.pages} pages`),
        ),
      ),
    );
    listWrap.hidden = shown.length === 0;
    input.setAttribute("aria-expanded", String(shown.length > 0));
    if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function schedule(immediate: boolean) {
    clearTimeout(timer);
    lookup?.abort();
    const repo = typedRef();
    if (!repo) {
      current = undefined;
      renderPreview({ kind: "none" });
      updateLabel();
      return;
    }
    const key = repo.toLowerCase();
    const wiki = byKey.get(key);
    if (wiki?.status === "ready") {
      current = { key, view: knownView(wiki) };
      renderPreview({ kind: "view", view: current.view, wiki });
      updateLabel();
      return;
    }
    if (current?.key === key) return;
    current = undefined;
    updateLabel();
    const run = async () => {
      const controller = new AbortController();
      lookup = controller;
      renderPreview({ kind: "checking", repo });
      try {
        const view = await lookupRepo(repo, controller.signal);
        if (controller.signal.aborted) return;
        current = { key, view };
        renderPreview({ kind: "view", view });
        updateLabel();
        if (view.repo.toLowerCase() !== key) {
          setNote(`${repo} now lives at ${view.repo} on GitHub.`, "info");
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        renderPreview({
          kind: "problem",
          message: error instanceof ApiProblem ? error.message : "The lookup failed. Try again.",
        });
      }
    };
    if (immediate) void run();
    else timer = setTimeout(() => void run(), LOOKUP_DELAY_MS);
  }

  const go = (href: string) => {
    window.location.href = href;
  };

  input.addEventListener("input", () => {
    setNote("");
    active = -1;
    clear.hidden = input.value === "";
    renderList(true);
    schedule(false);
  });

  // A pasted link is shown as owner/name straight away, and looked up without waiting
  input.addEventListener("paste", () => {
    setTimeout(() => {
      const pasted = input.value;
      const parsed = readRepoInput(pasted);
      if (parsed.ok) {
        const repo = formatRepoRef(parsed.ref);
        if (repo !== pasted.trim()) {
          input.value = repo;
          setNote(`Read ${repo} from the link.`, "info");
        }
        renderList(false);
        schedule(true);
      } else if (parsed.problem !== "empty") {
        setNote(repoInputMessage(parsed.problem, parsed.owner));
      }
      clear.hidden = input.value === "";
    }, 0);
  });

  input.addEventListener("focus", () => {
    prepareTurnstile();
    renderList(true);
  });
  input.addEventListener("blur", () => setTimeout(() => renderList(false), 120));

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (listWrap.hidden) renderList(true);
      if (shown.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + shown.length) % shown.length;
      renderList(true);
      list
        .querySelector(`#${CSS.escape(`${list.id}-${active}`)}`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Escape" && !listWrap.hidden) {
      event.preventDefault();
      active = -1;
      renderList(false);
    }
  });

  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    const wiki = option ? shown[Number(option.dataset.index)] : undefined;
    if (wiki) go(`/${wiki.repo}`);
  });

  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    setNote("");
    schedule(true);
    input.focus();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void open();
  });

  async function open() {
    if (busy) return;
    const chosen = active >= 0 ? shown[active] : undefined;
    if (chosen) return go(`/${chosen.repo}`);
    const parsed = readRepoInput(input.value);
    if (!parsed.ok) {
      setNote(repoInputMessage(parsed.problem, parsed.owner));
      input.focus();
      return;
    }
    const repo = formatRepoRef(parsed.ref);
    const key = repo.toLowerCase();
    const wiki = byKey.get(key);
    if (wiki?.status === "ready") return go(`/${wiki.repo}`);

    busy = true;
    submit.disabled = true;
    form.classList.add("is-busy");
    try {
      let view = current?.key === key ? current.view : undefined;
      if (!view) {
        clearTimeout(timer);
        lookup?.abort();
        label.textContent = "Checking";
        renderPreview({ kind: "checking", repo });
        view = await lookupRepo(repo);
        current = { key, view };
        renderPreview({ kind: "view", view });
      }
      const action = primaryAction(view);
      if (action.kind === "open" && view.href) return go(view.href);
      if (action.kind === "follow") return go(statusHref(view.repo));
      if (action.kind === "none") {
        setNote(view.reason?.message ?? "");
        return;
      }
      label.textContent = "Requesting";
      const token = await turnstileToken(check);
      const result = await requestRepo(view.repo, token);
      go(`${statusHref(result.view.repo)}&new=1`);
    } catch (error) {
      const message =
        error instanceof ApiProblem || error instanceof Error
          ? error.message
          : "Something went wrong. Try again.";
      if (error instanceof ApiProblem) renderPreview({ kind: "problem", message });
      else setNote(message);
    } finally {
      busy = false;
      submit.disabled = false;
      form.classList.remove("is-busy");
      updateLabel();
    }
  }

  clear.hidden = input.value === "";
  if (input.value) schedule(true);
}

export function mountOpeners(root: ParentNode = document): void {
  const known = readKnownWikis();
  root
    .querySelectorAll<HTMLFormElement>("[data-opener]")
    .forEach((form) => mountOpener(form, known));
}
