/**
 * Swappable GitHub token source. This is the seam: everything else in the
 * app calls `getGitHubToken()` and doesn't care which branch resolved it.
 */

import type { AuthInfo } from "skybridge/server";
import { env } from "./env.js";

export type GitHubTokenSource = "broker" | "env";

export interface GitHubTokenResult {
  token: string;
  source: GitHubTokenSource;
}

/**
 * Thrown when AuthPlane can't vend a GitHub token because the user hasn't
 * connected their GitHub account yet. Carries the URL to send them to, so
 * the caller can say "connect your GitHub account here" instead of just
 * failing. Deliberately NOT caught by `getGitHubToken`'s fallback — this is
 * an action for the user, not a broker outage to route around.
 */
export class ConsentRequiredError extends Error {
  constructor(public readonly consentUrl: string) {
    super(`GitHub connection required: ${consentUrl}`);
    this.name = "ConsentRequiredError";
  }
}

/**
 * Resolves a GitHub access token for the current tool call.
 *
 * - Branch A (preferred): token-exchange the caller's own AuthPlane token
 *   for a real GitHub token (RFC 8693), so PR Radar acts as the signed-in
 *   user rather than a shared server-side PAT. The user's GitHub refresh
 *   token stays encrypted inside AuthPlane and never reaches this server —
 *   only a short-lived access token crosses the wire, per call.
 * - Branch B (fallback): `env.GITHUB_TOKEN`, used when Branch A isn't
 *   applicable (no broker configured, no subject token on this request) or
 *   when it fails for a reason other than missing consent — and only when
 *   `env.ALLOW_ENV_TOKEN_FALLBACK` is enabled. With the flag off, any of
 *   those conditions falls straight through to the "no GitHub token
 *   available" error below instead of substituting the operator's PAT.
 *
 * `extra` is the tool handler's `extra` (RequestHandlerExtra), passed
 * through untyped; Branch A reads the caller's AuthPlane access token off
 * `extra.authInfo.token`.
 */
export async function getGitHubToken(extra: unknown): Promise<GitHubTokenResult> {
  let fallbackReason = "unknown reason";

  try {
    const result = await exchangeForGitHubToken(extra);
    if (result.ok) {
      return { token: result.token, source: "broker" };
    }
    fallbackReason = result.reason;
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      throw err;
    }
    console.warn("AuthPlane token exchange failed:", err);
    fallbackReason = `AuthPlane token exchange threw: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (env.ALLOW_ENV_TOKEN_FALLBACK && env.GITHUB_TOKEN) {
    console.warn(`Using GITHUB_TOKEN fallback (${fallbackReason}).`);
    return { token: env.GITHUB_TOKEN, source: "env" };
  }

  throw new Error(
    `GitHub token broker exchange failed (${fallbackReason}). This is a server-side problem, not a missing GitHub connection — reconnecting will not fix it. For local development only, set GITHUB_TOKEN and ALLOW_ENV_TOKEN_FALLBACK in .env.`,
  );
}

/**
 * Branch A: an RFC 8693 token exchange against AuthPlane, trading the
 * caller's own AuthPlane access token for a GitHub token scoped to them.
 * (RFC 8693 inherits RFC 8707's requirement that `resource` be an absolute
 * URI; AuthPlane addresses brokers by resource slug here instead, so the
 * `resource: "github"` below is their API contract, not an RFC 8707 URI.)
 *
 * Returns `{ ok: false, reason }` (no throw) when the exchange plainly isn't
 * applicable — no subject token on this request, or no broker client
 * configured — or when AuthPlane answers 2xx with no `access_token` in the
 * body. `reason` names which of those it was, so `getGitHubToken` can log it
 * if it ends up using the env fallback; either way this function stays
 * quiet itself and lets the caller decide. Throws `ConsentRequiredError`
 * when the user needs to connect GitHub, and a plain `Error` for any other
 * non-2xx response.
 */
async function exchangeForGitHubToken(
  extra: unknown,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const clientId = env.AUTHPLANE_CLIENT_ID;
  const clientSecret = env.AUTHPLANE_CLIENT_SECRET;
  const subjectToken = (extra as { authInfo?: AuthInfo } | null | undefined)?.authInfo?.token;
  if (!subjectToken || !clientId || !clientSecret) {
    return {
      ok: false,
      reason: "no subject token on this request, or no broker client configured (AUTHPLANE_CLIENT_ID/AUTHPLANE_CLIENT_SECRET)",
    };
  }

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    // subject_token: WHO is asking — the end user's own AuthPlane access
    // token, i.e. their verified identity for this call.
    subject_token: subjectToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    // resource: WHICH upstream we want a token for. AuthPlane looks up this
    // user's stored GitHub connection and mints a scoped token from it —
    // their GitHub refresh token never leaves AuthPlane.
    resource: "github",
    // scope: WHAT we're asking to do there — public_repo, not repo: every
    // tracked PR lives in a public repo, so we don't ask for repo's
    // implicit private-repo read/write.
    scope: "public_repo",
  });

  // client_secret_basic: this server authenticates itself to AuthPlane with
  // HTTP Basic auth, separately from the user's own subject_token above.
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(`${env.AUTHPLANE_ISSUER}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body,
  });

  if (!response.ok) {
    const raw = await response.text();
    const consentUrl = extractConsentUrl(raw);
    if (consentUrl) {
      throw new ConsentRequiredError(consentUrl);
    }
    throw new Error(`AuthPlane token exchange failed: ${response.status} ${raw.slice(0, 300)}`);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    return { ok: false, reason: "AuthPlane returned 2xx with no access_token in the response body" };
  }
  return { ok: true, token: data.access_token };
}

/** Pulls `consent_url`/`consent_uri` out of an AuthPlane `consent_required` error body, if present. */
function extractConsentUrl(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { error?: string; consent_url?: string; consent_uri?: string };
    if (parsed.error !== "consent_required") {
      return null;
    }
    return parsed.consent_url ?? parsed.consent_uri ?? null;
  } catch {
    return null;
  }
}
