import { sessions, users, openAppDb, type AppDb } from "@everyrepo/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createAuthApi, safeReturn, type AuthApiOptions } from "./auth-api.ts";

const API = "http://127.0.0.1:8787";
const SITE = "http://127.0.0.1:4323";

let db: AppDb;

beforeEach(() => {
  db = openAppDb(":memory:");
});

// GitHub answers the code exchange and the profile calls; a flag makes it refuse the code
function fakeGithub(options: { badCode?: boolean } = {}) {
  const calls: string[] = [];
  const doFetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/access_token")) {
      return Response.json(
        options.badCode ? { error: "bad_verification_code" } : { access_token: "gho_x" },
      );
    }
    if (url.endsWith("/user")) {
      return Response.json({
        id: 42,
        login: "ada",
        name: "Ada",
        email: null,
        avatar_url: "https://a",
      });
    }
    return Response.json([{ email: "ada@example.com", primary: true, verified: true }]);
  }) as typeof fetch;
  return { calls, doFetch };
}

function auth(extra: Partial<AuthApiOptions> = {}) {
  return createAuthApi({
    db,
    github: { clientId: "client", clientSecret: "secret" },
    siteUrl: SITE,
    apiUrl: API,
    allowedOrigins: [SITE],
    fetch: fakeGithub().doFetch,
    ...extra,
  });
}

const cookiesOf = (response: Response) =>
  Object.fromEntries(
    response.headers.getSetCookie().map((line) => {
      const [pair = ""] = line.split(";");
      const index = pair.indexOf("=");
      return [pair.slice(0, index), decodeURIComponent(pair.slice(index + 1))];
    }),
  );

async function startSignIn(api = auth(), returnTo = "/request/?repo=acme/app&intent=request") {
  const response = (await api.handle(
    new Request(`${API}/api/auth/github?return=${encodeURIComponent(returnTo)}`),
  ))!;
  const location = new URL(response.headers.get("location")!);
  return {
    response,
    location,
    state: location.searchParams.get("state")!,
    cookie: cookiesOf(response),
  };
}

const callback = (query: string, cookie: string) =>
  new Request(`${API}/api/auth/github/callback?${query}`, { headers: { cookie } });

describe("sign-in API", () => {
  it("sends people to GitHub with a state tied to their browser", async () => {
    const { response, location, state, cookie } = await startSignIn();
    expect(response.status).toBe(302);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("redirect_uri")).toBe(`${API}/api/auth/github/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cookie["everyrepo_signin"]).toBe(state);
    expect(response.headers.getSetCookie()[0]).toContain("HttpOnly");
  });

  it("creates the account, signs the browser in and returns to the page it came from", async () => {
    const github = fakeGithub();
    const api = auth({ fetch: github.doFetch });
    const { state } = await startSignIn(api);
    const response = (await api.handle(
      callback(`code=abc&state=${state}`, `everyrepo_signin=${state}`),
    ))!;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${SITE}/request/?repo=acme/app&intent=request`);
    const session = cookiesOf(response)["everyrepo_session"]!;
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.select().from(users).get()).toMatchObject({ login: "ada", email: "ada@example.com" });

    const me = (await api.handle(
      new Request(`${API}/api/auth/me`, { headers: { cookie: `everyrepo_session=${session}` } }),
    ))!;
    expect(await me.json()).toMatchObject({
      user: { login: "ada", name: "Ada" },
      signInAvailable: true,
    });

    // The state works once only
    const replay = (await api.handle(
      callback(`code=abc&state=${state}`, `everyrepo_signin=${state}`),
    ))!;
    expect(replay.headers.get("location")).toContain("/signin/?error=expired");
  });

  it("refuses a GitHub answer that did not start in this browser", async () => {
    const api = auth();
    const { state } = await startSignIn(api);
    const stolen = (await api.handle(
      callback(`code=abc&state=${state}`, "everyrepo_signin=other"),
    ))!;
    expect(stolen.headers.get("location")).toBe(
      `${SITE}/signin/?error=expired&return=%2Faccount%2F`,
    );
    expect(db.select().from(users).all()).toEqual([]);
  });

  it("explains a refusal, an expired code and a missing app", async () => {
    const api = auth({ fetch: fakeGithub({ badCode: true }).doFetch });
    const first = await startSignIn(api, "/queue/");
    const denied = (await api.handle(
      callback(`error=access_denied&state=${first.state}`, `everyrepo_signin=${first.state}`),
    ))!;
    expect(denied.headers.get("location")).toBe(`${SITE}/signin/?error=denied&return=%2Fqueue%2F`);

    const second = await startSignIn(api, "/queue/");
    const expired = (await api.handle(
      callback(`code=old&state=${second.state}`, `everyrepo_signin=${second.state}`),
    ))!;
    expect(expired.headers.get("location")).toContain("error=expired");

    const off = createAuthApi({
      db,
      github: undefined,
      siteUrl: SITE,
      apiUrl: API,
      allowedOrigins: [SITE],
    });
    const missing = (await off.handle(new Request(`${API}/api/auth/github?return=/queue/`)))!;
    expect(missing.headers.get("location")).toBe(
      `${SITE}/signin/?error=not-configured&return=%2Fqueue%2F`,
    );
  });

  it("signs out, deletes accounts only from the website and keeps return paths on the site", async () => {
    const api = auth();
    const { state } = await startSignIn(api);
    const signedIn = (await api.handle(
      callback(`code=abc&state=${state}`, `everyrepo_signin=${state}`),
    ))!;
    const cookie = `everyrepo_session=${cookiesOf(signedIn)["everyrepo_session"]}`;

    const forged = new Request(`${API}/api/account`, {
      method: "DELETE",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect((await api.handle(forged))!.status).toBe(403);

    const out = (await api.handle(
      new Request(`${API}/api/auth/signout`, { method: "POST", headers: { cookie, origin: SITE } }),
    ))!;
    expect(out.status).toBe(204);
    expect(cookiesOf(out)["everyrepo_session"]).toBe("");
    expect(db.select().from(sessions).all()).toEqual([]);

    const again = await startSignIn(api);
    const back = (await api.handle(
      callback(`code=abc&state=${again.state}`, `everyrepo_signin=${again.state}`),
    ))!;
    const deleted = (await api.handle(
      new Request(`${API}/api/account`, {
        method: "DELETE",
        headers: {
          cookie: `everyrepo_session=${cookiesOf(back)["everyrepo_session"]}`,
          origin: SITE,
        },
      }),
    ))!;
    expect(deleted.status).toBe(204);
    expect(db.select().from(users).all()).toEqual([]);

    expect(safeReturn("/request/?repo=a/b")).toBe("/request/?repo=a/b");
    for (const unsafe of ["https://evil.example", "//evil.example", "/\\evil.example", null, ""]) {
      expect(safeReturn(unsafe)).toBe("/account/");
    }
  });

  it("marks cookies secure and host-only when the API runs over HTTPS", async () => {
    const api = auth({ apiUrl: "https://api.everyrepo.me", siteUrl: "https://everyrepo.me" });
    const { response } = await startSignIn(api);
    const [line = ""] = response.headers.getSetCookie();
    expect(line).toMatch(/^__Host-everyrepo_signin=/);
    expect(line).toContain("Secure");
  });
});
