/**
 * Swappable GitHub token source. This is the seam: everything else in the
 * app calls `getGitHubToken()` and doesn't care which branch resolved it.
 */

import { env } from "./env.js";

export type GitHubTokenSource = "broker" | "env";

export interface GitHubTokenResult {
  token: string;
  source: GitHubTokenSource;
}

/**
 * Resolves a GitHub access token for the current tool call.
 *
 * - Branch A (preferred): token-exchange the caller's AuthPlane token for a
 *   real GitHub token. Not wired yet — always returns null for now.
 * - Branch B (fallback, active): `env.GITHUB_TOKEN`.
 *
 * `extra` is the tool handler's `extra` (RequestHandlerExtra), passed
 * through untyped so Branch A can read the caller's AuthPlane access token
 * off `extra.authInfo` once it's wired up.
 */
export async function getGitHubToken(extra: unknown): Promise<GitHubTokenResult> {
  const brokered = await exchangeForGitHubToken(extra);
  if (brokered) {
    return { token: brokered, source: "broker" };
  }

  if (env.GITHUB_TOKEN) {
    return { token: env.GITHUB_TOKEN, source: "env" };
  }

  throw new Error(
    "No GitHub token available. Connect your GitHub account to PR Radar, or set GITHUB_TOKEN in .env for local development.",
  );
}

/**
 * Branch A (stub, not wired). Intended to perform an RFC 8693 token
 * exchange against AuthPlane so PR Radar can act with the signed-in user's
 * own GitHub token instead of a shared server-side PAT.
 *
 * Sketch of the intended call, once wired:
 *
 *   POST `${env.AUTHPLANE_ISSUER}/oauth/token`
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 *   subject_token=<user's AuthPlane access token — from extra.authInfo.token>
 *   subject_token_type=urn:ietf:params:oauth:token-type:access_token
 *   resource=github
 *   requested_token_type=urn:ietf:params:oauth:token-type:access_token
 *
 * A successful response carries the vended GitHub token as `access_token`.
 * Return that on success; return null on any failure (no GitHub connection,
 * expired session, non-200, etc.) so `getGitHubToken` falls through to
 * Branch B instead of throwing.
 */
async function exchangeForGitHubToken(_extra: unknown): Promise<string | null> {
  return null;
}
