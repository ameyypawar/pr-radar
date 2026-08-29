/**
 * Bucket logic. Turns a raw GitHub PR node into a `PullRequestSummary` that
 * answers one question: who does this PR need next?
 */

import type { RawPullRequest } from "./github.js";

export type Bucket = "BLOCKED_ON_YOU" | "STALE" | "WAITING_ON_MAINTAINER" | "DRAFT";

const STALE_THRESHOLD_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  repo: string;
  bucket: Bucket;
  isDraft: boolean;
  reviewDecision: string | null;
  /** Combined CI status from the PR's last commit's status-check rollup, or null if no CI ran. */
  ciState: string | null;
  createdAt: string;
  updatedAt: string;
  /** Days since the PR was opened. */
  ageDays: number;
  /** Days since the PR was last updated — the basis for the STALE bucket. */
  staleDays: number;
}

function daysSince(iso: string, now: number): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now - then) / MS_PER_DAY));
}

function ciStateOf(pr: RawPullRequest): string | null {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
}

/**
 * Buckets a raw PR node, precedence in this order: DRAFT, then
 * BLOCKED_ON_YOU (changes requested or failing CI), then STALE (no update
 * in 14+ days), then WAITING_ON_MAINTAINER as the default.
 */
export function triage(pr: RawPullRequest, now: number = Date.now()): PullRequestSummary {
  const isDraft = pr.isDraft === true;
  const reviewDecision = pr.reviewDecision ?? null;
  const ciState = ciStateOf(pr);
  const ageDays = daysSince(pr.createdAt, now);
  const staleDays = daysSince(pr.updatedAt, now);

  let bucket: Bucket;
  if (isDraft) {
    bucket = "DRAFT";
  } else if (reviewDecision === "CHANGES_REQUESTED" || ciState === "FAILURE") {
    bucket = "BLOCKED_ON_YOU";
  } else if (staleDays > STALE_THRESHOLD_DAYS) {
    bucket = "STALE";
  } else {
    bucket = "WAITING_ON_MAINTAINER";
  }

  return {
    number: pr.number,
    title: pr.title ?? "(untitled)",
    url: pr.url,
    repo: pr.repository?.nameWithOwner ?? "unknown/unknown",
    bucket,
    isDraft,
    reviewDecision,
    ciState,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    ageDays,
    staleDays,
  };
}

const BUCKET_SORT_ORDER: Record<Bucket, number> = {
  BLOCKED_ON_YOU: 0,
  STALE: 1,
  WAITING_ON_MAINTAINER: 2,
  DRAFT: 3,
};

/**
 * Sorts triaged PRs for display: BLOCKED_ON_YOU, then STALE, then
 * WAITING_ON_MAINTAINER, then DRAFT; most recently updated first within
 * each bucket. Does not mutate the input array.
 */
export function sortPullRequestSummaries(prs: PullRequestSummary[]): PullRequestSummary[] {
  return [...prs].sort((a, b) => {
    const bucketDiff = BUCKET_SORT_ORDER[a.bucket] - BUCKET_SORT_ORDER[b.bucket];
    if (bucketDiff !== 0) return bucketDiff;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}
