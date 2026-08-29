/**
 * View-only bucket presentation: CSS classes and the compact chip label.
 * Everything about what a bucket IS — id, canonical order, count key,
 * summary text, full display label — is the single ordered `BUCKETS` table
 * in `../triage.js`; this file only adds styling on top of that for the
 * view layer. See #59.
 */

import type { Bucket } from "../triage.js";

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
