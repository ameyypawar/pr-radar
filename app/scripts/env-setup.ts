/**
 * Test preload only (see app/package.json "test" script). `env.ts` reads
 * `process.env` once at module import and throws on a missing
 * AUTHPLANE_ISSUER/SERVER_URL, so anything that transitively imports it —
 * including github-token.ts and server.ts — needs both set before that
 * first import happens. `--import` runs this ahead of `--test`'s file
 * collection, in the same process, so it lands before any test file's
 * module graph pulls env.ts in.
 *
 * Fixed dummy values, not read from the environment: tests should not
 * depend on whatever the ambient shell happens to export.
 */
process.env.AUTHPLANE_ISSUER = "http://localhost:9000";
process.env.SERVER_URL = "http://localhost:3000/mcp";
