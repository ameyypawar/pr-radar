import { useState } from "react";
import { useToolInfo } from "../helpers.js";
import type { Bucket, PullRequestSummary } from "../triage.js";
import "./pr-radar.css";

interface BucketCounts {
  blockedOnYou: number;
  waitingOnMaintainer: number;
  stale: number;
  draft: number;
}

const CHIPS: Array<{ bucket: Bucket; emoji: string; label: string; countKey: keyof BucketCounts }> = [
  { bucket: "BLOCKED_ON_YOU", emoji: "🔴", label: "Blocked on you", countKey: "blockedOnYou" },
  { bucket: "STALE", emoji: "💤", label: "Stale", countKey: "stale" },
  { bucket: "WAITING_ON_MAINTAINER", emoji: "🟡", label: "Waiting on maintainer", countKey: "waitingOnMaintainer" },
  { bucket: "DRAFT", emoji: "⚪", label: "Draft", countKey: "draft" },
];

const BUCKET_PILL_CLASS: Record<Bucket, string> = {
  BLOCKED_ON_YOU: "pr-pill-blocked",
  WAITING_ON_MAINTAINER: "pr-pill-waiting",
  STALE: "pr-pill-stale",
  DRAFT: "pr-pill-draft",
};

const BUCKET_LABEL: Record<Bucket, string> = {
  BLOCKED_ON_YOU: "Blocked on you",
  WAITING_ON_MAINTAINER: "Waiting on maintainer",
  STALE: "Stale",
  DRAFT: "Draft",
};

function ciMeta(state: string | null): { dot: string; label: string } {
  switch (state) {
    case "SUCCESS":
      return { dot: "pr-dot-green", label: "CI passing" };
    case "FAILURE":
      return { dot: "pr-dot-red", label: "CI failing" };
    case "ERROR":
      return { dot: "pr-dot-red", label: "CI error" };
    case "PENDING":
      return { dot: "pr-dot-amber", label: "CI pending" };
    case "EXPECTED":
      return { dot: "pr-dot-gray", label: "CI expected" };
    default:
      return { dot: "pr-dot-gray", label: "No CI" };
  }
}

function reviewLabel(decision: string | null): string {
  switch (decision) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Review required";
    default:
      return "No review yet";
  }
}

function tokenSourceLabel(source: string): string | null {
  switch (source) {
    case "broker":
      return "token via GitHub connection";
    case "env":
      return "token via local .env";
    case "none":
      return null;
    default:
      return null;
  }
}

function updatedLabel(staleDays: number): string {
  if (staleDays <= 0) return "updated today";
  if (staleDays === 1) return "updated 1 day ago";
  return `updated ${staleDays} days ago`;
}

function PrRow({ pr }: { pr: PullRequestSummary }) {
  const ci = ciMeta(pr.ciState);
  return (
    <a className="pr-row" href={pr.url} target="_blank" rel="noreferrer">
      <div className="pr-row-top">
        <span className="pr-repo">
          {pr.repo} <span className="pr-number">#{pr.number}</span>
        </span>
        <span className={`pr-pill ${BUCKET_PILL_CLASS[pr.bucket]}`}>{BUCKET_LABEL[pr.bucket]}</span>
      </div>
      <div className="pr-title">{pr.title}</div>
      <div className="pr-row-meta">
        <span className={`pr-dot ${ci.dot}`} aria-hidden="true" />
        <span>{ci.label}</span>
        <span className="pr-meta-sep" aria-hidden="true">
          ·
        </span>
        <span>{reviewLabel(pr.reviewDecision)}</span>
        <span className="pr-meta-sep" aria-hidden="true">
          ·
        </span>
        <span>{updatedLabel(pr.staleDays)}</span>
      </div>
    </a>
  );
}

function PrRadarSkeleton() {
  return (
    <div className="pr-root">
      <div className="pr-skeleton-line" style={{ width: "45%", height: 18 }} />
      <div className="pr-skeleton-line" style={{ width: "65%", marginTop: 6 }} />
      <div className="pr-skeleton-chips">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pr-skeleton-chip" />
        ))}
      </div>
      <div className="pr-skeleton-rows">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="pr-skeleton-row" />
        ))}
      </div>
    </div>
  );
}

export default function PrRadar() {
  const info = useToolInfo<"pr-radar">();
  const [selectedBucket, setSelectedBucket] = useState<Bucket | null>(null);

  if (!info.isSuccess) {
    return <PrRadarSkeleton />;
  }

  const { totalCount, truncated, counts, prs, login, tokenSource, connectPrompt } = info.output;
  const visiblePrs = selectedBucket ? prs.filter((pr) => pr.bucket === selectedBucket) : prs;
  const tokenLabel = tokenSourceLabel(tokenSource);

  return (
    <div className="pr-root">
      {connectPrompt?.needed ? (
        <div className="pr-connect-banner">
          <span>{connectPrompt.reason}</span>
          <a className="pr-connect-banner-link" href={connectPrompt.url} target="_blank" rel="noreferrer">
            Connect GitHub
          </a>
        </div>
      ) : null}

      <div className="pr-header">
        <div className="pr-header-count">
          {totalCount} open PR{totalCount === 1 ? "" : "s"}
        </div>
        {truncated ? (
          <div className="pr-header-sub">
            Showing {prs.length} of {totalCount}
          </div>
        ) : null}
        <div className="pr-header-sub">
          {counts.blockedOnYou} of {totalCount} need you
        </div>
      </div>

      <div className="pr-chips">
        {CHIPS.map(({ bucket, emoji, label, countKey }) => {
          const active = selectedBucket === bucket;
          return (
            <button
              key={bucket}
              type="button"
              className={`pr-chip${active ? " pr-chip-active" : ""}`}
              aria-pressed={active}
              onClick={() => setSelectedBucket((current) => (current === bucket ? null : bucket))}
            >
              <span aria-hidden="true">{emoji}</span> {label}
              <span className="pr-chip-count">{counts[countKey]}</span>
            </button>
          );
        })}
      </div>

      {connectPrompt?.needed && prs.length === 0 ? (
        <div className="pr-empty">
          <div className="pr-empty-title">Nothing to show yet</div>
          <div className="pr-empty-sub">Connect GitHub above to load your pull requests.</div>
        </div>
      ) : prs.length === 0 ? (
        <div className="pr-empty">
          <div className="pr-empty-title">You&rsquo;re all caught up</div>
          <div className="pr-empty-sub">No open pull requests for {login}.</div>
        </div>
      ) : visiblePrs.length === 0 ? (
        <div className="pr-empty">
          <div className="pr-empty-title">Nothing in this bucket</div>
          <button type="button" className="pr-clear-filter" onClick={() => setSelectedBucket(null)}>
            Show all {prs.length}
          </button>
        </div>
      ) : (
        <div className="pr-list">
          {visiblePrs.map((pr) => (
            <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
          ))}
        </div>
      )}

      <div className="pr-meta-footer">
        <span>@{login}</span>
        {tokenLabel ? <span>{tokenLabel}</span> : null}
      </div>
    </div>
  );
}
