/**
 * Validated environment variables. Import `env` instead of touching
 * `process.env` directly — every key here is guaranteed present at runtime.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in .env (see .env.example) before starting the server.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const env = {
  /** AuthPlane authorization server issuer, e.g. http://localhost:9000 */
  AUTHPLANE_ISSUER: required("AUTHPLANE_ISSUER"),
  /** AuthPlane OAuth client ID for the RFC 8693 token-exchange broker (Branch A). Optional — without it, `getGitHubToken()` skips straight to `GITHUB_TOKEN`. */
  AUTHPLANE_CLIENT_ID: optional("AUTHPLANE_CLIENT_ID"),
  /** AuthPlane OAuth client secret for the RFC 8693 token-exchange broker (Branch A). Optional, paired with `AUTHPLANE_CLIENT_ID`. */
  AUTHPLANE_CLIENT_SECRET: optional("AUTHPLANE_CLIENT_SECRET"),
  /** This server's public resource URL, e.g. http://localhost:3000/mcp */
  SERVER_URL: required("SERVER_URL"),
  /** GitHub PAT fallback for local dev. Optional — prefer `getGitHubToken()` over reading this directly. */
  GITHUB_TOKEN: optional("GITHUB_TOKEN"),
  /** GitHub login (username). No longer read on the broker path — `fetchOpenPullRequests` now searches `author:@me` and reads `viewer.login` from the token itself. Kept for a possible future `GITHUB_TOKEN` env-fallback identity story. */
  GITHUB_LOGIN: optional("GITHUB_LOGIN"),
};
