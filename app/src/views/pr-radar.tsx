import { Fragment } from "react";
import { useDisplayMode, useLayout, useViewState, type Theme } from "skybridge/web";
import { useToolInfo } from "../helpers.js";
import { BUCKET_COUNT_KEY, BUCKET_DOT_CLASS, BUCKET_LABEL, BUCKET_ORDER, BUCKET_SHORT_LABEL, type BucketCounts } from "../components/bucket-meta.js";
import { PrBoard, type BoardLayout } from "../components/pr-board.js";
import { PrRow } from "../components/pr-row.js";
import { ErrorBoundary } from "../components/error-boundary.js";
import "./tokens.css";
import "./pr-radar.css";

const SKELETON_ROW_COUNT = 3;

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

function themeClass(theme: Theme | undefined): string {
  return theme === "dark" ? "sb-theme-dark" : theme === "light" ? "sb-theme-light" : "";
}

function PrHeader({
  counts,
  totalCount,
  truncated,
  prsCount,
  login,
  tokenLabel,
}: {
  counts: BucketCounts;
  totalCount: number;
  truncated: boolean;
  prsCount: number;
  login: string | undefined;
  tokenLabel: string | null;
}) {
  return (
    <div className="pr-header">
      <div className="pr-header-count">
        {counts.blockedOnYou === 0 && prsCount > 0 ? "Nothing needs you" : `${counts.blockedOnYou} need you`}
      </div>
      <div className="pr-header-sub">
        {totalCount} open PR{totalCount === 1 ? "" : "s"}
        {login ? (
          <Fragment>
            {" · "}
            <span title={tokenLabel ?? undefined}>@{login}</span>
          </Fragment>
        ) : null}
      </div>
      {truncated ? (
        <div className="pr-header-sub">
          Showing {prsCount} of {totalCount}
        </div>
      ) : null}
    </div>
  );
}

/** Glance-only — not a filter control. The board (fullscreen) is where you
 * actually browse by bucket now, so these are display, not buttons. */
function PrChips({ counts, truncated }: { counts: BucketCounts; truncated: boolean }) {
  return (
    <div className="pr-chips">
      {BUCKET_ORDER.map((bucket) => {
        const count = `${counts[BUCKET_COUNT_KEY[bucket]]}${truncated ? "+" : ""}`;
        return (
          <span key={bucket} className="pr-chip" aria-label={`${BUCKET_LABEL[bucket]} (${count})`}>
            <span className={`pr-dot ${BUCKET_DOT_CLASS[bucket]}`} aria-hidden="true" />
            {BUCKET_SHORT_LABEL[bucket]}
            <span className="pr-chip-count">{count}</span>
          </span>
        );
      })}
    </div>
  );
}

function PrConnectBanner({ connectPrompt }: { connectPrompt: { needed: boolean; url: string; reason: string } | undefined }) {
  if (!connectPrompt?.needed) return null;
  return (
    <div className="pr-connect-banner">
      <span>{connectPrompt.reason}</span>
      <a className="pr-connect-banner-link" href={connectPrompt.url} target="_blank" rel="noreferrer">
        Connect GitHub
      </a>
    </div>
  );
}

function PrEmptyState({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="pr-empty">
      <div className="pr-empty-title">{title}</div>
      <div className="pr-empty-sub">{sub}</div>
    </div>
  );
}

function PrRadarSkeleton() {
  const { theme } = useLayout();
  const [mode] = useDisplayMode();
  const isFullscreen = mode === "fullscreen";
  return (
    <div className={`sb-root pr-root${isFullscreen ? " pr-fullscreen" : ""} ${themeClass(theme)}`.trim()}>
      <div className="pr-skeleton-label">Loading your PR radar…</div>
      <div className="pr-skeleton-line" style={{ width: "45%", height: 23 }} />
      <div className="pr-skeleton-line" style={{ width: "65%", marginTop: 6 }} />
      <div className="pr-skeleton-chips">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pr-skeleton-chip" />
        ))}
      </div>
      <div className="pr-skeleton-rows">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <div key={i} className="pr-skeleton-row" />
        ))}
      </div>
    </div>
  );
}

function PrRadarView() {
  const info = useToolInfo<"pr-radar">();
  const { theme } = useLayout();
  const [mode, setMode] = useDisplayMode();
  const [{ layout }, setLayoutState] = useViewState<{ layout: BoardLayout }>({ layout: "urgency" });

  if (!info.isSuccess || !info.output) {
    return <PrRadarSkeleton />;
  }

  const { totalCount, truncated, counts, prs, login, tokenSource, connectPrompt } = info.output;
  const isFullscreen = mode === "fullscreen";
  const tokenLabel = tokenSourceLabel(tokenSource);
  const rootClass = `sb-root pr-root${isFullscreen ? " pr-fullscreen" : ""} ${themeClass(theme)}`.trim();

  const banner = <PrConnectBanner connectPrompt={connectPrompt} />;
  const header = (
    <PrHeader counts={counts} totalCount={totalCount} truncated={truncated} prsCount={prs.length} login={login} tokenLabel={tokenLabel} />
  );
  const chips = <PrChips counts={counts} truncated={truncated} />;

  // Empty state 1: needs a GitHub connection and has nothing to show yet.
  if (connectPrompt?.needed && prs.length === 0) {
    return (
      <div className={rootClass}>
        {banner}
        {header}
        {chips}
        <PrEmptyState title="Nothing to show yet" sub="Connect GitHub above to load your pull requests." />
      </div>
    );
  }

  // Empty state 2: connected (or no connection needed), genuinely zero open PRs.
  if (prs.length === 0) {
    return (
      <div className={rootClass}>
        {banner}
        {header}
        {chips}
        <PrEmptyState
          title="You’re all caught up"
          sub={login ? `No open pull requests for ${login}.` : "No open pull requests."}
        />
      </div>
    );
  }

  if (isFullscreen) {
    return (
      <div className={rootClass}>
        {banner}
        {header}
        {chips}
        <PrBoard
          prs={prs}
          counts={counts}
          truncated={truncated}
          layout={layout}
          onLayoutChange={(next) => setLayoutState({ layout: next })}
          onCollapse={() => setMode("inline")}
        />
      </div>
    );
  }

  const blockedPrs = prs.filter((pr) => pr.bucket === "BLOCKED_ON_YOU").slice(0, 3);

  return (
    <div className={rootClass}>
      {banner}
      {header}
      {chips}
      {
        // Empty state 3: PRs exist, but none are blocked on you — the inline
        // summary's own "visible" set (the top-3-blocked slice) is empty.
        blockedPrs.length === 0 ? (
          <PrEmptyState title="Nothing blocked on you" sub="No pull requests need your action right now." />
        ) : (
          <div className="pr-list">
            {blockedPrs.map((pr) => (
              <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
            ))}
          </div>
        )
      }
      <button type="button" className="pr-open-fullscreen" onClick={() => setMode("fullscreen")}>
        Open full radar
      </button>
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
