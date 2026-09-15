import type { ApiError, QueueView, RepoView } from "@everyrepo/core/requests";

// The local API from `everyrepo serve` unless the build names another address
export const API_URL = (
  import.meta.env.PUBLIC_API_URL ??
  import.meta.env.PUBLIC_ASK_URL ??
  "http://127.0.0.1:8787"
).replace(/\/+$/, "");

export class ApiProblem extends Error {
  override readonly name = "ApiProblem";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs: number | null = null,
    // The request this person is already waiting on, when the API refuses a second one
    readonly active: RepoView | null = null,
  ) {
    super(message);
  }
}

const OFFLINE_MESSAGE =
  "The request service is not reachable right now. Wikis that are already written still open.";

export async function call<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T | null; etag: string | null }> {
  let response: Response;
  try {
    // A caller's own cancel and a time limit both end the call
    const timeout = AbortSignal.timeout(20_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    // The session cookie goes along, so the API knows who is signed in
    response = await fetch(`${API_URL}${path}`, { ...init, signal, credentials: "include" });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiProblem(OFFLINE_MESSAGE, 0, "offline");
  }
  if (response.status === 304)
    return { status: 304, body: null, etag: response.headers.get("etag") };
  const body = (await response.json().catch(() => null)) as T | ApiError | null;
  if (!response.ok) {
    const failure = body as (ApiError & { active?: RepoView }) | null;
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiProblem(
      failure?.error.message ?? "Something went wrong. Try again in a moment.",
      response.status,
      failure?.error.code ?? "unknown",
      retryAfter > 0 ? retryAfter * 1_000 : null,
      failure?.active ?? null,
    );
  }
  return { status: response.status, body: body as T, etag: response.headers.get("etag") };
}

const repoPath = (repo: string) =>
  `/api/repos/${repo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;

export async function lookupRepo(repo: string, signal?: AbortSignal): Promise<RepoView> {
  const { body } = await call<RepoView>(repoPath(repo), signal ? { signal } : {});
  return body!;
}

export interface SubmitResult {
  view: RepoView;
  counted: boolean;
}

export async function requestRepo(repo: string, token?: string): Promise<SubmitResult> {
  const { body } = await call<SubmitResult>("/api/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, ...(token ? { token } : {}) }),
  });
  return body!;
}

export interface Poller {
  refresh(): void;
  stop(): void;
}

export interface PollOptions<T> {
  path: string;
  onValue: (value: T) => void;
  onProblem: (problem: ApiProblem) => void;
  // How long to wait before asking again, or null to stop
  delayFor: (value: T) => number | null;
}

// Asks again on a timer that follows the latest answer, sends the entity tag so unchanged answers are cheap,
// and waits while the tab is hidden
function poll<T>(options: PollOptions<T>): Poller {
  let etag: string | null = null;
  let last: T | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let failures = 0;

  const schedule = (delay: number | null) => {
    clearTimeout(timer);
    if (stopped || delay === null) return;
    timer = setTimeout(run, delay);
  };

  async function run() {
    if (stopped || running || document.hidden) return;
    running = true;
    try {
      const reply = await call<T>(options.path, etag ? { headers: { "if-none-match": etag } } : {});
      failures = 0;
      if (reply.status !== 304 && reply.body) {
        etag = reply.etag;
        last = reply.body;
        options.onValue(reply.body);
      }
      schedule(last ? options.delayFor(last) : null);
    } catch (error) {
      if (!(error instanceof ApiProblem)) return;
      failures += 1;
      options.onProblem(error);
      // Temporary trouble backs off, up to two minutes between tries
      schedule(error.retryAfterMs ?? Math.min(120_000, 5_000 * 2 ** failures));
    } finally {
      running = false;
    }
  }

  const onVisible = () => {
    if (!document.hidden) void run();
  };
  document.addEventListener("visibilitychange", onVisible);
  void run();

  return {
    refresh: () => void run(),
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

export function pollRepo(
  repo: string,
  onValue: (view: RepoView) => void,
  onProblem: (problem: ApiProblem) => void,
  delayFor: (view: RepoView) => number | null,
): Poller {
  return poll({ path: repoPath(repo), onValue, onProblem, delayFor });
}

export function pollQueue(
  onValue: (queue: QueueView) => void,
  onProblem: (problem: ApiProblem) => void,
): Poller {
  return poll({ path: "/api/queue", onValue, onProblem, delayFor: () => 15_000 });
}
