import type { RepoView, SizeTier } from "@everyrepo/core/requests";

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

const TYPICAL_TIME: Record<SizeTier, string> = {
  S: "Small repositories are usually written within a few hours.",
  M: "Medium repositories usually take about a day.",
  L: "Large repositories take several days on the free models EveryRepo uses.",
  XL: "Very large repositories take a week or more on the free models EveryRepo uses.",
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

export function typicalTime(tier: SizeTier | undefined): string {
  return tier ? TYPICAL_TIME[tier] : "";
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

export function statusCopy(view: RepoView, now: number): StatusCopy {
  const reason = view.reason?.message ?? "";
  const tier = view.estimate?.sizeTier;
  switch (view.state) {
    case "ready":
      return {
        tone: "ready",
        title: "The wiki is ready",
        detail: "Every page cites the code it came from.",
      };
    case "building": {
      const label = view.progress?.label ?? "Working on it";
      const detail = [
        counts(view),
        view.progress ? `${view.progress.percent}% of the whole build` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return { tone: "active", title: label, detail: detail || "Started just now." };
    }
    case "queued": {
      if (view.resumeAt) {
        return {
          tone: "waiting",
          title: "Trying again shortly",
          detail: `${reason} Next try ${relativeTime(view.resumeAt, now)}.`.trim(),
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
        : typicalTime(tier) || "It starts as soon as the builds ahead of it finish.";
      return { tone: "waiting", title, detail };
    }
    case "paused":
      return {
        tone: "waiting",
        title: "Paused until the free allowance refills",
        detail: view.resumeAt
          ? `It carries on by itself ${relativeTime(view.resumeAt, now)}.`
          : "It carries on by itself.",
      };
    case "review":
      return { tone: "attention", title: "Waiting for approval", detail: reason };
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
        ? `${sizeName(view.estimate.sizeTier)} repository with ${view.estimate.sourceFiles.toLocaleString("en-US")} source files.`
        : "";
      return {
        tone: "open",
        title: view.reason ? "Needs approval" : "No wiki yet",
        detail: [size, view.reason ? reason : typicalTime(tier)].filter(Boolean).join(" "),
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
