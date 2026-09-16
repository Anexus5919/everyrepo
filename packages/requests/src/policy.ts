import { SIZE_TIERS, type RequestReason, type SizeEstimate, type SizeTier } from "@everyrepo/core";
import { estimateFromTree } from "@everyrepo/detect";
import { GithubError, type GithubClient, type GithubRepository } from "@everyrepo/github";
import type { RepoRef } from "@everyrepo/core";

export interface RequestPolicy {
  // Largest size tier built without the owner's approval
  autoApproveMaxTier: SizeTier;
  // Requests the rules approve in one UTC day; later ones wait for review
  autoApprovePerDay: number;
  // Approved builds waiting to start before new requests wait for review
  maxWaiting: number;
}

export const DEFAULT_REQUEST_POLICY: RequestPolicy = {
  autoApproveMaxTier: "M",
  autoApprovePerDay: 3,
  maxWaiting: 20,
};

// Reasons a repository cannot have a wiki at all, whatever the owner decides
export type IneligibleCode = "not-found" | "private" | "unavailable" | "empty" | "no-source";

export type Inspection =
  | { eligible: true; repository: GithubRepository; estimate: SizeEstimate }
  | { eligible: false; code: IneligibleCode; repository: GithubRepository | null };

// Looks a repository up on GitHub and sizes it from its file list, without downloading anything
export async function inspectRepository(github: GithubClient, ref: RepoRef): Promise<Inspection> {
  let repository: GithubRepository;
  try {
    repository = await github.repository(ref);
  } catch (error) {
    if (error instanceof GithubError && error.kind === "not-found") {
      return { eligible: false, code: "not-found", repository: null };
    }
    if (error instanceof GithubError && error.kind === "unavailable") {
      return { eligible: false, code: "unavailable", repository: null };
    }
    throw error;
  }
  // A token can see its owner's private repositories, which must never be published
  if (repository.private) return { eligible: false, code: "private", repository: null };
  if (repository.disabled) return { eligible: false, code: "unavailable", repository };

  const canonical = { owner: repository.owner, name: repository.name };
  let list;
  try {
    list = await github.fileList(canonical, repository.defaultBranch);
  } catch (error) {
    if (error instanceof GithubError && (error.kind === "empty" || error.kind === "not-found")) {
      return { eligible: false, code: "empty", repository };
    }
    throw error;
  }
  if (list.files.length === 0) return { eligible: false, code: "empty", repository };
  const gitattributes = list.files.some((file) => file.path === ".gitattributes")
    ? await github.file(canonical, "HEAD", ".gitattributes")
    : undefined;
  const tree = estimateFromTree(list.files, gitattributes);
  const estimate: SizeEstimate = {
    ...tree,
    // A list GitHub cut short belongs to a very large repository
    sizeTier: list.truncated ? "XL" : tree.sizeTier,
    truncated: list.truncated,
  };
  if (estimate.sourceFiles === 0) return { eligible: false, code: "no-source", repository };
  return { eligible: true, repository, estimate };
}

export type Decision =
  | { decision: "approved" }
  | { decision: "review"; reason: Extract<RequestReason, "large" | "daily-limit" | "queue-full"> };

export interface DecisionCounts {
  approvedToday: number;
  waiting: number;
}

export function decideRequest(
  estimate: SizeEstimate,
  policy: RequestPolicy,
  counts: DecisionCounts,
): Decision {
  if (SIZE_TIERS.indexOf(estimate.sizeTier) > SIZE_TIERS.indexOf(policy.autoApproveMaxTier)) {
    return { decision: "review", reason: "large" };
  }
  if (counts.approvedToday >= policy.autoApprovePerDay) {
    return { decision: "review", reason: "daily-limit" };
  }
  if (counts.waiting >= policy.maxWaiting) return { decision: "review", reason: "queue-full" };
  return { decision: "approved" };
}

// Repositories the owner adds on their own wait behind every build that someone asked for
const OWNER_ADDED_OFFSET = 200;
// Rewrites of published wikis wait behind every new wiki, since readers already have a version of them
const REWRITE_OFFSET = 100;

// Smaller repositories finish in far less time, so they go first and a large build cannot hold up many small ones
export function buildPriority(tier: SizeTier | null | undefined, asked = true): number {
  const bySize = 80 + 20 * Math.max(0, SIZE_TIERS.indexOf(tier ?? "M"));
  return asked ? bySize : bySize + OWNER_ADDED_OFFSET;
}

export function rewritePriority(tier: SizeTier | null | undefined): number {
  return buildPriority(tier, false) + REWRITE_OFFSET;
}
