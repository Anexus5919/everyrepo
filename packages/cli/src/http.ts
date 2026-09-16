import type { IncomingMessage, ServerResponse } from "node:http";

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

// Pages on this machine may always call the API; deployed sites are listed in EVERYREPO_ALLOWED_ORIGINS
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin !== undefined && (LOCAL_ORIGIN.test(origin) || allowed.includes(origin));
}

export function allowedOriginsFromEnv(): string[] {
  return (process.env["EVERYREPO_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowed: readonly string[],
): void {
  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin, allowed)) return;
  response.setHeader("access-control-allow-origin", origin!);
  // The website sends its session cookie with API calls, which browsers allow only with this header
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type, if-none-match, x-everyrepo-admin",
  );
  response.setHeader("access-control-expose-headers", "etag, retry-after");
  response.setHeader("vary", "origin");
}

export class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
}

export function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => {
      size += part.length;
      if (size > maxBytes) {
        reject(new BodyTooLargeError("The request is too large."));
        request.destroy();
        return;
      }
      parts.push(part);
    });
    request.on("end", () => resolve(Buffer.concat(parts)));
    request.on("error", reject);
  });
}

// Converts a Node request into a web Request, so handlers run the same way on other runtimes
export async function toWebRequest(request: IncomingMessage, maxBytes: number): Promise<Request> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await readBody(request, maxBytes) : undefined;
  return new Request(url, {
    method: request.method ?? "GET",
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}

export async function sendWebResponse(response: ServerResponse, reply: Response): Promise<void> {
  reply.headers.forEach((value, name) => {
    if (name !== "set-cookie") response.setHeader(name, value);
  });
  // Each cookie needs its own header line, which joining them into one value would break
  const cookies = reply.headers.getSetCookie();
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  response.writeHead(reply.status);
  response.end(Buffer.from(await reply.arrayBuffer()));
}

// The address a request came from; a proxy's header is trusted only when EVERYREPO_TRUST_PROXY is set
export function clientAddress(request: IncomingMessage): string {
  if (process.env["EVERYREPO_TRUST_PROXY"] === "1") {
    const forwarded = request.headers["cf-connecting-ip"] ?? request.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}
