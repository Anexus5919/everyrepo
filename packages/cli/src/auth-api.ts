import {
  authorizeUrl,
  beginSignIn,
  createSession,
  deleteUser,
  endSession,
  exchangeCode,
  fetchProfile,
  parseCookies,
  pkceChallenge,
  publicUser,
  randomToken,
  saveGithubUser,
  serializeCookie,
  sessionForToken,
  SESSION_MS,
  SIGN_IN_WINDOW_MS,
  SignInError,
  takeSignIn,
  type SessionRow,
  type UserRow,
} from "@everyrepo/accounts";
import type { AppDb } from "@everyrepo/db";
import { isAllowedOrigin } from "./http.ts";

export interface AuthApiOptions {
  db: AppDb;
  // The GitHub OAuth app; sign-in is off without it
  github: { clientId: string; clientSecret: string } | undefined;
  // Where people are sent back to, such as http://127.0.0.1:4323
  siteUrl: string;
  // This API's own address, which GitHub redirects to after sign-in
  apiUrl: string;
  allowedOrigins: readonly string[];
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
  // Accounts allowed into the admin dashboard, so the site can offer them the way in
  isAdmin?: (user: UserRow) => boolean;
}

export interface AuthApi {
  handle(request: Request): Promise<Response | undefined>;
  userFor(request: Request): Promise<UserRow | undefined>;
  sessionFor(request: Request): Promise<{ user: UserRow; session: SessionRow } | undefined>;
}

const DEFAULT_RETURN = "/account/";

export function isAuthRoute(path: string): boolean {
  return path.startsWith("/api/auth/") || path === "/api/account";
}

// Only paths on the website itself, so a sign-in link can never send someone to another site
export function safeReturn(value: string | null): string {
  if (!value || value.length > 500) return DEFAULT_RETURN;
  const external = !value.startsWith("/") || value.startsWith("//") || value.includes("\\");
  return external ? DEFAULT_RETURN : value;
}

export function createAuthApi(options: AuthApiOptions): AuthApi {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const secure = options.apiUrl.startsWith("https://");
  // Secure deployments use the __Host- prefix, which browsers only accept on HTTPS without a domain
  const sessionCookie = secure ? "__Host-everyrepo_session" : "everyrepo_session";
  const stateCookie = secure ? "__Host-everyrepo_signin" : "everyrepo_signin";
  const app = options.github
    ? {
        ...options.github,
        redirectUri: `${options.apiUrl}/api/auth/github/callback`,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }
    : undefined;

  const cookie = (request: Request, name: string) =>
    parseCookies(request.headers.get("cookie")).get(name);
  const clearState = serializeCookie(stateCookie, "", { maxAgeSeconds: 0, secure });
  const clearSession = serializeCookie(sessionCookie, "", { maxAgeSeconds: 0, secure });

  function redirect(location: string, cookies: string[] = []): Response {
    const headers = new Headers({ location, "cache-control": "no-store" });
    for (const value of cookies) headers.append("set-cookie", value);
    return new Response(null, { status: 302, headers });
  }

  const toSite = (path: string, cookies: string[] = []) =>
    redirect(new URL(path, options.siteUrl).toString(), cookies);

  const toSignIn = (code: string, returnTo: string) =>
    toSite(`/signin/?error=${code}&return=${encodeURIComponent(returnTo)}`, [clearState]);

  function json(body: unknown, status = 200, cookies: string[] = []): Response {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    for (const value of cookies) headers.append("set-cookie", value);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  }

  const problem = (status: number, code: string, message: string) =>
    json({ error: { code, message } }, status);

  // Changes that act on a session must come from the website, which is what stops other sites forging them
  const fromSite = (request: Request) => {
    const origin = request.headers.get("origin");
    return origin === null || isAllowedOrigin(origin, options.allowedOrigins);
  };

  const sessionFor = (request: Request) =>
    sessionForToken(db, cookie(request, sessionCookie), now());
  const userFor = async (request: Request) => (await sessionFor(request))?.user;

  async function callback(url: URL, request: Request): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    // GitHub's answer counts only with the state this browser was given when it left for GitHub
    const started =
      state !== "" && cookie(request, stateCookie) === state
        ? await takeSignIn(db, state, now())
        : undefined;
    if (!started || !app) return toSignIn("expired", DEFAULT_RETURN);
    if (url.searchParams.get("error")) return toSignIn("denied", started.returnTo);
    const code = url.searchParams.get("code");
    if (!code) return toSignIn("expired", started.returnTo);
    try {
      const token = await exchangeCode(app, code, started.verifier);
      const user = saveGithubUser(db, await fetchProfile(app, token), now());
      const session = await createSession(db, user.id, now());
      options.log?.(`signed in ${user.login}`);
      return toSite(started.returnTo, [
        clearState,
        serializeCookie(sessionCookie, session.token, {
          maxAgeSeconds: SESSION_MS / 1_000,
          secure,
        }),
      ]);
    } catch (error) {
      if (error instanceof SignInError) return toSignIn(error.code, started.returnTo);
      options.log?.(`sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      return toSignIn("github", started.returnTo);
    }
  }

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!isAuthRoute(path)) return undefined;

    if (path === "/api/auth/github" && request.method === "GET") {
      const returnTo = safeReturn(url.searchParams.get("return"));
      if (!app) return toSignIn("not-configured", returnTo);
      const state = randomToken();
      const verifier = randomToken(48);
      await beginSignIn(db, { state, verifier, returnTo }, now());
      return redirect(authorizeUrl(app, state, await pkceChallenge(verifier)), [
        serializeCookie(stateCookie, state, { maxAgeSeconds: SIGN_IN_WINDOW_MS / 1_000, secure }),
      ]);
    }
    if (path === "/api/auth/github/callback" && request.method === "GET") {
      return callback(url, request);
    }
    if (path === "/api/auth/me" && request.method === "GET") {
      const user = await userFor(request);
      return json({
        user: user ? publicUser(user) : null,
        signInAvailable: app !== undefined,
        admin: user !== undefined && (options.isAdmin?.(user) ?? false),
      });
    }
    if (path === "/api/auth/signout" && request.method === "POST") {
      if (!fromSite(request)) return problem(403, "origin", "Sign out from the EveryRepo website.");
      await endSession(db, cookie(request, sessionCookie));
      return json(null, 204, [clearSession]);
    }
    if (path === "/api/account" && request.method === "DELETE") {
      if (!fromSite(request)) {
        return problem(403, "origin", "Delete the account from the EveryRepo website.");
      }
      const user = await userFor(request);
      if (!user) return problem(401, "sign-in", "Sign in to delete your account.");
      deleteUser(db, user.id);
      options.log?.(`deleted account ${user.login}`);
      return json(null, 204, [clearSession]);
    }
    return problem(404, "not-found", "Not found");
  }

  return { handle, userFor, sessionFor };
}
