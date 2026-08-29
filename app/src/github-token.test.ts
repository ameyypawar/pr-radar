/**
 * Branch matrix for `getGitHubToken()`: the consent-URL scheme allowlist,
 * the `consent_uri` fallback, and the `ALLOW_ENV_TOKEN_FALLBACK` gate
 * (including the case where a `ConsentRequiredError` must beat it).
 *
 * ## The frozen-flag problem
 *
 * `env.ts` snapshots `process.env` once at import, so
 * `env.ALLOW_ENV_TOKEN_FALLBACK` and the AUTHPLANE_CLIENT_ID/SECRET/
 * GITHUB_TOKEN fields below are fixed values baked into the `env` object
 * the first time anything imports it. Mutating `process.env` afterwards
 * does nothing.
 *
 * Neither option suggested for this normally applies here:
 *
 * - Cache-busting dynamic import (`import("./github-token.js?n")`) gives a
 *   fresh top-level evaluation of github-token.ts, but its own
 *   `import { env } from "./env.js"` is a bare, unparameterized specifier —
 *   Node's ESM cache keys on the resolved URL of THAT import, not on
 *   whatever query string got the importer loaded. Every fresh copy of
 *   github-token.ts still reads the one `env.js` module record already
 *   cached in this process. Confirmed empirically with a throwaway
 *   two-module repro (a consumer with a bare import of a dependency whose
 *   flag is read at call time): busting the consumer's specifier left the
 *   dependency's value unchanged; only busting the dependency's OWN
 *   specifier directly picked up a new value, and that path is closed to
 *   us — we can't edit github-token.ts's import statement.
 * - `node:test`'s `mock.module()` would sidestep that (it intercepts by
 *   resolved target, not specifier text), but it requires
 *   `--experimental-test-module-mocks`. `typeof mock.module` is
 *   `"undefined"` under plain `node --test` on this Node 24.20.0 binary,
 *   and the fixed `npm test` command doesn't pass the flag — confirmed by
 *   running it directly, not assumed from docs.
 *
 * What actually works: `env` (env.ts) is a plain object literal, never
 * `Object.freeze`d. This file imports the exact same singleton
 * github-token.ts does — both resolve the identical bare `"./env.js"`
 * specifier — and mutates its properties directly before each case.
 * `getGitHubToken()` reads `env.ALLOW_ENV_TOKEN_FALLBACK` / `env.GITHUB_TOKEN`
 * fresh on every call, not a value closed over at import, so the mutation
 * is live immediately. This is not a race: `node --test` isolates each
 * *file* into its own process (verified: two files, one sets a global, the
 * other sees it undefined, distinct PIDs), and this file's top-level tests
 * run sequentially, not concurrently (verified: two tests each hold a
 * shared value across an `await` delay and both still see their own value
 * on the other side of it). `afterEach` restores the originals so no case
 * leaks into the next.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getGitHubToken, ConsentRequiredError } from "./github-token.js";
import { env } from "./env.js";

type FetchMock = (...args: Parameters<typeof fetch>) => Promise<Response>;

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  AUTHPLANE_CLIENT_ID: env.AUTHPLANE_CLIENT_ID,
  AUTHPLANE_CLIENT_SECRET: env.AUTHPLANE_CLIENT_SECRET,
  GITHUB_TOKEN: env.GITHUB_TOKEN,
  ALLOW_ENV_TOKEN_FALLBACK: env.ALLOW_ENV_TOKEN_FALLBACK,
};

/** `extra` shaped so Branch A sees a subject token and actually runs. */
const WITH_SUBJECT_TOKEN: unknown = { authInfo: { token: "test-subject-token" } };

/**
 * Pins every env field `getGitHubToken()` reads, explicitly, for one case —
 * no defaults, so no case can inherit ambient state left by a previous one.
 */
function setBrokerEnv(opts: {
  clientId: string | undefined;
  clientSecret: string | undefined;
  allowFallback: boolean;
  token: string | undefined;
}): void {
  env.AUTHPLANE_CLIENT_ID = opts.clientId;
  env.AUTHPLANE_CLIENT_SECRET = opts.clientSecret;
  env.ALLOW_ENV_TOKEN_FALLBACK = opts.allowFallback;
  env.GITHUB_TOKEN = opts.token;
}

/** Stubs global fetch to resolve once with a JSON body at the given status. */
function mockFetchJson(body: unknown, status = 400): void {
  const impl: FetchMock = async (..._args) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = impl;
}

describe("getGitHubToken", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    env.AUTHPLANE_CLIENT_ID = ORIGINAL_ENV.AUTHPLANE_CLIENT_ID;
    env.AUTHPLANE_CLIENT_SECRET = ORIGINAL_ENV.AUTHPLANE_CLIENT_SECRET;
    env.GITHUB_TOKEN = ORIGINAL_ENV.GITHUB_TOKEN;
    env.ALLOW_ENV_TOKEN_FALLBACK = ORIGINAL_ENV.ALLOW_ENV_TOKEN_FALLBACK;
  });

  test("a consent_required body whose consent_url is javascript:alert(1) is rejected", async () => {
    setBrokerEnv({ clientId: "client-id", clientSecret: "client-secret", allowFallback: false, token: undefined });
    mockFetchJson({ error: "consent_required", consent_url: "javascript:alert(1)" });

    await assert.rejects(
      () => getGitHubToken(WITH_SUBJECT_TOKEN),
      (err: unknown) => {
        assert.ok(
          !(err instanceof ConsentRequiredError),
          "javascript: consent_url must not produce a ConsentRequiredError — .consentUrl is rendered as an href",
        );
        return true;
      },
    );
  });

  test("consent_uri is honoured when consent_url is absent", async () => {
    setBrokerEnv({ clientId: "client-id", clientSecret: "client-secret", allowFallback: false, token: undefined });
    mockFetchJson({ error: "consent_required", consent_uri: "https://example.com/connect-2" });

    await assert.rejects(
      () => getGitHubToken(WITH_SUBJECT_TOKEN),
      (err: unknown) => {
        if (!(err instanceof ConsentRequiredError)) {
          assert.fail(`expected ConsentRequiredError, got ${String(err)}`);
        }
        assert.equal(err.consentUrl, "https://example.com/connect-2");
        return true;
      },
    );
  });

  test("fallback flag off, with GITHUB_TOKEN present, throws rather than using the token", async () => {
    setBrokerEnv({ clientId: undefined, clientSecret: undefined, allowFallback: false, token: "env-token-value" });
    const impl: FetchMock = async () => {
      throw new Error("fetch must not be called when no broker client is configured");
    };
    globalThis.fetch = impl;

    await assert.rejects(() => getGitHubToken(undefined), /GitHub token broker exchange failed/);
  });

  test("ConsentRequiredError propagates even with the fallback flag on and a token present", async () => {
    setBrokerEnv({ clientId: "client-id", clientSecret: "client-secret", allowFallback: true, token: "env-token-value" });
    mockFetchJson({ error: "consent_required", consent_url: "https://example.com/connect-4" });

    await assert.rejects(
      () => getGitHubToken(WITH_SUBJECT_TOKEN),
      (err: unknown) => {
        if (!(err instanceof ConsentRequiredError)) {
          assert.fail(`expected ConsentRequiredError to beat the fallback, got ${String(err)}`);
        }
        assert.equal(err.consentUrl, "https://example.com/connect-4");
        return true;
      },
    );
  });

  // Issue #29: extractConsentUrl (github-token.ts) returns null for a
  // consent_required body with no usable consent_url/consent_uri, so
  // exchangeForGitHubToken throws a plain Error instead of
  // ConsentRequiredError, and getGitHubToken's final message tells the user
  // "reconnecting will not fix it" — backwards for exactly this case.
  // Correct behaviour: still throw ConsentRequiredError so the caller can
  // prompt reconnect. Unskip when #29 lands.
  test(
    "consent_required with an unusable consent_url still surfaces as connect-required",
    { skip: 'known defect, issue #29: falls through to the generic "reconnecting will not fix it" error instead' },
    async () => {
      const unusableBodies = [
        { error: "consent_required" },
        { error: "consent_required", consent_url: "/connect" },
        { error: "consent_required", consent_url: "ftp://example.com/connect" },
      ];

      for (const body of unusableBodies) {
        setBrokerEnv({ clientId: "client-id", clientSecret: "client-secret", allowFallback: false, token: undefined });
        mockFetchJson(body);

        await assert.rejects(
          () => getGitHubToken(WITH_SUBJECT_TOKEN),
          (err: unknown) => {
            assert.ok(err instanceof ConsentRequiredError, `expected ConsentRequiredError for ${JSON.stringify(body)}`);
            return true;
          },
        );
      }
    },
  );
});
