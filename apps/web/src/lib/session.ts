import type { AccountRequest, AccountUser } from "@everyrepo/core/requests";
import { API_URL, ApiProblem, call } from "./api.ts";

export interface Account {
  user: AccountUser | null;
  signInAvailable: boolean;
  // False when the API could not be reached, so the page does not claim someone is signed out
  reachable: boolean;
}

const CACHE_KEY = "everyrepo.account";
let pending: Promise<Account> | undefined;

// The last account this browser saw, so the header can show it before the API answers
export function cachedUser(): AccountUser | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as AccountUser | null;
    return saved && typeof saved.login === "string" ? saved : null;
  } catch {
    return null;
  }
}

function remember(user: AccountUser | null): void {
  try {
    if (user) localStorage.setItem(CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage can be blocked, which only means the header waits for the API
  }
  window.dispatchEvent(new CustomEvent<AccountUser | null>("accountchange", { detail: user }));
}

// Asked once per page view; every part of the page shares the answer
export function getAccount(): Promise<Account> {
  pending ??= call<{ user: AccountUser | null; signInAvailable: boolean }>("/api/auth/me")
    .then(({ body }) => {
      remember(body?.user ?? null);
      return {
        user: body?.user ?? null,
        signInAvailable: body?.signInAvailable ?? false,
        reachable: true,
      };
    })
    .catch(() => ({ user: cachedUser(), signInAvailable: false, reachable: false }));
  return pending;
}

// A path on this site, so a sign-in never sends anyone to another address
export function safeReturnPath(value: string | null, fallback = "/account/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return fallback;
  return value;
}

export const currentPath = () => `${window.location.pathname}${window.location.search}`;

// The site's sign-in page, which explains what GitHub shares before leaving for it
export function signInPage(returnTo: string = currentPath()): string {
  return `/signin/?return=${encodeURIComponent(returnTo)}`;
}

// Where the API starts the GitHub sign-in
export function githubSignInUrl(returnTo: string): string {
  return `${API_URL}/api/auth/github?return=${encodeURIComponent(safeReturnPath(returnTo))}`;
}

export function requestIntentPath(repo: string): string {
  return `/request/?repo=${encodeURIComponent(repo)}&intent=request`;
}

export async function signOut(): Promise<void> {
  await call("/api/auth/signout", { method: "POST" });
  pending = Promise.resolve({ user: null, signInAvailable: true, reachable: true });
  remember(null);
}

export async function deleteAccount(): Promise<void> {
  await call("/api/account", { method: "DELETE" });
  pending = Promise.resolve({ user: null, signInAvailable: true, reachable: true });
  remember(null);
}

export async function accountRequests(): Promise<AccountRequest[]> {
  const { body } = await call<AccountRequest[]>("/api/account/requests");
  return body ?? [];
}

// A signed-out answer from the API means the session ended, so the header stops showing the account
export function isSignInProblem(error: unknown): error is ApiProblem {
  const signIn = error instanceof ApiProblem && error.status === 401 && error.code === "sign-in";
  if (signIn) {
    pending = Promise.resolve({ user: null, signInAvailable: true, reachable: true });
    remember(null);
  }
  return signIn;
}
