import { readRepoInput, formatRepoRef } from "@everyrepo/core/repo-ref";
import { getAccount, githubSignInUrl, safeReturnPath } from "./session.ts";

const PROBLEMS: Record<string, string> = {
  denied:
    "Sign-in was cancelled on GitHub, so nothing was shared. You can try again whenever you like.",
  expired: "That sign-in expired or was started in another browser. Start again from this page.",
  github: "GitHub did not answer in time. Try again in a moment.",
  "not-configured": "Signing in is not switched on for this server yet.",
  offline:
    "The account service is not reachable right now. Wikis that are already written still open.",
};

// The repository a person was about to request before they were asked to sign in
function requestedRepo(returnTo: string): string | undefined {
  const url = new URL(returnTo, window.location.origin);
  if (url.pathname !== "/request/" || url.searchParams.get("intent") !== "request")
    return undefined;
  const parsed = readRepoInput(url.searchParams.get("repo") ?? "");
  return parsed.ok ? formatRepoRef(parsed.ref) : undefined;
}

export function mountAuthPage(): void {
  const root = document.querySelector<HTMLElement>("[data-auth]");
  if (!root) return;
  const signup = root.dataset.mode === "signup";
  const params = new URLSearchParams(window.location.search);
  const returnTo = safeReturnPath(params.get("return"));
  const github = root.querySelector<HTMLAnchorElement>("[data-auth-github]")!;
  const problem = root.querySelector<HTMLElement>("[data-auth-problem]")!;
  const context = root.querySelector<HTMLElement>("[data-auth-context]")!;
  const signed = root.querySelector<HTMLElement>("[data-auth-signed]")!;
  const switchLink = root.querySelector<HTMLAnchorElement>("[data-auth-switch]");

  github.href = githubSignInUrl(returnTo);
  if (switchLink && params.has("return")) {
    switchLink.href = `${switchLink.pathname}?return=${encodeURIComponent(returnTo)}`;
  }

  const repo = requestedRepo(returnTo);
  if (repo) {
    context.textContent = `${signup ? "Create an account" : "Sign in"} to request ${repo}. You come straight back to it afterwards.`;
    context.hidden = false;
  }

  const showProblem = (code: string) => {
    problem.textContent = PROBLEMS[code] ?? PROBLEMS["github"]!;
    problem.hidden = false;
  };
  const error = params.get("error");
  if (error) {
    showProblem(error);
    // A reload should not show an old error again
    params.delete("error");
    const query = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }

  const disable = () => {
    github.setAttribute("aria-disabled", "true");
    github.tabIndex = -1;
  };

  void getAccount().then((account) => {
    if (!account.reachable) {
      showProblem("offline");
      disable();
      return;
    }
    if (account.user) {
      // Someone sent here on the way to a task who is already signed in goes straight on
      if (params.has("return") && !error) {
        window.location.replace(returnTo);
        return;
      }
      root.querySelector("[data-auth-signed-text]")!.textContent =
        `You are signed in as ${account.user.login}.`;
      root.querySelector<HTMLAnchorElement>("[data-auth-continue]")!.href = returnTo;
      signed.hidden = false;
      github.hidden = true;
      return;
    }
    if (!account.signInAvailable) {
      showProblem("not-configured");
      disable();
    }
  });
}
