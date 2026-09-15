import type { AccountRequest, AccountUser } from "@everyrepo/core/requests";
import { ApiProblem } from "./api.ts";
import { h, icon } from "./dom.ts";
import {
  inAbout,
  readyTime,
  relativeTime,
  shortReadyTime,
  statusCopy,
  statusHref,
} from "./repo-status.ts";
import {
  accountRequests,
  deleteAccount,
  getAccount,
  isSignInProblem,
  signInPage,
  signOut,
} from "./session.ts";

const ACTIVE_STATES = new Set(["queued", "building", "paused", "review"]);
const REFRESH_MS = 30_000;

const memberSince = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(
    new Date(iso),
  );

function repoTitle(repo: string): Array<Node | string> {
  const [owner = "", name = ""] = repo.split("/");
  return [h("span", { class: "owner" }, `${owner} / `), name];
}

function picture(user: AccountUser): HTMLElement {
  const initial = (user.name ?? user.login).charAt(0).toUpperCase();
  const box = h("span", { class: "profile-picture", "aria-hidden": "true" });
  if (!user.avatarUrl) {
    box.append(initial);
    return box;
  }
  const source = new URL(user.avatarUrl);
  source.searchParams.set("s", "168");
  const image = new Image(84, 84);
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => box.replaceChildren(initial));
  image.src = source.toString();
  box.append(image);
  return box;
}

function gate(title: string, text: string, action: HTMLElement): HTMLElement {
  return h(
    "section",
    { class: "account-gate" },
    h("span", { class: "eyebrow" }, "Account"),
    h("h1", {}, title),
    h("p", {}, text),
    action,
  );
}

function currentRequest(item: AccountRequest, now: number): HTMLElement {
  const { view } = item;
  const copy = statusCopy(view, now, { withEta: false });
  return h(
    "div",
    { class: "current-request" },
    h("span", { class: "current-label" }, "In progress"),
    h("h3", { class: "current-title" }, ...repoTitle(view.repo)),
    h(
      "p",
      { class: "current-state" },
      h("strong", {}, `${copy.title}.`),
      copy.detail ? ` ${copy.detail}` : null,
    ),
    view.progress
      ? h(
          "div",
          {
            class: "current-track",
            role: "progressbar",
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": view.progress.percent,
            "aria-label": "Share of the whole build",
          },
          h("span", { style: `width: ${Math.max(2, view.progress.percent)}%` }),
        )
      : null,
    view.eta
      ? h(
          "div",
          { class: "current-eta" },
          h("strong", {}, readyTime(view.eta.readyAt, now)),
          h("span", {}, `Estimated ready ${inAbout(view.eta.readyAt, now)}`),
        )
      : null,
    h(
      "div",
      { class: "current-actions" },
      h(
        "a",
        { class: "btn btn-solid", href: statusHref(view.repo) },
        "Follow progress",
        icon("arrow"),
      ),
    ),
  );
}

function requestRow(item: AccountRequest, now: number): HTMLElement {
  const { view } = item;
  const copy = statusCopy(view, now, { withEta: false });
  const ready = view.state === "ready";
  const side =
    ACTIVE_STATES.has(view.state) && view.eta
      ? `Ready ${shortReadyTime(view.eta.readyAt)}`
      : ready
        ? "Open the wiki"
        : "";
  return h(
    "li",
    {},
    h(
      "a",
      {
        class: `request-row tone-${copy.tone}`,
        href: ready && view.href ? view.href : statusHref(view.repo),
      },
      h("span", { class: "request-mark", "aria-hidden": "true" }),
      h(
        "span",
        { class: "request-main" },
        h("span", { class: "request-name" }, ...repoTitle(view.repo)),
        h(
          "span",
          { class: "request-meta" },
          `${copy.title}. Asked ${relativeTime(item.requestedAt, now)}.`,
        ),
      ),
      h("span", { class: "request-side" }, side),
      icon("arrow"),
    ),
  );
}

export function mountAccountPage(): void {
  const root = document.querySelector<HTMLElement>("[data-account-root]");
  const announce = document.querySelector<HTMLElement>("[data-account-announce]");
  if (!root) return;

  let user: AccountUser | undefined;
  let requests: AccountRequest[] = [];
  let problem: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scrolled = false;

  const signInButton = () =>
    h(
      "a",
      { class: "btn btn-solid", href: signInPage("/account/") },
      icon("github"),
      "Sign in with GitHub",
    );

  function showSignedOut() {
    clearTimeout(timer);
    root!.replaceChildren(
      gate(
        "Your account",
        "Sign in with GitHub to request repositories and follow the requests you made. Reading wikis needs no account.",
        signInButton(),
      ),
    );
  }

  function render() {
    if (!user) return;
    const now = Date.now();
    const current = requests.find((item) => ACTIVE_STATES.has(item.view.state));
    // The request in progress has its own card, so the list below holds the others
    const earlier = requests.filter((item) => item !== current);
    const signOutButton = h("button", { class: "btn btn-line", type: "button" }, "Sign out");
    signOutButton.addEventListener("click", async () => {
      signOutButton.setAttribute("disabled", "");
      try {
        await signOut();
        window.location.href = "/";
      } catch (error) {
        signOutButton.removeAttribute("disabled");
        problem = error instanceof ApiProblem ? error.message : "Signing out failed. Try again.";
        render();
      }
    });
    const deleteButton = h("button", { class: "btn btn-danger", type: "button" }, "Delete account");
    deleteButton.addEventListener("click", () => confirmDelete(user!));

    root!.replaceChildren(
      h(
        "header",
        { class: "profile" },
        picture(user),
        h(
          "div",
          { class: "profile-main" },
          h("span", { class: "eyebrow" }, "Your account"),
          h("h1", { class: "profile-name" }, user.name ?? user.login),
          h(
            "div",
            { class: "profile-facts" },
            h(
              "a",
              {
                class: "fact",
                href: `https://github.com/${encodeURIComponent(user.login)}`,
                target: "_blank",
                rel: "noopener",
              },
              icon("github"),
              user.login,
            ),
            user.email ? h("span", { class: "fact" }, user.email) : null,
            h("span", { class: "fact" }, `Member since ${memberSince(user.memberSince)}`),
          ),
        ),
        signOutButton,
      ),
      h(
        "section",
        { class: "account-section", id: "requests", "aria-labelledby": "requests-title" },
        h(
          "div",
          { class: "account-section-head" },
          h(
            "h2",
            { id: "requests-title" },
            "Your requests",
            h("span", { class: "count" }, String(requests.length)),
          ),
          current
            ? null
            : h(
                "button",
                { class: "btn btn-line", type: "button", "data-open-repo": true },
                "Request a repository",
              ),
        ),
        h(
          "p",
          { class: "account-note" },
          "One request can be in progress at a time. Once it is ready, failed or declined, you can ask for the next one.",
        ),
        problem ? h("p", { class: "confirm-problem" }, problem) : null,
        current ? currentRequest(current, now) : null,
        requests.length === 0
          ? h("p", { class: "account-empty" }, "You have not requested a repository yet.")
          : null,
        current && earlier.length > 0
          ? h("h3", { class: "account-subhead" }, "Earlier requests")
          : null,
        earlier.length > 0
          ? h("ul", { class: "request-rows" }, ...earlier.map((item) => requestRow(item, now)))
          : null,
      ),
      h(
        "section",
        { class: "danger", "aria-labelledby": "delete-title" },
        h(
          "div",
          { class: "danger-text" },
          h("h2", { id: "delete-title" }, "Delete your account"),
          h(
            "p",
            {},
            "Removes your profile, your sign-ins on every device and your request history. Wikis you asked for stay published for everyone, and builds already in line carry on.",
          ),
        ),
        deleteButton,
      ),
    );

    // The page draws after it loads, so a link to #requests is followed once the list exists
    if (!scrolled && window.location.hash === "#requests") {
      scrolled = true;
      document.getElementById("requests")?.scrollIntoView();
    }
  }

  async function refresh() {
    clearTimeout(timer);
    try {
      requests = await accountRequests();
      problem = undefined;
    } catch (error) {
      if (isSignInProblem(error)) return showSignedOut();
      problem = error instanceof ApiProblem ? error.message : "Your requests could not be loaded.";
    }
    render();
    // Requests still moving are asked about again while the page is open
    if (requests.some((item) => ACTIVE_STATES.has(item.view.state))) {
      timer = setTimeout(() => {
        if (document.hidden) {
          document.addEventListener("visibilitychange", () => void refresh(), { once: true });
        } else {
          void refresh();
        }
      }, REFRESH_MS);
    }
  }

  function confirmDelete(account: AccountUser) {
    const input = h("input", {
      type: "text",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
    });
    const note = h("p", { class: "confirm-problem", role: "alert" });
    const keep = h("button", { class: "btn btn-line", type: "button" }, "Keep account");
    const remove = h(
      "button",
      { class: "btn btn-danger", type: "button", disabled: true },
      "Delete account",
    );
    const dialog = h(
      "dialog",
      { class: "notice-dialog", "aria-labelledby": "confirm-title" },
      h(
        "div",
        { class: "notice-shell confirm-shell" },
        h("h2", { id: "confirm-title" }, "Delete your account?"),
        h(
          "p",
          { class: "notice-text" },
          "This cannot be undone. Your profile and request history are removed, and every browser signed in to this account is signed out.",
        ),
        h("label", { class: "confirm-field" }, `Type ${account.login} to confirm`, input),
        note,
        h("div", { class: "notice-actions" }, keep, remove),
      ),
    );
    const matches = () => input.value.trim().toLowerCase() === account.login.toLowerCase();
    input.addEventListener("input", () => remove.toggleAttribute("disabled", !matches()));
    keep.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      document.documentElement.classList.remove("has-notice");
      dialog.remove();
    });
    remove.addEventListener("click", async () => {
      if (!matches()) return;
      remove.setAttribute("disabled", "");
      note.textContent = "";
      try {
        await deleteAccount();
      } catch (error) {
        remove.removeAttribute("disabled");
        note.textContent =
          error instanceof ApiProblem
            ? error.message
            : "The account could not be deleted. Try again.";
        return;
      }
      dialog.close();
      user = undefined;
      clearTimeout(timer);
      if (announce) announce.textContent = "Your account was deleted.";
      root!.replaceChildren(
        gate(
          "Your account was deleted",
          "Your profile, sign-ins and request history are gone. Wikis stay open to read, and you can create a new account with GitHub whenever you like.",
          h("a", { class: "btn btn-solid", href: "/" }, "Back to the wikis"),
        ),
      );
    });
    document.body.append(dialog);
    document.documentElement.classList.add("has-notice");
    dialog.showModal();
    input.focus();
  }

  void getAccount().then((account) => {
    if (!account.reachable) {
      root.replaceChildren(
        gate(
          "Your account",
          "The account service is not reachable right now. Wikis that are already written still open.",
          h("a", { class: "btn btn-line", href: "/account/" }, "Try again"),
        ),
      );
      return;
    }
    if (!account.user) return showSignedOut();
    user = account.user;
    document.title = `${user.login}: EveryRepo`;
    void refresh();
  });
}
