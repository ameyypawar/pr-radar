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

export const env = {
  /** AuthPlane authorization server issuer, e.g. http://localhost:9000 */
  AUTHPLANE_ISSUER: required("AUTHPLANE_ISSUER"),
  /** This server's public resource URL, e.g. http://localhost:3000/mcp */
  SERVER_URL: required("SERVER_URL"),
};
