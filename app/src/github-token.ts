/**
 * Swappable GitHub token source, with two resolution paths.
 *
 * Path 1 — the normal case: everything calls `getGitHubToken()` and doesn't
 * care whether Branch A (broker exchange) or Branch B (env fallback)
 * resolved the token; both return the same `{ token, source }` shape.
 *
 * Path 2 — consent required: `getGitHubToken()` deliberately does not apply
 * the env fallback itself when the broker throws `ConsentRequiredError` (see
 * that class's doc comment below) — it always rethrows. The one caller,
 * `pr-radar`'s handler in server.ts, decides what to do with that: it
 * reimplements the same `env.ALLOW_ENV_TOKEN_FALLBACK && env.GITHUB_TOKEN`
 * gate to either degrade gracefully with a connect-prompt banner or fail
 * gracefully asking the user to connect. That gate is duplicated verbatim
 * across both files — whoever changes the fallback policy has to update
 * both.
 */

import type { AuthInfo } from "skybridge/server";
import { env } from "./env.js";
import { safeHttpUrl } from "./url-safety.js";

/**
 * Where a resolved GitHub token came from — plus "none" for server.ts's pr-radar handler, when
 * even the env fallback isn't available and nothing is returned at all. One three-value
 * definition, so the output Zod enum (server.ts) and the view's switch (pr-radar.tsx) both derive
 * from it instead of restating the three literals by hand. `getGitHubToken` below only ever
 * returns "broker" or "env" (it throws rather than producing "none"); the type stays the full
 * three so every consumer of "where did this token come from" shares one definition. See #59.
 */
export const GITHUB_TOKEN_SOURCES = ["broker", "env", "none"] as const;
export type GitHubTokenSource = (typeof GITHUB_TOKEN_SOURCES)[number];

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

  console.error(
    `GitHub token broker exchange failed (${fallbackReason}). No GITHUB_TOKEN fallback available (set GITHUB_TOKEN and ALLOW_ENV_TOKEN_FALLBACK in .env to enable one for local development).`,
  );
  throw new Error(
    "GitHub token broker exchange failed. This is a server-side problem, not a missing GitHub connection — reconnecting will not fix it. Try again shortly, or contact whoever administers this server if it persists.",
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
    signal: AbortSignal.timeout(10_000),
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

/**
 * Pulls a consent URL out of an AuthPlane `consent_required` error body — always resolving to a
 * safe, usable URL when the body IS a consent_required error, so `null` means exactly one thing:
 * "this was not a consent_required error" (unparseable body, or a different `error` value). That
 * distinction matters to the caller: `null` falls through to the generic broker-failure error,
 * anything else throws `ConsentRequiredError` (see #29 — the two cases were previously conflated,
 * so a consent error with no usable URL was indistinguishable from a non-consent failure, and the
 * user was told reconnecting would not help when it was exactly the fix).
 *
 * `consent_url`/`consent_uri`, when present, is resolved against `env.AUTHPLANE_ISSUER` as the
 * base — recovering the common case where AuthPlane sends a relative path like "/connect/github"
 * — through `safeHttpUrl()` (url-safety.ts), the same http(s)-only scheme allowlist used for
 * GitHub PR URLs (see #66). Not Zod's `.url()`: `.url()` is not a substitute, since it accepts
 * `javascript:alert(1)` as a valid URL — it checks well-formedness, not scheme. This allowlist is
 * unchanged by #29 and gates the actual returned value either way — an absolute candidate is
 * checked as-is (`new URL` ignores the base once the candidate is already absolute), so a hostile
 * or malformed scheme is rejected exactly as before.
 *
 * What #29 changes is what happens on rejection: a missing, malformed, or disallowed-scheme
 * candidate no longer collapses to `null` (which the caller would mistake for "not a consent
 * error"). It still IS a consent_required error, so this falls back to `env.AUTHPLANE_ISSUER`
 * itself — a trusted, developer-configured value, never the rejected candidate — so the caller
 * can still send the user to connect GitHub instead of reporting an unfixable server-side
 * problem. The raw candidate is never returned once it fails the allowlist.
 */
function extractConsentUrl(rawBody: string): string | null {
  let parsed: { error?: string; consent_url?: string; consent_uri?: string };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (parsed.error !== "consent_required") {
    return null;
  }

  const candidate = parsed.consent_url ?? parsed.consent_uri ?? null;
  if (candidate !== null) {
    // Malformed, or resolves to a disallowed scheme — either way `safeHttpUrl` returns null and
    // this falls through to the issuer fallback below rather than returning null itself.
    const safe = safeHttpUrl(candidate, env.AUTHPLANE_ISSUER);
    if (safe !== null) {
      return safe;
    }
  }

  return env.AUTHPLANE_ISSUER;
}
