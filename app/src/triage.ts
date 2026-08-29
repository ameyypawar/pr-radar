/**
 * Bucket logic. Turns a raw GitHub PR node into a `PullRequestSummary` that
 * answers one question: who does this PR need next?
 */

import type { RawPullRequest } from "./github.js";

/**
 * Single source of truth for the four buckets: identity, canonical display/priority order (most
 * urgent first), which `BucketCounts` key each rolls up into, the phrase used in the one-line
 * tool-result summary, and the display label. `Bucket`, the sort order, both Zod enums (server.ts),
 * the counts shape, the summary sentence (server.ts), and the view's chips/column labels
 * (components/bucket-meta.ts) all derive from this array — nothing about the four buckets should
 * be spelled out by hand anywhere else. See #59.
 */
export const BUCKETS = [
  { id: "BLOCKED_ON_YOU", countKey: "blockedOnYou", text: "blocked on you", label: "Blocked on you" },
  { id: "STALE", countKey: "stale", text: "stale", label: "Stale" },
  {
    id: "WAITING_ON_MAINTAINER",
    countKey: "waitingOnMaintainer",
    text: "waiting on a maintainer",
    label: "Waiting on maintainer",
  },
  { id: "DRAFT", countKey: "draft", text: "draft", label: "Draft" },
] as const;

export type Bucket = (typeof BUCKETS)[number]["id"];
export type BucketCountKey = (typeof BUCKETS)[number]["countKey"];
export type BucketCounts = Record<BucketCountKey, number>;

/** Builds a `Record<Bucket, T>` by picking one field (or the index) off each `BUCKETS` entry, in order. */
function bucketRecord<T>(pick: (meta: (typeof BUCKETS)[number], index: number) => T): Record<Bucket, T> {
  const result = {} as Record<Bucket, T>;
  BUCKETS.forEach((meta, index) => {
    result[meta.id] = pick(meta, index);
  });
  return result;
}

/** Canonical bucket order as a non-empty tuple — feeds both Zod enums in server.ts and the view's iteration order. */
export const BUCKET_ORDER = BUCKETS.map((b) => b.id) as [Bucket, ...Bucket[]];

/** Bucket -> its `BucketCounts` key. */
export const BUCKET_COUNT_KEY: Record<Bucket, BucketCountKey> = bucketRecord((b) => b.countKey);

/** Bucket -> the phrase used in the one-line tool-result summary (server.ts). */
export const BUCKET_TEXT: Record<Bucket, string> = bucketRecord((b) => b.text);

/** Bucket -> display label (view chips, board columns). */
export const BUCKET_LABEL: Record<Bucket, string> = bucketRecord((b) => b.label);

const STALE_THRESHOLD_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** CI states that put a PR on the author, not a maintainer. */
const BLOCKING_CI_STATES: ReadonlySet<string> = new Set(["FAILURE", "ERROR"]);

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
  /** Days since the PR was opened, or null if `createdAt` did not parse. */
  ageDays: number | null;
  /** Days since the PR was last updated — the basis for the STALE bucket — or null if `updatedAt` did not parse. */
  staleDays: number | null;
}

/** Returns null when `iso` does not parse as a date. "We don't know" must never collapse to 0. */
function daysSince(iso: string, now: number): number | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / MS_PER_DAY));
}

function ciStateOf(pr: RawPullRequest): string | null {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
}

/**
 * Buckets a raw PR node, precedence in this order: DRAFT, then
 * BLOCKED_ON_YOU (changes requested or failing or errored CI), then STALE
 * (no update in 14+ days, or an unparseable `updatedAt` — unknown activity is
 * treated as stale-eligible, not as fresh), then WAITING_ON_MAINTAINER as the
 * default.
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
  } else if (reviewDecision === "CHANGES_REQUESTED" || (ciState !== null && BLOCKING_CI_STATES.has(ciState))) {
    bucket = "BLOCKED_ON_YOU";
  } else if (staleDays === null || staleDays >= STALE_THRESHOLD_DAYS) {
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

const BUCKET_SORT_ORDER: Record<Bucket, number> = bucketRecord((_meta, index) => index);

/**
 * Sorts triaged PRs for display: BLOCKED_ON_YOU, then STALE, then
 * WAITING_ON_MAINTAINER, then DRAFT; most recently updated first within each
 * bucket, with an unparseable `updatedAt` sorting last within its bucket
 * instead of poisoning the comparator. Does not mutate the input array.
 */
export function sortPullRequestSummaries(prs: PullRequestSummary[]): PullRequestSummary[] {
  return [...prs].sort((a, b) => {
    const bucketDiff = BUCKET_SORT_ORDER[a.bucket] - BUCKET_SORT_ORDER[b.bucket];
    if (bucketDiff !== 0) return bucketDiff;

    // NaN-safe: `new Date(bad).getTime()` is NaN, and NaN is not a valid
    // comparator result — it must never reach the `return` below un-guarded,
    // or it can misorder well-formed neighbours too, not just the bad row.
    const aTime = new Date(a.updatedAt).getTime();
    const bTime = new Date(b.updatedAt).getTime();
    const aValid = !Number.isNaN(aTime);
    const bValid = !Number.isNaN(bTime);
    if (aValid && bValid) return bTime - aTime;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return 0; // both unparseable — tied, stable relative order
  });
}

/** Tallies triaged PRs per bucket, keyed by each bucket's `BucketCounts` key (see `BUCKETS`). */
export function countByBucket(prs: PullRequestSummary[]): BucketCounts {
  const counts = {} as BucketCounts;
  for (const meta of BUCKETS) {
    counts[meta.countKey] = 0;
  }
  for (const pr of prs) {
    counts[BUCKET_COUNT_KEY[pr.bucket]] += 1;
  }
  return counts;
}
