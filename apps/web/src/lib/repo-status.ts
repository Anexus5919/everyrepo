import type { RepoView, SizeTier } from "@everyrepo/core/requests";
import { sourceFileCount } from "./format.ts";

// How a state feels at a glance: the colour of its mark and whether it moves
export type Tone = "ready" | "active" | "waiting" | "attention" | "blocked" | "open";

export interface StatusCopy {
  tone: Tone;
  title: string;
  detail: string;
}

export type ActionKind = "open" | "request" | "follow" | "none";

export interface StatusAction {
  kind: ActionKind;
  label: string;
}

export type MilestoneKey = "requested" | "reading" | "writing" | "published";
export type MilestoneState = "done" | "current" | "todo" | "stopped";

export interface Milestone {
  key: MilestoneKey;
  label: string;
  state: MilestoneState;
  note: string;
}

const SIZE_NAMES: Record<SizeTier, string> = {
  S: "Small",
  M: "Medium",
  L: "Large",
  XL: "Very large",
};

const UNAVAILABLE_TITLES: Record<string, string> = {
  "not-found": "Repository not found",
  private: "Private repository",
  unavailable: "Unavailable on GitHub",
  empty: "Empty repository",
  "no-source": "No source code to explain",
};

export function sizeName(tier: SizeTier): string {
  return SIZE_NAMES[tier];
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function relativeTime(iso: string, now: number): string {
  const difference = Date.parse(iso) - now;
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(difference) >= size) return format.format(Math.round(difference / size), unit);
  }
  return difference > 0 ? "in under a minute" : "just now";
}

function counts(view: RepoView): string {
  const progress = view.progress;
  if (!progress || progress.done === null || progress.total === null || progress.total === 0) {
    return "";
  }
  return `${progress.done.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Estimates are rough, so ready times are rounded up to the next quarter hour
const ROUND_MS = 15 * MINUTE_MS;

function dateParts(time: number, timeZone: string | undefined) {
  const zone = timeZone ? { timeZone } : {};
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...zone,
  }).formatToParts(new Date(time));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...zone,
  }).format(new Date(time));
  const day = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...zone,
  }).format(new Date(time));
  return { weekday: part("weekday"), date: `${part("day")} ${part("month")}`, clock, day };
}

// How far away a time is, in words that fit an estimate
export function inAbout(iso: string, now: number): string {
  const difference = Date.parse(iso) - now;
  if (difference < 10 * MINUTE_MS) return "in a few minutes";
  if (difference < HOUR_MS) return `in about ${Math.round(difference / MINUTE_MS)} minutes`;
  if (difference < 1.5 * HOUR_MS) return "in about an hour";
  if (difference < DAY_MS) return `in about ${Math.round(difference / HOUR_MS)} hours`;
  if (difference < 1.5 * DAY_MS) return "in about a day";
  return `in about ${Math.round(difference / DAY_MS)} days`;
}

// A day, date and time, such as "Thursday, 17 September, around 4:30 PM (tomorrow)"
export function readyTime(iso: string, now: number, timeZone?: string): string {
  const time = Math.ceil(Date.parse(iso) / ROUND_MS) * ROUND_MS;
  const target = dateParts(time, timeZone);
  const today = dateParts(now, timeZone).day;
  const tomorrow = dateParts(now + DAY_MS, timeZone).day;
  const hint = target.day === today ? " (today)" : target.day === tomorrow ? " (tomorrow)" : "";
  return `${target.weekday}, ${target.date}, around ${target.clock}${hint}`;
}

// A compact ready time for lists, such as "Thu 17 Sep, 10:45 AM"
export function shortReadyTime(iso: string, timeZone?: string): string {
  const time = new Date(Math.ceil(Date.parse(iso) / ROUND_MS) * ROUND_MS);
  const zone = timeZone ? { timeZone } : {};
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    ...zone,
  }).formatToParts(time);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}, ${part("hour")}:${part("minute")} ${part("dayPeriod")}`;
}

// The estimate as one sentence, worded for a build in line or one that is not requested yet
export function etaSentence(view: RepoView, now: number, timeZone?: string): string {
  const eta = view.eta;
  if (!eta) return "";
  const when = readyTime(eta.readyAt, now, timeZone);
  if (eta.basis === "if-requested") return `If you request it now, expect it by ${when}.`;
  if (eta.basis === "if-approved") return `If approved now, expect it by ${when}.`;
  return `Expected ready by ${when}.`;
}

function workLength(minutes: number): string {
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

// What the estimate is made of, so a date far away does not look arbitrary
export function estimateReasons(view: RepoView, now: number, timeZone?: string): string[] {
  const eta = view.eta;
  if (!eta) return [];
  const reasons: string[] = [];
  if (!view.builder.online) {
    reasons.push("The builder is offline right now; the estimate assumes it starts again soon");
  }
  if (eta.ahead > 0) {
    reasons.push(`${eta.ahead} ${eta.ahead === 1 ? "build" : "builds"} ahead of it in line`);
  } else if (eta.basis === "line" && view.state !== "building") {
    reasons.push("Nothing ahead of it in line");
  }
  if (eta.allowanceUntil && Date.parse(eta.allowanceUntil) > now) {
    reasons.push(
      `The free model allowance it needs is used up until ${readyTime(eta.allowanceUntil, now, timeZone)}`,
    );
  }
  reasons.push(`${workLength(eta.workMinutes)} of work for this repository itself`);
  return reasons;
}

export interface CopyOptions {
  timeZone?: string;
  // Pages that show the estimate on its own leave it out of the detail
  withEta?: boolean;
}

export function statusCopy(view: RepoView, now: number, options: CopyOptions = {}): StatusCopy {
  const reason = view.reason?.message ?? "";
  const eta = options.withEta === false ? "" : etaSentence(view, now, options.timeZone);
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
  switch (view.state) {
    case "ready":
      return {
        tone: "ready",
        title: "The wiki is ready",
        detail: "Every page cites the code it came from.",
      };
    case "building": {
      const label = view.progress?.label ?? "Working on it";
      const done = [
        counts(view),
        view.progress ? `${view.progress.percent}% of the whole build` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return { tone: "active", title: label, detail: join(done ? `${done}.` : "", eta) };
    }
    case "queued": {
      if (view.resumeAt) {
        return {
          tone: "waiting",
          title: "Trying again shortly",
          detail: join(reason, `Next try ${relativeTime(view.resumeAt, now)}.`, eta),
        };
      }
      // A build that already did some work picks up where it stopped
      const started = view.progress !== null;
      const title = view.queue
        ? `Number ${view.queue.position} in line`
        : started
          ? "Waiting to continue"
          : "In line to be written";
      const detail = started
        ? "Work done so far is kept, and the build picks up where it stopped."
        : "";
      return { tone: "waiting", title, detail: join(detail, eta) };
    }
    case "paused":
      return {
        tone: "waiting",
        title: "Paused until the free allowance refills",
        detail: join(
          view.resumeAt
            ? `It carries on by itself ${relativeTime(view.resumeAt, now)}.`
            : "It carries on by itself.",
          eta,
        ),
      };
    case "review":
      return { tone: "attention", title: "Waiting for approval", detail: join(reason, eta) };
    case "failed":
      return { tone: "blocked", title: "The build stopped", detail: reason };
    case "rejected":
      return { tone: "blocked", title: "Request declined", detail: reason };
    case "unavailable":
      return {
        tone: "blocked",
        title: UNAVAILABLE_TITLES[view.reason?.code ?? ""] ?? "Cannot be read",
        detail: reason,
      };
    case "available": {
      const size = view.estimate
        ? `${sizeName(view.estimate.sizeTier)} repository with ${sourceFileCount(view.estimate.sourceFiles)}.`
        : "";
      return {
        tone: "open",
        title: view.reason ? "Needs approval" : "No wiki yet",
        detail: join(size, view.reason ? reason : "", eta),
      };
    }
  }
}

export function primaryAction(view: RepoView): StatusAction {
  switch (view.state) {
    case "ready":
      return { kind: "open", label: "Open the wiki" };
    case "available":
      return { kind: "request", label: view.reason ? "Ask for approval" : "Request this wiki" };
    case "unavailable":
      return { kind: "none", label: "" };
    default:
      return { kind: "follow", label: "Follow progress" };
  }
}

const MILESTONES: Array<{ key: MilestoneKey; label: string }> = [
  { key: "requested", label: "Requested" },
  { key: "reading", label: "Reading the code" },
  { key: "writing", label: "Writing the wiki" },
  { key: "published", label: "Published" },
];

// Four steps a visitor can follow; the stage inside a step is shown as its note
export function milestones(view: RepoView, now: number): Milestone[] {
  const phase = view.progress?.phase;
  // The step the build is on; 4 means every step is done
  const reached =
    view.state === "ready"
      ? 4
      : phase === "publishing"
        ? 3
        : phase === "writing"
          ? 2
          : phase === "reading"
            ? 1
            : 0;
  const requested = view.state !== "available" && view.state !== "unavailable";
  const halted = view.state === "failed" || view.state === "rejected";

  return MILESTONES.map(({ key, label }, index) => {
    const state: MilestoneState =
      index < reached
        ? "done"
        : index === reached && requested
          ? halted
            ? "stopped"
            : "current"
          : "todo";

    let note = "";
    if (key === "requested") {
      if (view.state === "review") note = "Waiting for approval";
      else if (view.state === "rejected") note = "Declined";
      else if (view.queue) note = `Number ${view.queue.position} of ${view.queue.total} in line`;
      else if (view.state === "queued" && reached === 0) note = "In line";
      else if (view.requestedAt) note = relativeTime(view.requestedAt, now);
    } else if (key === "published" && view.state === "ready") {
      note = "Open it any time";
    } else if (state === "current" || state === "stopped") {
      const waiting =
        view.state === "paused"
          ? "paused until the allowance refills"
          : view.state === "queued"
            ? "waiting to continue"
            : "";
      note = [view.progress?.label, counts(view), waiting].filter(Boolean).join(", ");
    }
    return { key, label, state, note };
  });
}

// How soon a status page asks again; nothing changes by itself once a build has finished
export function pollDelay(view: RepoView): number | null {
  switch (view.state) {
    case "building":
      return 4_000;
    case "queued":
      return 15_000;
    case "paused":
    case "review":
      return 60_000;
    default:
      return null;
  }
}

export function statusHref(repo: string): string {
  return `/request/?repo=${encodeURIComponent(repo)}`;
}
