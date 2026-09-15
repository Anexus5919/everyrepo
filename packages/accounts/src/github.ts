export interface GithubAppConfig {
  clientId: string;
  clientSecret: string;
  // Must match the callback URL registered on the GitHub OAuth app
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export type SignInFailure = "denied" | "expired" | "github" | "not-configured";

export class SignInError extends Error {
  override readonly name = "SignInError";

  constructor(
    readonly code: SignInFailure,
    message: string,
  ) {
    super(message);
  }
}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
// The public profile and the email address are all EveryRepo reads; no repository access is asked for
export const GITHUB_SCOPES = "read:user user:email";

export function authorizeUrl(config: GithubAppConfig, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", GITHUB_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

async function send(config: GithubAppConfig, url: string, init: RequestInit): Promise<Response> {
  try {
    return await (config.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new SignInError("github", "GitHub could not be reached. Try signing in again.");
  }
}

// Trades the one-time code for an access token, which is used once to read the profile and then dropped
export async function exchangeCode(
  config: GithubAppConfig,
  code: string,
  verifier: string,
): Promise<string> {
  const response = await send(config, TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  if (body.error === "bad_verification_code") {
    throw new SignInError("expired", "That sign-in link has expired. Try signing in again.");
  }
  if (!response.ok || !body.access_token) {
    throw new SignInError("github", "GitHub did not complete the sign-in. Try again.");
  }
  return body.access_token;
}

export async function fetchProfile(config: GithubAppConfig, token: string): Promise<GithubProfile> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "everyrepo",
    "x-github-api-version": "2022-11-28",
  };
  const user = await send(config, `${API}/user`, { headers });
  if (!user.ok) throw new SignInError("github", "GitHub did not share the profile. Try again.");
  const profile = (await user.json()) as {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };
  // The address on the profile may be hidden, so the primary verified address is asked for separately
  let email = profile.email ?? null;
  const emails = await send(config, `${API}/user/emails`, { headers });
  if (emails.ok) {
    const list = (await emails.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    email = list.find((item) => item.primary && item.verified)?.email ?? email;
  }
  return {
    id: profile.id,
    login: profile.login,
    name: profile.name?.trim() || null,
    email,
    avatarUrl: profile.avatar_url ?? null,
  };
}
