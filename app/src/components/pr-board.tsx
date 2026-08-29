import type { CSSProperties } from "react";
import { useLayout } from "skybridge/web";
import {
  BUCKET_COUNT_KEY,
  BUCKET_LABEL,
  BUCKET_ORDER,
  type BucketCounts,
  type PullRequestSummary,
} from "../triage.js";
import { BUCKET_PILL_CLASS } from "./bucket-meta.js";
import { PrRow } from "./pr-row.js";

export type BoardLayout = "urgency" | "repository";

interface PrBoardProps {
  prs: PullRequestSummary[];
  counts: BucketCounts;
  truncated: boolean;
  layout: BoardLayout;
  onLayoutChange: (layout: BoardLayout) => void;
  onCollapse: () => void;
}

/** Groups already-triaged, already-sorted PRs by repo, preserving both the
 * repo's first-appearance order (so the most urgent repo leads) and each
 * repo's internal order (bucket priority, then recency — inherited from the
 * sort already applied server-side). Pure presentation grouping — no change
 * to triage logic or data shape. */
function groupByRepository(prs: PullRequestSummary[]): Array<{ repo: string; prs: PullRequestSummary[] }> {
  const order: string[] = [];
  const byRepo = new Map<string, PullRequestSummary[]>();
  for (const pr of prs) {
    let list = byRepo.get(pr.repo);
    if (!list) {
      list = [];
      byRepo.set(pr.repo, list);
      order.push(pr.repo);
    }
    list.push(pr);
  }
  return order.map((repo) => ({ repo, prs: byRepo.get(repo) as PullRequestSummary[] }));
}

function UrgencyBoard({ prs, counts, truncated }: { prs: PullRequestSummary[]; counts: BucketCounts; truncated: boolean }) {
  return (
    <div className="pr-columns">
      {BUCKET_ORDER.map((bucket) => {
        const bucketPrs = prs.filter((pr) => pr.bucket === bucket);
        const count = `${counts[BUCKET_COUNT_KEY[bucket]]}${truncated ? "+" : ""}`;
        return (
          <div key={bucket} className="pr-column">
            <div className="pr-column-head">
              <span className={`pr-pill ${BUCKET_PILL_CLASS[bucket]}`}>{BUCKET_LABEL[bucket]}</span>
              <span className="pr-column-count">{count}</span>
            </div>
            <div className="pr-column-list">
              {bucketPrs.length === 0 ? (
                <div className="pr-column-empty">Nothing here</div>
              ) : (
                bucketPrs.map((pr) => <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RepositoryBoard({ prs }: { prs: PullRequestSummary[] }) {
  const groups = groupByRepository(prs);
  return (
    <div className="pr-repo-board">
      <div className="pr-repo-grid">
        {groups.map(({ repo, prs: repoPrs }) => (
          <div key={repo} className="pr-repo-card">
            <div className="pr-repo-card-head">
              <span className="pr-repo-card-name">{repo}</span>
              <span className="pr-repo-card-count">{repoPrs.length}</span>
            </div>
            <div className="pr-list">
              {repoPrs.map((pr) => (
                <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} hideRepo />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The fullscreen board: a layout switcher (urgency/repository), a collapse
 * control back to inline, and the chosen layout. Only rendered once the host
 * has actually granted fullscreen (see pr-radar.tsx) — sizes itself off
 * useLayout()'s maxHeight so its columns/grid can scroll independently
 * within the space the host actually gives it.
 */
export function PrBoard({ prs, counts, truncated, layout, onLayoutChange, onCollapse }: PrBoardProps) {
  const { maxHeight, safeArea } = useLayout();
  const style: CSSProperties =
    maxHeight != null
      ? { maxHeight, paddingBottom: safeArea.insets.bottom }
      : { height: "100dvh", paddingBottom: safeArea.insets.bottom };

  return (
    <div className="pr-board" style={style}>
      <div className="pr-board-toolbar">
        <div className="pr-layout-switch" role="group" aria-label="Board layout">
          <button
            type="button"
            className={`pr-layout-btn${layout === "urgency" ? " pr-layout-btn-active" : ""}`}
            aria-pressed={layout === "urgency"}
            onClick={() => onLayoutChange("urgency")}
          >
            By urgency
          </button>
          <button
            type="button"
            className={`pr-layout-btn${layout === "repository" ? " pr-layout-btn-active" : ""}`}
            aria-pressed={layout === "repository"}
            onClick={() => onLayoutChange("repository")}
          >
            By repository
          </button>
        </div>
        <button type="button" className="pr-collapse" onClick={onCollapse}>
          Collapse
        </button>
      </div>
      {layout === "repository" ? (
        <RepositoryBoard prs={prs} />
      ) : (
        <UrgencyBoard prs={prs} counts={counts} truncated={truncated} />
      )}
    </div>
  );
}
