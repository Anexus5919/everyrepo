import { authStates, openAppDb, sessions, users } from "@everyrepo/db";
import { describe, expect, it } from "vitest";
import { authorizeUrl, exchangeCode, fetchProfile, SignInError } from "./github.ts";
import {
  beginSignIn,
  createSession,
  deleteUser,
  endSession,
  pruneSessions,
  publicUser,
  saveGithubUser,
  takeSignIn,
  userForSession,
} from "./store.ts";
import { parseCookies, pkceChallenge, randomToken, serializeCookie, sha256Hex } from "./tokens.ts";

const app = { clientId: "id", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/cb" };
const profile = { id: 99, login: "ada", name: "Ada", email: "ada@example.com", avatarUrl: null };

describe("tokens", () => {
  it("makes long random tokens and the standard PKCE challenge", async () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    // The example verifier and challenge from RFC 7636
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(await sha256Hex("abc")).toMatch(/^ba7816bf/);
  });

  it("reads and writes cookies that scripts cannot read", () => {
    expect(parseCookies("a=1; everyrepo_session=x%3Dy; broken")).toEqual(
      new Map([
        ["a", "1"],
        ["everyrepo_session", "x=y"],
      ]),
    );
    expect(serializeCookie("s", "v", { maxAgeSeconds: 60, secure: true })).toBe(
      "s=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure",
    );
  });
});

describe("GitHub sign-in", () => {
  it("asks only for the profile and email, with a PKCE challenge", () => {
    const url = new URL(authorizeUrl(app, "state-1", "challenge-1"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "id",
      redirect_uri: "http://127.0.0.1:8787/cb",
      scope: "read:user user:email",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      allow_signup: "true",
    });
  });

  it("exchanges the code and reads the primary verified email", async () => {
    const seen: Array<{ url: string; body?: unknown }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/access_token")) return Response.json({ access_token: "gho_token" });
      if (url.endsWith("/user")) {
        return Response.json({
          id: 7,
          login: "grace",
          name: " Grace ",
          email: null,
          avatar_url: "a",
        });
      }
      return Response.json([
        { email: "old@example.com", primary: false, verified: true },
        { email: "grace@example.com", primary: true, verified: true },
      ]);
    }) as typeof fetch;
    const config = { ...app, fetch: fake };
    const token = await exchangeCode(config, "code-1", "verifier-1");
    expect(token).toBe("gho_token");
    expect(seen[0]?.body).toMatchObject({ code: "code-1", code_verifier: "verifier-1" });
    expect(await fetchProfile(config, token)).toEqual({
      id: 7,
      login: "grace",
      name: "Grace",
      email: "grace@example.com",
      avatarUrl: "a",
    });

    const expired = {
      ...app,
      fetch: (async () => Response.json({ error: "bad_verification_code" })) as typeof fetch,
    };
    await expect(exchangeCode(expired, "old", "v")).rejects.toMatchObject({ code: "expired" });
    const offline = {
      ...app,
      fetch: (async () => Promise.reject(new TypeError("offline"))) as typeof fetch,
    };
    await expect(exchangeCode(offline, "c", "v")).rejects.toBeInstanceOf(SignInError);
  });
});

describe("accounts", () => {
  it("uses each sign-in state once and only within ten minutes", async () => {
    const db = openAppDb(":memory:");
    const start = new Date("2026-09-16T08:00:00Z");
    await beginSignIn(db, { state: "s1", verifier: "v1", returnTo: "/account/" }, start);
    expect(await takeSignIn(db, "s1", start)).toEqual({ verifier: "v1", returnTo: "/account/" });
    expect(await takeSignIn(db, "s1", start)).toBeUndefined();

    await beginSignIn(db, { state: "s2", verifier: "v2", returnTo: "/" }, start);
    expect(await takeSignIn(db, "s2", new Date(start.getTime() + 11 * 60_000))).toBeUndefined();
    expect(await takeSignIn(db, "never", start)).toBeUndefined();

    // Sign-ins nobody finished are cleared once their ten minutes are over
    await beginSignIn(db, { state: "s3", verifier: "v3", returnTo: "/" }, start);
    pruneSessions(db, new Date(start.getTime() + 5 * 60_000));
    expect(db.select().from(authStates).all()).toHaveLength(1);
    pruneSessions(db, new Date(start.getTime() + 11 * 60_000));
    expect(db.select().from(authStates).all()).toEqual([]);
  });

  it("creates an account once, keeps it through renames and signs browsers in with hashed tokens", async () => {
    const db = openAppDb(":memory:");
    const start = new Date("2026-09-16T08:00:00Z");
    const created = saveGithubUser(db, profile, start);
    const renamed = saveGithubUser(
      db,
      { ...profile, login: "ada-l" },
      new Date("2026-09-17T08:00:00Z"),
    );
    expect(renamed.id).toBe(created.id);
    expect(publicUser(renamed)).toEqual({
      login: "ada-l",
      name: "Ada",
      email: "ada@example.com",
      avatarUrl: null,
      memberSince: "2026-09-16T08:00:00.000Z",
    });

    const { token, expiresAt } = await createSession(db, created.id, start);
    expect(expiresAt).toEqual(new Date("2026-10-16T08:00:00Z"));
    expect(db.select().from(sessions).get()?.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(db.select().from(sessions).all())).not.toContain(token);

    expect((await userForSession(db, token, start))?.login).toBe("ada-l");
    expect(await userForSession(db, "wrong", start)).toBeUndefined();
    expect(await userForSession(db, token, new Date("2026-10-17T08:00:00Z"))).toBeUndefined();

    // A visit after an hour moves the expiry forward
    const visit = new Date("2026-10-10T08:00:00Z");
    await userForSession(db, token, visit);
    expect(db.select().from(sessions).get()?.expiresAt).toEqual(new Date("2026-11-09T08:00:00Z"));

    await endSession(db, token);
    expect(await userForSession(db, token, visit)).toBeUndefined();

    await createSession(db, created.id, start);
    deleteUser(db, created.id);
    expect(db.select().from(users).all()).toEqual([]);
    expect(db.select().from(sessions).all()).toEqual([]);
  });
});
