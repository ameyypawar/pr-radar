/**
 * Validated environment variables. Import `env` instead of touching
 * `process.env` directly — every key here is guaranteed present at runtime.
 */

// Skybridge passes the inherited process environment to the server and does not
// read .env itself, so the app loads it. Absent in deployment, where the platform
// supplies the variables directly.
try {
  process.loadEnvFile();
} catch {
  // no .env on disk — deployment supplies the environment
}

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

/** Boolean-ish env var: only the exact strings "true" or "1" are enabled. Unset or any other value is disabled. */
function flag(name: string): boolean {
  const value = process.env[name];
  return value === "true" || value === "1";
}

export const env = {
  /** AuthPlane authorization server issuer, e.g. http://localhost:9000 */
  AUTHPLANE_ISSUER: required("AUTHPLANE_ISSUER"),
  /** AuthPlane OAuth client ID for the RFC 8693 token-exchange broker (Branch A). Optional — without it, the exchange is skipped and `getGitHubToken()` fails unless `ALLOW_ENV_TOKEN_FALLBACK` is set (see below). */
  AUTHPLANE_CLIENT_ID: optional("AUTHPLANE_CLIENT_ID"),
  /** AuthPlane OAuth client secret for the RFC 8693 token-exchange broker (Branch A). Optional, paired with `AUTHPLANE_CLIENT_ID`. */
  AUTHPLANE_CLIENT_SECRET: optional("AUTHPLANE_CLIENT_SECRET"),
  /** This server's public resource URL, e.g. http://localhost:3000/mcp */
  SERVER_URL: required("SERVER_URL"),
  /** GitHub PAT fallback for local dev. Optional — prefer `getGitHubToken()` over reading this directly. Only used when `ALLOW_ENV_TOKEN_FALLBACK` is enabled. */
  GITHUB_TOKEN: optional("GITHUB_TOKEN"),
  /**
   * Local-development escape hatch. Enables the `GITHUB_TOKEN` fallback in `getGitHubToken()`
   * (app/src/github-token.ts) and the consent-required fallback branch in the `pr-radar` tool
   * handler (app/src/server.ts) — without it, both paths hard-fail instead of silently
   * substituting the operator's long-lived PAT for the caller's own `radar:read`-scoped access.
   * Must stay unset in any deployment. Only the exact strings "true" or "1" enable it; anything
   * else, including unset, is disabled.
   */
  ALLOW_ENV_TOKEN_FALLBACK: flag("ALLOW_ENV_TOKEN_FALLBACK"),
};
