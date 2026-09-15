import {
  formatRepoRef,
  readRepoInput,
  readSearchInput,
  repoInputMessage,
  type SearchInput,
} from "@everyrepo/core/repo-ref";
import type { RepoSearch, RepoView } from "@everyrepo/core/requests";
import { ApiProblem, lookupRepo, requestRepo, searchRepos } from "./api.ts";
import { h, icon } from "./dom.ts";
import { formatCount, languageName, sourceFileCount } from "./format.ts";
import { primaryAction, sizeName, statusCopy, statusHref } from "./repo-status.ts";
import { showOneRequestNotice } from "./notice.ts";
import { getAccount, isSignInProblem, requestIntentPath, signInPage } from "./session.ts";
import {
  buildSuggestions,
  compactCount,
  covers,
  nameNeedle,
  narrow,
  searchKey,
  type KnownWiki,
  type Suggestion,
} from "./suggestions.ts";
import { prepareTurnstile, turnstileToken } from "./turnstile.ts";

export type { KnownWiki } from "./suggestions.ts";

export function readKnownWikis(): KnownWiki[] {
  try {
    return JSON.parse(document.getElementById("known-wikis")?.textContent ?? "[]") as KnownWiki[];
  } catch {
    return [];
  }
}

const LOOKUP_DELAY_MS = 350;
// Short enough to feel live, long enough that fast typing sends one search rather than one per letter
const SEARCH_DELAY_MS = 180;
const CACHED_SEARCHES = 200;

// Answers shared by every box on the page, so going back a letter shows results at once
const searches = new Map<string, RepoSearch>();

function rememberSearch(key: string, result: RepoSearch): void {
  searches.delete(key);
  searches.set(key, result);
  while (searches.size > CACHED_SEARCHES) searches.delete(searches.keys().next().value!);
}

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
    eta: null,
    builder: { online: true, lastSeenAt: null },
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
    add(icon("files"), sourceFileCount(view.estimate.sourceFiles));
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
      offlineNote(view),
    ),
  );
}

const WAITING_STATES = new Set(["available", "queued", "building", "paused", "review"]);

// Builds only move while the worker runs, so a waiting repository says when it is not running
function offlineNote(view: RepoView): HTMLElement | null {
  if (view.builder.online || !WAITING_STATES.has(view.state)) return null;
  return h(
    "span",
    { class: "preview-offline" },
    icon("clock"),
    view.state === "available"
      ? "The builder is offline right now. A request still takes its place in line."
      : "The builder is offline right now. The place in line is kept.",
  );
}

// Marks where the typed text appears in a name, the way search results show what matched
function highlight(text: string, needle: string): Array<Node | string> {
  const index = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (index === -1) return [text];
  return [
    text.slice(0, index),
    h("mark", {}, text.slice(index, index + needle.length)),
    text.slice(index + needle.length),
  ];
}

function suggestionName(repo: string, needle: string): HTMLElement {
  const [owner = "", name = ""] = repo.split("/");
  return h(
    "span",
    { class: "repo-name" },
    h("span", { class: "repo-owner" }, `${owner} / `),
    ...highlight(name, needle),
  );
}

function renderOption(
  item: Suggestion,
  needle: string,
  props: Record<string, string | number>,
): HTMLElement {
  if (item.kind === "wiki") {
    return h(
      "div",
      props,
      h("span", { class: "option-icon" }, icon("repo")),
      h("span", { class: "option-main" }, suggestionName(item.wiki.repo, needle)),
      h("span", { class: "option-meta" }, `${item.wiki.pages} pages`),
    );
  }
  if (item.kind === "owner") {
    const organization = item.owner.kind === "organization";
    return h(
      "div",
      props,
      h("span", { class: "option-icon" }, icon(organization ? "org" : "user")),
      h(
        "span",
        { class: "option-main" },
        h("span", { class: "repo-name" }, ...highlight(item.owner.login, needle)),
      ),
      h("span", { class: "option-meta" }, organization ? "Organization" : "User", icon("arrow")),
    );
  }
  const { repo, wiki } = item;
  const badge = wiki ? (wiki.status === "ready" ? "Wiki ready" : "Being written") : null;
  return h(
    "div",
    props,
    h("span", { class: "option-icon" }, icon("repo")),
    h(
      "span",
      { class: "option-main" },
      suggestionName(repo.repo, needle),
      repo.description ? h("span", { class: "option-description" }, repo.description) : null,
    ),
    h(
      "span",
      { class: "option-meta" },
      badge ? h("span", { class: "option-badge" }, badge) : null,
      repo.language ? h("span", { class: "option-language" }, repo.language) : null,
      h("span", { class: "option-stars" }, icon("star"), compactCount(repo.stars)),
    ),
  );
}

export function mountOpener(form: HTMLFormElement, known: readonly KnownWiki[]): void {
  if (form.dataset.mounted) return;
  form.dataset.mounted = "true";
  const input = form.querySelector<HTMLInputElement>("[data-opener-input]")!;
  const field = form.querySelector<HTMLElement>("[data-opener-field]")!;
  const list = form.querySelector<HTMLElement>("[data-opener-list]")!;
  const listWrap = form.querySelector<HTMLElement>("[data-opener-suggestions]")!;
  const status = form.querySelector<HTMLElement>("[data-opener-status]")!;
  const preview = form.querySelector<HTMLElement>("[data-opener-preview]")!;
  const note = form.querySelector<HTMLElement>("[data-opener-note]")!;
  const submit = form.querySelector<HTMLButtonElement>("[data-opener-submit]")!;
  const label = form.querySelector<HTMLElement>("[data-opener-label]")!;
  const clear = form.querySelector<HTMLButtonElement>("[data-opener-clear]")!;
  const check = form.querySelector<HTMLElement>("[data-opener-check]")!;
  const defaultLabel = label.textContent ?? "Open";

  const byKey = new Map(known.map((wiki) => [wiki.repo.toLowerCase(), wiki]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lookup: AbortController | undefined;
  let current: { key: string; view: RepoView } | undefined;
  let items: Suggestion[] = [];
  let active = -1;
  let listOpen = false;
  let busy = false;
  // Unknown until the API answers; requests need a signed-in account
  let signedIn: boolean | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchCall: AbortController | undefined;
  // The search in flight, the last one that failed, and the latest answer kept on screen while typing on
  let searching: string | undefined;
  let failed: string | undefined;
  let latest: { input: SearchInput; result: RepoSearch } | undefined;
  // A typed repository whose preview waits to see whether the search offers closer matches
  let awaitingSearch: string | undefined;

  const typedRef = () => {
    const parsed = readRepoInput(input.value);
    return parsed.ok ? formatRepoRef(parsed.ref) : undefined;
  };

  const exactWiki = () => {
    const typed = typedRef()?.toLowerCase();
    return typed !== undefined && byKey.get(typed)?.status === "ready";
  };

  // Nothing is searched once the text names a written wiki exactly
  const currentSearch = (): SearchInput | undefined =>
    exactWiki() ? undefined : readSearchInput(input.value);

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
          ? signedIn === false
            ? "Sign in to request"
            : current!.view.reason
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

  function statusMessage(search: SearchInput | undefined, result: RepoSearch | undefined): string {
    if (!listOpen || !search) return "";
    const key = searchKey(search);
    if (searching === key) return "Searching GitHub";
    if (result?.unavailable || failed === key) {
      return "GitHub search is not answering right now. Type the full owner/name or paste a link.";
    }
    if (result && items.length === 0) {
      return search.kind === "owner"
        ? `No public repositories from ${search.owner} match.`
        : "No public repositories or owners match.";
    }
    return "";
  }

  function renderList() {
    const text = input.value;
    const search = currentSearch();
    const exact = search ? searches.get(searchKey(search)) : undefined;
    // While the next letters are searched, the last answers that still match stay on screen
    const shown =
      exact ??
      (search && latest && covers(latest.input, search)
        ? narrow(latest.result, search)
        : undefined);
    const groups = listOpen && !exactWiki() ? buildSuggestions(text, search, known, shown) : [];
    items = groups.flatMap((group) => group.items);
    if (active >= items.length) active = items.length - 1;
    const needle = nameNeedle(text, search);
    let index = 0;
    list.replaceChildren(
      ...groups.map((group, position) =>
        h(
          "div",
          {
            role: "group",
            class: "option-group",
            "aria-labelledby": `${list.id}-group-${position}`,
          },
          h("div", { class: "suggestions-label", id: `${list.id}-group-${position}` }, group.label),
          ...group.items.map((item) => {
            const at = index++;
            return renderOption(item, needle, {
              role: "option",
              id: `${list.id}-${at}`,
              class: `option option-${item.kind}`,
              "aria-selected": at === active ? "true" : "false",
              "data-index": at,
            });
          }),
        ),
      ),
    );
    const message = statusMessage(search, exact);
    status.textContent = message;
    status.hidden = message === "";
    status.classList.toggle("is-loading", search !== undefined && searching === searchKey(search));
    listWrap.hidden = items.length === 0 && message === "";
    input.setAttribute("aria-expanded", String(items.length > 0));
    if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    const search = currentSearch();
    const key = search ? searchKey(search) : undefined;
    if (!search || !key || searches.has(key)) {
      searchCall?.abort();
      searching = undefined;
      return;
    }
    if (searching === key) return;
    searchTimer = setTimeout(async () => {
      searchCall?.abort();
      const controller = new AbortController();
      searchCall = controller;
      searching = key;
      renderList();
      try {
        const result = await searchRepos(input.value.trim(), controller.signal);
        if (controller.signal.aborted) return;
        rememberSearch(key, result);
        latest = { input: search, result };
        failed = undefined;
      } catch {
        if (controller.signal.aborted) return;
        failed = key;
      }
      searching = undefined;
      renderList();
      decideLookup();
    }, SEARCH_DELAY_MS);
  }

  function runLookup(repo: string, key: string, immediate: boolean) {
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

  // A typed repository is previewed once the search finds it exactly or finds nothing close;
  // while the search offers closer matches, the preview waits until one is picked or the form is sent
  function decideLookup() {
    const waiting = awaitingSearch;
    const repo = typedRef();
    if (!waiting || !repo || repo.toLowerCase() !== waiting) return;
    const search = currentSearch();
    const key = search ? searchKey(search) : undefined;
    const result = key ? searches.get(key) : undefined;
    if (!result && failed !== key) return;
    awaitingSearch = undefined;
    if (result?.repos.some((item) => item.repo.toLowerCase() === waiting)) {
      runLookup(repo, waiting, true);
    } else if (!result || result.unavailable || result.repos.length === 0) {
      runLookup(repo, waiting, false);
    }
  }

  function schedule(immediate: boolean) {
    clearTimeout(timer);
    lookup?.abort();
    awaitingSearch = undefined;
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
    renderPreview({ kind: "none" });
    if (!immediate && currentSearch()) {
      awaitingSearch = key;
      decideLookup();
      return;
    }
    runLookup(repo, key, immediate);
  }

  const go = (href: string) => {
    window.location.href = href;
  };

  function choose(item: Suggestion) {
    active = -1;
    if (item.kind === "wiki") return go(`/${item.wiki.repo}`);
    if (item.kind === "repo" && item.wiki?.status === "ready") return go(`/${item.wiki.repo}`);
    setNote("");
    clear.hidden = false;
    if (item.kind === "owner") {
      // Picking an owner lists their repositories, as typing the slash would
      input.value = `${item.owner.login}/`;
      input.setSelectionRange(input.value.length, input.value.length);
      listOpen = true;
      renderList();
      scheduleSearch();
      schedule(false);
      return;
    }
    input.value = item.repo.repo;
    listOpen = false;
    renderList();
    schedule(true);
  }

  input.addEventListener("input", () => {
    setNote("");
    active = -1;
    listOpen = true;
    clear.hidden = input.value === "";
    renderList();
    scheduleSearch();
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
        clearTimeout(searchTimer);
        searchCall?.abort();
        searching = undefined;
        listOpen = false;
        renderList();
        schedule(true);
      } else if (parsed.problem !== "empty") {
        setNote(repoInputMessage(parsed.problem, parsed.owner));
      }
      clear.hidden = input.value === "";
    }, 0);
  });

  input.addEventListener("focus", () => {
    prepareTurnstile();
    listOpen = true;
    renderList();
    scheduleSearch();
  });
  input.addEventListener("blur", () =>
    setTimeout(() => {
      listOpen = false;
      renderList();
    }, 120),
  );

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!listOpen) {
        listOpen = true;
        renderList();
      }
      if (items.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + items.length) % items.length;
      renderList();
      list
        .querySelector(`#${CSS.escape(`${list.id}-${active}`)}`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Escape" && !listWrap.hidden) {
      event.preventDefault();
      active = -1;
      listOpen = false;
      renderList();
    }
  });

  listWrap.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    const item = option ? items[Number(option.dataset.index)] : undefined;
    if (item) choose(item);
  });

  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    setNote("");
    listOpen = true;
    renderList();
    scheduleSearch();
    schedule(true);
    input.focus();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void open();
  });

  async function open() {
    if (busy) return;
    const chosen = active >= 0 && !listWrap.hidden ? items[active] : undefined;
    if (chosen) return choose(chosen);
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
    listOpen = false;
    renderList();
    try {
      let view = current?.key === key ? current.view : undefined;
      if (!view) {
        clearTimeout(timer);
        lookup?.abort();
        awaitingSearch = undefined;
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
      const account = await getAccount();
      if (account.reachable && !account.user) return go(signInPage(requestIntentPath(view.repo)));
      label.textContent = "Requesting";
      const token = await turnstileToken(check);
      const result = await requestRepo(view.repo, token);
      go(`${statusHref(result.view.repo)}&new=1`);
    } catch (error) {
      const message =
        error instanceof ApiProblem || error instanceof Error
          ? error.message
          : "Something went wrong. Try again.";
      if (isSignInProblem(error)) {
        go(signInPage(requestIntentPath(current?.view.repo ?? input.value.trim())));
      } else if (error instanceof ApiProblem && error.code === "one-at-a-time") {
        showOneRequestNotice(error.active, message);
      } else if (error instanceof ApiProblem) {
        renderPreview({ kind: "problem", message });
      } else {
        setNote(message);
      }
    } finally {
      busy = false;
      submit.disabled = false;
      form.classList.remove("is-busy");
      updateLabel();
    }
  }

  clear.hidden = input.value === "";
  if (input.value) schedule(true);

  const setSignedIn = (value: boolean) => {
    signedIn = value;
    updateLabel();
  };
  void getAccount().then((account) => {
    if (account.reachable) setSignedIn(account.user !== null);
  });
  window.addEventListener("accountchange", (event) =>
    setSignedIn((event as CustomEvent<unknown>).detail !== null),
  );
}

export function mountOpeners(root: ParentNode = document): void {
  const known = readKnownWikis();
  root
    .querySelectorAll<HTMLFormElement>("[data-opener]")
    .forEach((form) => mountOpener(form, known));
}
