import { Fragment, useState } from "react";
import { useLayout, type Theme } from "skybridge/web";
import { useToolInfo } from "../helpers.js";
import type { Bucket, PullRequestSummary } from "../triage.js";
import { ErrorBoundary } from "../components/error-boundary.js";
import "./tokens.css";
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

const BUCKET_GROUP_CLASS: Record<Bucket, string> = {
  BLOCKED_ON_YOU: "pr-group-blocked",
  WAITING_ON_MAINTAINER: "pr-group-waiting",
  STALE: "pr-group-stale",
  DRAFT: "pr-group-draft",
};

const BUCKET_LABEL: Record<Bucket, string> = {
  BLOCKED_ON_YOU: "Blocked on you",
  WAITING_ON_MAINTAINER: "Waiting on maintainer",
  STALE: "Stale",
  DRAFT: "Draft",
};

const BUCKET_COUNT_KEY: Record<Bucket, keyof BucketCounts> = {
  BLOCKED_ON_YOU: "blockedOnYou",
  WAITING_ON_MAINTAINER: "waitingOnMaintainer",
  STALE: "stale",
  DRAFT: "draft",
};

function ciMeta(state: string | null): { dot: string; label: string } | null {
  switch (state) {
    case "SUCCESS":
      return { dot: "pr-dot-green", label: "" };
    case "FAILURE":
      return { dot: "pr-dot-red", label: "CI failing" };
    case "ERROR":
      return { dot: "pr-dot-red", label: "CI error" };
    case "PENDING":
      return { dot: "pr-dot-pending", label: "CI pending" };
    case "EXPECTED":
      return { dot: "pr-dot-gray", label: "CI expected" };
    default:
      return null;
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

function updatedLabel(staleDays: number | null): string {
  if (staleDays === null) return "last update unknown";
  if (staleDays <= 6) return "";
  return staleDays === 1 ? "updated 1 day ago" : `updated ${staleDays} days ago`;
}

function themeClass(theme: Theme | undefined): string {
  return theme === "dark" ? "sb-theme-dark" : theme === "light" ? "sb-theme-light" : "";
}

function PrRow({ pr }: { pr: PullRequestSummary }) {
  const ci = ciMeta(pr.ciState);
  const labels = [ci?.label, reviewLabel(pr.reviewDecision), updatedLabel(pr.staleDays)].filter(
    (label): label is string => Boolean(label),
  );
  return (
    <a className="pr-row" href={pr.url} target="_blank" rel="noreferrer">
      <div className="pr-title">{pr.title}</div>
      <div className="pr-row-meta">
        {ci ? <span className={`pr-dot ${ci.dot}`} aria-hidden="true" /> : null}
        {labels.map((label, i) => (
          <Fragment key={i}>
            {i > 0 ? (
              <span className="pr-meta-sep" aria-hidden="true">
                ·
              </span>
            ) : null}
            <span>{label}</span>
          </Fragment>
        ))}
        <span className="pr-meta-sep" aria-hidden="true">
          ·
        </span>
        <span className="pr-repo">
          {pr.repo} <span className="pr-number">#{pr.number}</span>
        </span>
      </div>
    </a>
  );
}

function PrRadarSkeleton() {
  const { theme } = useLayout();
  return (
    <div className={`sb-root pr-root ${themeClass(theme)}`.trim()}>
      <div className="pr-skeleton-label">Loading your PR radar…</div>
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

function PrRadarView() {
  const info = useToolInfo<"pr-radar">();
  const [selectedBucket, setSelectedBucket] = useState<Bucket | null>(null);
  const { theme } = useLayout();

  if (!info.isSuccess || !info.output) {
    return <PrRadarSkeleton />;
  }

  const { totalCount, truncated, counts, prs, login, tokenSource, connectPrompt } = info.output;
  const visiblePrs = selectedBucket ? prs.filter((pr) => pr.bucket === selectedBucket) : prs;
  const tokenLabel = tokenSourceLabel(tokenSource);

  return (
    <div className={`sb-root pr-root ${themeClass(theme)}`.trim()}>
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
          {counts.blockedOnYou === 0 && prs.length > 0 ? "Nothing needs you" : `${counts.blockedOnYou} need you`}
        </div>
        <div className="pr-header-sub">
          {totalCount} open PR{totalCount === 1 ? "" : "s"}
          {login ? ` · @${login}` : ""}
        </div>
        {truncated ? (
          <div className="pr-header-sub">
            Showing {prs.length} of {totalCount}
          </div>
        ) : null}
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
              <span className="pr-chip-count">
                {counts[countKey]}
                {truncated ? "+" : ""}
              </span>
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
          <div className="pr-empty-sub">{login ? `No open pull requests for ${login}.` : "No open pull requests."}</div>
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
          {visiblePrs.map((pr, i) => (
            <Fragment key={`${pr.repo}#${pr.number}`}>
              {!selectedBucket && (i === 0 || visiblePrs[i - 1].bucket !== pr.bucket) ? (
                <div className={`pr-group ${BUCKET_GROUP_CLASS[pr.bucket]}`}>
                  {BUCKET_LABEL[pr.bucket]} · {counts[BUCKET_COUNT_KEY[pr.bucket]]}
                </div>
              ) : null}
              <PrRow pr={pr} />
            </Fragment>
          ))}
        </div>
      )}

      <div className="pr-meta-footer">{tokenLabel ? <span>{tokenLabel}</span> : null}</div>
    </div>
  );
}

export default function PrRadar() {
  return (
    <ErrorBoundary>
      <PrRadarView />
    </ErrorBoundary>
  );
}
