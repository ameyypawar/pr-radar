import { Fragment } from "react";
import type { PullRequestSummary } from "../triage.js";
import { safeHttpUrl } from "../url-safety.js";

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

function updatedLabel(staleDays: number | null): string {
  if (staleDays === null) return "last update unknown";
  if (staleDays <= 6) return "";
  return staleDays === 1 ? "updated 1 day ago" : `updated ${staleDays} days ago`;
}

/**
 * One PR row. Used by the inline summary's top-3-blocked list, the urgency
 * board's columns, and the repository board's cards.
 *
 * `hideRepo` drops the "owner/repo" segment (keeping just "#123") — the
 * repository board already names the repo in its card heading, so repeating
 * it on every row is redundant there.
 */
export function PrRow({ pr, hideRepo = false }: { pr: PullRequestSummary; hideRepo?: boolean }) {
  const ci = ciMeta(pr.ciState);
  const labels = [ci?.label, reviewLabel(pr.reviewDecision), updatedLabel(pr.staleDays)].filter(
    (label): label is string => Boolean(label),
  );
  // Same http(s)-only allowlist as the consent URL (github-token.ts) — see #66. GitHub-sourced,
  // so this practically never rejects anything; a rejected scheme drops the link, not the row.
  const href = safeHttpUrl(pr.url) ?? undefined;
  return (
    <a className="pr-row" href={href} target="_blank" rel="noreferrer">
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
        {hideRepo ? (
          <span className="pr-number">#{pr.number}</span>
        ) : (
          <span className="pr-repo">
            {pr.repo} <span className="pr-number">#{pr.number}</span>
          </span>
        )}
      </div>
    </a>
  );
}
