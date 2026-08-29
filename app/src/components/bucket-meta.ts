/**
 * Single source of truth for bucket display metadata — the chips (inline
 * header) and the urgency board columns (fullscreen) both key off this.
 */

import type { Bucket } from "../triage.js";

export interface BucketCounts {
  blockedOnYou: number;
  waitingOnMaintainer: number;
  stale: number;
  draft: number;
}

/** Display/priority order: most urgent first. Mirrors triage.ts's BUCKET_SORT_ORDER. */
export const BUCKET_ORDER: Bucket[] = ["BLOCKED_ON_YOU", "STALE", "WAITING_ON_MAINTAINER", "DRAFT"];

export const BUCKET_LABEL: Record<Bucket, string> = {
  BLOCKED_ON_YOU: "Blocked on you",
  STALE: "Stale",
  WAITING_ON_MAINTAINER: "Waiting on maintainer",
  DRAFT: "Draft",
};

export const BUCKET_SHORT_LABEL: Record<Bucket, string> = {
  BLOCKED_ON_YOU: "Blocked",
  STALE: "Stale",
  WAITING_ON_MAINTAINER: "Waiting",
  DRAFT: "Draft",
};

export const BUCKET_DOT_CLASS: Record<Bucket, string> = {
  BLOCKED_ON_YOU: "pr-dot-red",
  STALE: "pr-dot-indigo",
  WAITING_ON_MAINTAINER: "pr-dot-pending",
  DRAFT: "pr-dot-gray",
};

export const BUCKET_PILL_CLASS: Record<Bucket, string> = {
  BLOCKED_ON_YOU: "pr-pill-blocked",
  STALE: "pr-pill-stale",
  WAITING_ON_MAINTAINER: "pr-pill-waiting",
  DRAFT: "pr-pill-draft",
};

export const BUCKET_COUNT_KEY: Record<Bucket, keyof BucketCounts> = {
  BLOCKED_ON_YOU: "blockedOnYou",
  WAITING_ON_MAINTAINER: "waitingOnMaintainer",
  STALE: "stale",
  DRAFT: "draft",
};
