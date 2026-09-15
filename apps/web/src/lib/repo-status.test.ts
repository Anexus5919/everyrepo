import type { RepoView } from "@everyrepo/core/requests";
import { describe, expect, it } from "vitest";
import { milestones, pollDelay, primaryAction, relativeTime, statusCopy } from "./repo-status.ts";

const NOW = Date.parse("2026-09-16T08:00:00Z");

const view = (overrides: Partial<RepoView>): RepoView => ({
  repo: "acme/app",
  state: "available",
  reason: null,
  github: null,
  estimate: {
    files: 120,
    sourceFiles: 80,
    sourceTokens: 40_000,
    sizeTier: "S",
    truncated: false,
    languages: [],
  },
  queue: null,
  progress: null,
  requests: 0,
  requestedAt: null,
  updatedAt: null,
  resumeAt: null,
  href: null,
  ...overrides,
});

const progress = (stage: string, phase: "reading" | "writing" | "publishing", label: string) => ({
  phase,
  stage,
  label,
  step: 8,
  steps: 12,
  done: 120,
  total: 278,
  percent: 49,
  startedAt: null,
});

const states = (list: ReturnType<typeof milestones>) => list.map((item) => item.state);

describe("status copy", () => {
  it("says plainly what happens next for each state", () => {
    expect(statusCopy(view({}), NOW)).toEqual({
      tone: "open",
      title: "No wiki yet",
      detail:
        "Small repository with 80 source files. Small repositories are usually written within a few hours.",
    });
    expect(
      statusCopy(view({ state: "queued", queue: { position: 2, total: 5 }, requests: 3 }), NOW)
        .title,
    ).toBe("Number 2 in line");
    expect(
      statusCopy(
        view({
          state: "building",
          progress: progress("summarize", "writing", "Summarizing each part of the code"),
        }),
        NOW,
      ),
    ).toEqual({
      tone: "active",
      title: "Summarizing each part of the code",
      detail: "120 of 278, 49% of the whole build",
    });
    expect(
      statusCopy(view({ state: "paused", resumeAt: "2026-09-16T11:00:00Z" }), NOW).detail,
    ).toBe("It carries on by itself in 3 hours.");
    expect(
      statusCopy(
        view({
          state: "unavailable",
          estimate: null,
          reason: { code: "private", message: "Private." },
        }),
        NOW,
      ),
    ).toEqual({ tone: "blocked", title: "Private repository", detail: "Private." });
  });

  it("offers the action that fits the state", () => {
    expect(primaryAction(view({ state: "ready" }))).toEqual({
      kind: "open",
      label: "Open the wiki",
    });
    expect(primaryAction(view({}))).toEqual({ kind: "request", label: "Request this wiki" });
    expect(primaryAction(view({ reason: { code: "large", message: "" } })).label).toBe(
      "Ask for approval",
    );
    expect(primaryAction(view({ state: "paused" })).kind).toBe("follow");
    expect(primaryAction(view({ state: "unavailable" })).kind).toBe("none");
  });
});

describe("milestones", () => {
  it("follows a build from the line to a published wiki", () => {
    const queued = milestones(
      view({ state: "queued", queue: { position: 1, total: 2 }, requests: 1 }),
      NOW,
    );
    expect(states(queued)).toEqual(["current", "todo", "todo", "todo"]);
    expect(queued[0]?.note).toBe("Number 1 of 2 in line");

    const writing = milestones(
      view({
        state: "building",
        requestedAt: "2026-09-16T06:00:00Z",
        progress: progress("write", "writing", "Writing and checking pages"),
      }),
      NOW,
    );
    expect(states(writing)).toEqual(["done", "done", "current", "todo"]);
    expect(writing[0]?.note).toBe("2 hours ago");
    expect(writing[2]?.note).toBe("Writing and checking pages, 120 of 278");

    const paused = milestones(
      view({
        state: "paused",
        progress: progress("embed", "reading", "Indexing excerpts for search"),
      }),
      NOW,
    );
    expect(paused[1]?.note).toBe(
      "Indexing excerpts for search, 120 of 278, paused until the allowance refills",
    );

    expect(states(milestones(view({ state: "ready" }), NOW))).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    const failed = milestones(
      view({ state: "failed", progress: progress("parse", "reading", "Parsing the code") }),
      NOW,
    );
    expect(states(failed)).toEqual(["done", "stopped", "todo", "todo"]);
    expect(states(milestones(view({ state: "review" }), NOW))).toEqual([
      "current",
      "todo",
      "todo",
      "todo",
    ]);
    expect(states(milestones(view({}), NOW))).toEqual(["todo", "todo", "todo", "todo"]);
  });

  it("asks again quickly only while something is changing", () => {
    expect(pollDelay(view({ state: "building" }))).toBe(4_000);
    expect(pollDelay(view({ state: "queued" }))).toBe(15_000);
    expect(pollDelay(view({ state: "ready" }))).toBeNull();
    expect(pollDelay(view({ state: "failed" }))).toBeNull();
  });

  it("writes times relative to now", () => {
    expect(relativeTime("2026-09-16T07:59:40Z", NOW)).toBe("just now");
    expect(relativeTime("2026-09-16T07:55:00Z", NOW)).toBe("5 minutes ago");
    expect(relativeTime("2026-09-17T08:00:00Z", NOW)).toBe("tomorrow");
  });
});
