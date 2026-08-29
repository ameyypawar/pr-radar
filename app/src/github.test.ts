/**
 * Tests for `fetchOpenPullRequests()` — the GraphQL response handling in
 * `github.ts`. `fetch` is mocked per test; no network calls are made.
 * See issue #58, suite 2.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchOpenPullRequests, type RawPullRequest } from "./github.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A well-formed `RawPullRequest` node, built from the real shape declared in
 * `github.ts` — no invented fields. Callers override only what a case needs.
 */
function goodNode(overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number: 1,
    title: "Fix flaky retry logic",
    url: "https://github.com/octocat/demo/pull/1",
    isDraft: false,
    createdAt: "2026-08-01T12:00:00Z",
    updatedAt: "2026-08-15T09:30:00Z",
    repository: { nameWithOwner: "octocat/demo" },
    reviewDecision: "REVIEW_REQUIRED",
    commits: {
      nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
    },
    ...overrides,
  };
}

interface BuildResponseBodyOptions {
  /** Defaults to a single well-formed node. */
  nodes?: (Partial<RawPullRequest> | null)[];
  /** Defaults to `nodes.length`. */
  issueCount?: number;
  /** Defaults to `{ login: "octocat" }`. */
  viewer?: { login: string };
  /** Drops `data.viewer` entirely, rather than nulling it. */
  omitViewer?: boolean;
  /** Drops `data.search` entirely, rather than nulling it. */
  omitSearch?: boolean;
  /** GraphQL-level `errors` array. Absent by default. */
  errors?: { message: string }[];
}

/**
 * Builds a valid `OPEN_PULL_REQUESTS_QUERY` response body, happy-path by
 * default (one well-formed PR, a viewer, no errors). Each test passes only
 * the options it needs to deviate on.
 */
function buildResponseBody(options: BuildResponseBodyOptions = {}): unknown {
  const nodes = options.nodes ?? [goodNode()];

  const data: Record<string, unknown> = {};
  if (!options.omitViewer) {
    data.viewer = options.viewer ?? { login: "octocat" };
  }
  if (!options.omitSearch) {
    data.search = { issueCount: options.issueCount ?? nodes.length, nodes };
  }

  const body: Record<string, unknown> = { data };
  if (options.errors) {
    body.errors = options.errors;
  }
  return body;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("a malformed node sets truncated even below the page cap", async () => {
  const wellFormed = goodNode({ number: 101 });
  const malformed = goodNode({ number: 102, updatedAt: "not-a-real-date" });

  globalThis.fetch = async () =>
    jsonResponse(buildResponseBody({ issueCount: 2, nodes: [wellFormed, malformed] }));

  const result = await fetchOpenPullRequests("token");

  assert.equal(result.issueCount, 2);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].number, 101);
  assert.equal(result.truncated, true);
});

test("a non-empty errors array throws with the joined messages", async () => {
  globalThis.fetch = async () =>
    jsonResponse(buildResponseBody({ errors: [{ message: "boom" }, { message: "bang" }] }));

  await assert.rejects(fetchOpenPullRequests("token"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "GitHub GraphQL returned errors: boom; bang");
    return true;
  });
});

test("a body with no data.search throws the explicit unexpected-shape error", async () => {
  globalThis.fetch = async () => jsonResponse(buildResponseBody({ omitSearch: true }));

  await assert.rejects(fetchOpenPullRequests("token"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(
      err.message,
      "GitHub GraphQL response was missing `data.search` — unexpected response shape.",
    );
    return true;
  });
});

test("an absent viewer yields an undefined login and does not crash", async () => {
  globalThis.fetch = async () => jsonResponse(buildResponseBody({ omitViewer: true }));

  const result = await fetchOpenPullRequests("token");

  assert.equal(result.login, undefined);
  assert.equal(result.prs.length, 1);
  assert.equal(result.truncated, false);
});

test("a non-200 response throws with the status and a truncated body", async () => {
  const body = `${"x".repeat(500)}TRUNCATION_MARKER`;

  globalThis.fetch = async () =>
    new Response(body, { status: 500, statusText: "Internal Server Error" });

  await assert.rejects(fetchOpenPullRequests("token"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /^GitHub GraphQL request failed: 500 Internal Server Error — /);
    assert.ok(err.message.includes("x".repeat(500)));
    assert.ok(!err.message.includes("TRUNCATION_MARKER"));
    return true;
  });
});
