import type { SizeEstimate, SizeTier } from "@everyrepo/core";
import {
  DAY_MS,
  HOUR_MS,
  hourStart,
  modelsFor,
  neuronCapacityAt,
  taskCapacityAt,
  type CapacityLedger,
} from "./capacity.ts";

export const CALL_TASKS = ["summary", "plan", "page"] as const;
export type CallTask = (typeof CALL_TASKS)[number];

// What is left to do for one build
export interface BuildWork {
  readingMs: number;
  embedTokens: number;
  calls: Record<CallTask, number>;
  publishMs: number;
}

export interface LineItem {
  id: number;
  work: BuildWork;
  // A job waiting to retry is not picked up before this time
  notBefore: number;
}

export interface LineEstimate {
  startsAt: number;
  readyAt: number;
  // Time spent working on this build, without waits for allowances or other builds
  workMs: number;
  // Set when the build had to wait for a model or embedding allowance; the wait ends at this time
  allowanceWaitUntil: number | null;
}

// Measured on the indexed repositories: vectors cost 1,075 neurons per million tokens, and a call takes about 8 seconds
const NEURONS_PER_TOKEN = 1_075 / 1_000_000;
const EMBED_TOKENS_PER_SECOND = 4_000;
const CALL_MS = 8_000;
const HORIZON_MS = 120 * DAY_MS;
const READING_BASE_MS = 20_000;
const READING_MS_PER_TOKEN = 0.25;
const CHUNK_TOKENS_PER_SOURCE_TOKEN = 1.4;
// Embeddings go out in batches, so less than one batch of allowance is not worth starting on
const MIN_EMBED_TOKENS = 4_000;
export const PUBLISH_MS = 90_000;
// Pages a plan usually has for each size, as seen on the written wikis
export const PAGES_BY_TIER: Record<SizeTier, number> = { S: 7, M: 12, L: 25, XL: 40 };

// Work for a repository nobody has read yet, from counts seen on the indexed ones: clusters hold about 18,000 source
// tokens in large repositories, small ones split into a few more, and plans ask for two calls
export function workFromEstimate(estimate: SizeEstimate): BuildWork {
  const tokens = estimate.sourceTokens;
  const clusters =
    tokens < 200_000 ? Math.max(2, Math.round(tokens / 25_000) + 2) : Math.round(tokens / 18_000);
  const packages =
    estimate.sizeTier === "S" || estimate.sizeTier === "M" ? 1 : Math.round(clusters / 4);
  return {
    readingMs: READING_BASE_MS + tokens * READING_MS_PER_TOKEN,
    embedTokens: Math.round(tokens * CHUNK_TOKENS_PER_SOURCE_TOKEN),
    // Clusters, packages with several clusters, the repository and the glossary
    calls: { summary: clusters + packages + 2, plan: 2, page: PAGES_BY_TIER[estimate.sizeTier] },
    publishMs: PUBLISH_MS,
  };
}

interface Progress {
  item: LineItem;
  reading: number;
  embed: number;
  calls: Record<CallTask, number>;
  publish: number;
  startsAt?: number;
  readyAt?: number;
  workMs: number;
  allowanceWaitUntil: number | null;
  // What the build waits for right now, if anything
  blocked?: "embed" | CallTask | "never" | undefined;
}

// Plays the line forward the way one worker takes it: jobs in order, each running until an allowance stops it,
// the next job in line using the time, and every build going back to the front once allowances free up
export function simulateLine(
  items: readonly LineItem[],
  capacity: CapacityLedger,
  start: number,
): Map<number, LineEstimate> {
  const ledger = capacity.clone();
  const line: Progress[] = items.map((item) => ({
    item,
    reading: item.work.readingMs,
    embed: item.work.embedTokens,
    calls: { ...item.work.calls },
    publish: item.work.publishMs,
    workMs: 0,
    allowanceWaitUntil: null,
  }));

  const embedMinimum = (build: Progress) =>
    Math.min(build.embed, MIN_EMBED_TOKENS) * NEURONS_PER_TOKEN;

  const work = (build: Progress, from: number, ms: number) => {
    build.startsAt ??= from;
    build.workMs += ms;
    return from + ms;
  };

  const waitFor = (build: Progress, reason: Progress["blocked"], until: number | undefined) => {
    build.blocked = until === undefined ? "never" : reason;
    if (until !== undefined && build.allowanceWaitUntil === null) build.allowanceWaitUntil = until;
  };

  // Runs one build as far as it can go and returns the time it stopped
  function advance(build: Progress, from: number): number {
    let now = from;
    build.blocked = undefined;
    if (build.reading > 0) {
      now = work(build, now, build.reading);
      build.reading = 0;
    }
    while (build.embed > 0) {
      const left = ledger.neuronsLeft(now);
      const tokens = Math.min(build.embed, Math.floor(left / NEURONS_PER_TOKEN));
      if (tokens < Math.min(build.embed, MIN_EMBED_TOKENS)) {
        waitFor(build, "embed", neuronCapacityAt(ledger, now, embedMinimum(build)));
        return now;
      }
      ledger.useNeurons(now, tokens * NEURONS_PER_TOKEN);
      now = work(build, now, (tokens / EMBED_TOKENS_PER_SECOND) * 1_000);
      build.embed -= tokens;
    }
    for (const task of CALL_TASKS) {
      while (build.calls[task] > 0) {
        const model = modelsFor(ledger.config, task).find(
          (candidate) => ledger.requestsLeft(candidate, now) > 0,
        );
        if (!model) {
          waitFor(build, task, taskCapacityAt(ledger, task, now));
          return now;
        }
        const perCall = Math.max(60_000 / model.requestsPerMinute, CALL_MS);
        // Calls are counted in the hour they are made, so each hour's usage frees up at the right time
        const fitsThisHour = Math.max(1, Math.floor((hourStart(now) + HOUR_MS - now) / perCall));
        const count = Math.min(build.calls[task], ledger.requestsLeft(model, now), fitsThisHour);
        ledger.useRequests(model, now, count);
        now = work(build, now, count * perCall);
        build.calls[task] -= count;
      }
    }
    now = work(build, now, build.publish);
    build.publish = 0;
    build.readyAt = now;
    return now;
  }

  function nextEvent(now: number): number | undefined {
    const times: number[] = [];
    for (const build of line) {
      if (build.readyAt !== undefined) continue;
      if (build.item.notBefore > now) times.push(build.item.notBefore);
      if (build.blocked === "embed") {
        const at = neuronCapacityAt(ledger, now + 1, embedMinimum(build));
        if (at !== undefined) times.push(at);
      } else if (build.blocked && build.blocked !== "never") {
        const at = taskCapacityAt(ledger, build.blocked, now + 1);
        if (at !== undefined) times.push(at);
      }
    }
    const later = times.filter((time) => time > now);
    return later.length > 0 ? Math.min(...later) : undefined;
  }

  let now = start;
  while (line.some((build) => build.readyAt === undefined) && now - start < HORIZON_MS) {
    let moved = false;
    for (const build of line) {
      if (build.readyAt !== undefined || build.blocked === "never" || now < build.item.notBefore) {
        continue;
      }
      const stopped = advance(build, now);
      if (stopped > now || build.readyAt !== undefined) {
        now = stopped;
        moved = true;
        break;
      }
    }
    if (moved) continue;
    const next = nextEvent(now);
    if (next === undefined) break;
    now = next;
  }

  const estimates = new Map<number, LineEstimate>();
  for (const build of line) {
    if (build.readyAt === undefined) continue;
    estimates.set(build.item.id, {
      startsAt: build.startsAt ?? build.readyAt,
      readyAt: build.readyAt,
      workMs: build.workMs,
      allowanceWaitUntil: build.allowanceWaitUntil,
    });
  }
  return estimates;
}
