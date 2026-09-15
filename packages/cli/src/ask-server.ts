import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AskInputError,
  type AskAnswer,
  type AskDiagram,
  type AskEvent,
  type AskTurn,
} from "@everyrepo/ask";
import { EmbeddingBudgetError } from "@everyrepo/embed";
import { ModelUnavailableError } from "@everyrepo/llm";

export interface AskRequestBody {
  repo: string;
  question: string;
  page: string | null;
  history: AskTurn[];
  diagram: AskDiagram | null;
}

export interface AskBackend {
  ask(request: AskRequestBody, onEvent?: (event: AskEvent) => void): Promise<AskAnswer>;
  repos(): Array<{ repo: string; sha: string }>;
}

export interface AskServerOptions {
  // Questions one address may ask per minute
  perMinute?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export type AskStreamLine =
  AskEvent | { type: "answer"; answer: AskAnswer } | { type: "error"; message: string };

const MAX_BODY_BYTES = 8_000;
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const PAGE_SLUG = /^[a-z0-9][a-z0-9-]{0,150}$/i;
const HISTORY_TURNS = 6;

const DIAGRAM_NODES = 40;
const DIAGRAM_EDGES = 200;

// A diagram keeps only whole-number ids, short labels and arrows between boxes it names
export function readDiagram(value: unknown): AskDiagram | null {
  if (typeof value !== "object" || value === null) return null;
  const { nodes, edges } = value as Record<string, unknown>;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;
  const cleanNodes = nodes.slice(0, DIAGRAM_NODES).flatMap((node: unknown) => {
    const { id, label } = (node ?? {}) as Record<string, unknown>;
    return Number.isInteger(id) && typeof label === "string" && label.trim() !== ""
      ? [{ id: id as number, label: label.slice(0, 200) }]
      : [];
  });
  const ids = new Set(cleanNodes.map((node) => node.id));
  const cleanEdges = edges.slice(0, DIAGRAM_EDGES).flatMap((edge: unknown) => {
    const { from, to } = (edge ?? {}) as Record<string, unknown>;
    return ids.has(from as number) && ids.has(to as number)
      ? [{ from: from as number, to: to as number }]
      : [];
  });
  return cleanNodes.length >= 2 ? { nodes: cleanNodes, edges: cleanEdges } : null;
}

// Only the expected fields and sizes pass; anything else in the body is ignored
export function readRequest(body: unknown): AskRequestBody | null {
  if (typeof body !== "object" || body === null) return null;
  const { repo, question, page, history, diagram } = body as Record<string, unknown>;
  if (typeof repo !== "string" || typeof question !== "string") return null;
  const turns = Array.isArray(history) ? history.slice(-HISTORY_TURNS) : [];
  return {
    repo,
    question,
    page: typeof page === "string" && PAGE_SLUG.test(page) ? page : null,
    history: turns.flatMap((turn: unknown) => {
      if (typeof turn !== "object" || turn === null) return [];
      const { question: asked, answer } = turn as Record<string, unknown>;
      return typeof asked === "string" && typeof answer === "string"
        ? [{ question: asked.slice(0, 400), answer: answer.slice(0, 1_000) }]
        : [];
    }),
    diagram: readDiagram(diagram),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AskInputError("The request is too large."));
        request.destroy();
        return;
      }
      parts.push(part);
    });
    request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Messages visitors can act on; anything unexpected stays in the server log
export function publicMessage(error: unknown): string {
  if (error instanceof AskInputError) return error.message;
  if (error instanceof ModelUnavailableError || error instanceof EmbeddingBudgetError) {
    return "Ask has used its free allowance for now. Try again in a while.";
  }
  return "Something went wrong while answering. Try again.";
}

// Answers stream as one JSON object per line: stages first, then the answer or an error
export function createAskHandler(backend: AskBackend, options: AskServerOptions = {}) {
  const perMinute = options.perMinute ?? 10;
  const now = options.now ?? Date.now;
  const recent = new Map<string, number[]>();

  const allow = (address: string) => {
    const cutoff = now() - 60_000;
    const times = (recent.get(address) ?? []).filter((time) => time > cutoff);
    if (times.length >= perMinute) {
      recent.set(address, times);
      return false;
    }
    times.push(now());
    recent.set(address, times);
    return true;
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const origin = request.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("vary", "origin");
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && path === "/api/repos") {
      sendJson(response, 200, { repos: backend.repos() });
      return;
    }
    if (request.method !== "POST" || path !== "/api/ask") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    let body: AskRequestBody | null;
    try {
      body = readRequest(JSON.parse(await readBody(request)));
    } catch (error) {
      const message =
        error instanceof AskInputError ? error.message : "Send JSON with a repo and a question.";
      sendJson(response, 400, { error: message });
      return;
    }
    if (!body) {
      sendJson(response, 400, { error: "Send JSON with a repo and a question." });
      return;
    }
    const { repo } = body;
    if (!allow(request.socket.remoteAddress ?? "unknown")) {
      sendJson(response, 429, {
        error: "Too many questions at once. Wait a minute and ask again.",
      });
      return;
    }

    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    const send = (line: AskStreamLine) => response.write(`${JSON.stringify(line)}\n`);
    const started = now();
    try {
      const answer = await backend.ask(body, send);
      send({ type: "answer", answer });
      options.log?.(
        `${repo} ${answer.intent} ${answer.status} in ${now() - started} ms: ${answer.question}${answer.note ? ` (${answer.note})` : ""}`,
      );
    } catch (error) {
      if (!(error instanceof AskInputError)) {
        options.log?.(`${repo} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      send({ type: "error", message: publicMessage(error) });
    }
    response.end();
  };
}
