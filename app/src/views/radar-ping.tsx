import { useToolInfo } from "../helpers.js";
import { ErrorBoundary } from "./error-boundary.js";
import "./radar-ping.css";

function initials(label: string): string {
  const local = label.includes("@") ? label.split("@")[0] : label;
  const parts = local.split(/[.\s_-]+/).filter(Boolean);
  const chars = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return chars.join("") || "?";
}

function formatVerifiedAt(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function RadarPingView() {
  const info = useToolInfo<"radar-ping">();

  if (!info.isSuccess || !info.output) {
    return (
      <div className="rp-root">
        <div className="rp-skeleton-label">Verifying your identity…</div>
        <div className="rp-card">
          <div className="rp-skeleton-avatar" />
          <div className="rp-identity" style={{ flex: 1 }}>
            <div className="rp-skeleton-line" style={{ width: "65%" }} />
            <div className="rp-skeleton-line" style={{ width: "40%" }} />
          </div>
        </div>
      </div>
    );
  }

  const { subject, email, scopes, clientId, verifiedAt } = info.output;
  const label = email ?? subject ?? "Unknown identity";
  const showSubjectLine = Boolean(subject && subject !== email);
  const verifiedLabel = formatVerifiedAt(verifiedAt);

  return (
    <div className="rp-root">
      <div className="rp-card">
        <div className="rp-avatar" aria-hidden="true">
          {initials(label)}
        </div>
        <div className="rp-identity">
          <div className="rp-label">{label}</div>
          {showSubjectLine ? <div className="rp-sub">{subject}</div> : null}
          <div className="rp-scopes">
            {scopes.length > 0 ? (
              scopes.map((scope) => (
                <span key={scope} className="rp-pill">
                  {scope}
                </span>
              ))
            ) : (
              <span className="rp-pill rp-pill-muted">no scopes granted</span>
            )}
          </div>
        </div>
      </div>
      {(clientId || verifiedLabel) && (
        <div className="rp-meta">
          {clientId ? <span>client {clientId}</span> : null}
          {verifiedLabel ? <span>verified {verifiedLabel}</span> : null}
        </div>
      )}
    </div>
  );
}

export default function RadarPing() {
  return (
    <ErrorBoundary>
      <RadarPingView />
    </ErrorBoundary>
  );
}
