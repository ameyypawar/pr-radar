/**
 * Tests for `triage()` and `sortPullRequestSummaries()` — app/src/triage.ts.
 *
 * All fixtures are built against a fixed `now` passed through triage()'s
 * injectable second parameter. No `Date.now()`, no clock mocking.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { triage, sortPullRequestSummaries, type Bucket, type PullRequestSummary } from "./triage.js";
import type { RawPullRequest } from "./github.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-01-15T12:00:00.000Z");

/** ISO string exactly `days` * 24h before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW - days * MS_PER_DAY).toISOString();
}

/**
 * Valid RawPullRequest with sane defaults; each case overrides only what it
 * needs. Defaults land in WAITING_ON_MAINTAINER: not a draft, no review
 * decision, passing CI, updated 5 days ago (inside the 14-day stale window).
 */
function makeRawPR(overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number: 1,
    title: "Test PR",
    url: "https://github.com/owner/repo/pull/1",
    isDraft: false,
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
    repository: { nameWithOwner: "owner/repo" },
    reviewDecision: null,
    commits: {
      nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
    },
    ...overrides,
  };
}

/** Builds the nested commits/statusCheckRollup override for a given CI state; null models "no rollup". */
function withCiState(state: string | null): Pick<RawPullRequest, "commits"> {
  return {
    commits: {
      nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }],
    },
  };
}

describe("triage() — bucket precedence", () => {
  it("draft + failing CI buckets as DRAFT, not BLOCKED_ON_YOU", () => {
    const pr = makeRawPR({ isDraft: true, ...withCiState("FAILURE") });
    assert.equal(triage(pr, NOW).bucket, "DRAFT");
  });

  it("draft + changes-requested buckets as DRAFT", () => {
    const pr = makeRawPR({ isDraft: true, reviewDecision: "CHANGES_REQUESTED" });
    assert.equal(triage(pr, NOW).bucket, "DRAFT");
  });

  it("changes-requested + 30 days old buckets as BLOCKED_ON_YOU, not STALE", () => {
    const pr = makeRawPR({ reviewDecision: "CHANGES_REQUESTED", updatedAt: daysAgo(30) });
    assert.equal(triage(pr, NOW).bucket, "BLOCKED_ON_YOU");
  });

  it("failing CI + 30 days old buckets as BLOCKED_ON_YOU", () => {
    const pr = makeRawPR({ updatedAt: daysAgo(30), ...withCiState("FAILURE") });
    assert.equal(triage(pr, NOW).bucket, "BLOCKED_ON_YOU");
  });
});

describe("triage() — stale boundary", () => {
  const cases: { days: number; expectedBucket: Bucket; expectedStaleDays: number }[] = [
    { days: 13, expectedBucket: "WAITING_ON_MAINTAINER", expectedStaleDays: 13 },
    { days: 14, expectedBucket: "STALE", expectedStaleDays: 14 }, // regression case ff23d0e
    { days: 15, expectedBucket: "STALE", expectedStaleDays: 15 },
  ];

  for (const { days, expectedBucket, expectedStaleDays } of cases) {
    it(`exactly ${days} days since update -> ${expectedBucket}`, () => {
      const summary = triage(makeRawPR({ updatedAt: daysAgo(days) }), NOW);
      assert.equal(summary.staleDays, expectedStaleDays);
      assert.equal(summary.bucket, expectedBucket);
    });
  }
});

describe("triage() — CI state handling", () => {
  const blockingStates = ["FAILURE", "ERROR"];
  for (const state of blockingStates) {
    it(`CI state ${state} is blocking -> BLOCKED_ON_YOU`, () => {
      const summary = triage(makeRawPR(withCiState(state)), NOW);
      assert.equal(summary.ciState, state);
      assert.equal(summary.bucket, "BLOCKED_ON_YOU");
    });
  }

  const nonBlockingCases: { name: string; state: string | null }[] = [
    { name: "SUCCESS", state: "SUCCESS" },
    { name: "PENDING", state: "PENDING" },
    { name: "EXPECTED", state: "EXPECTED" },
    { name: "null rollup (no CI configured)", state: null },
  ];
  for (const { name, state } of nonBlockingCases) {
    it(`CI state ${name} is non-blocking -> WAITING_ON_MAINTAINER`, () => {
      const summary = triage(makeRawPR(withCiState(state)), NOW);
      assert.equal(summary.ciState, state);
      assert.equal(summary.bucket, "WAITING_ON_MAINTAINER");
    });
  }
});

describe("triage() — null-safety fallbacks", () => {
  const cases: {
    name: string;
    overrides: Partial<RawPullRequest>;
    pick: (s: PullRequestSummary) => unknown;
    expected: unknown;
  }[] = [
    {
      name: "absent repository falls back to unknown/unknown",
      overrides: { repository: null },
      pick: (s) => s.repo,
      expected: "unknown/unknown",
    },
    {
      name: "absent title falls back to (untitled)",
      overrides: { title: null },
      pick: (s) => s.title,
      expected: "(untitled)",
    },
  ];

  for (const { name, overrides, pick, expected } of cases) {
    it(name, () => {
      const summary = triage(makeRawPR(overrides), NOW);
      assert.equal(pick(summary), expected);
    });
  }
});

describe("triage() — unparseable updatedAt", () => {
  // fetchOpenPullRequests() no longer filters on date parsability (issue #27) — it only checks
  // that number/url are well-typed. A PR with an unparseable updatedAt now reaches triage()
  // exactly like this fixture does, so this path is reachable in production.
  it("unparseable updatedAt buckets as STALE with staleDays: null", () => {
    const summary = triage(makeRawPR({ updatedAt: "not-a-date" }), NOW);
    assert.equal(summary.staleDays, null);
    assert.equal(summary.bucket, "STALE");
  });
});

describe("sortPullRequestSummaries()", () => {
  /** Valid PullRequestSummary with sane defaults; each case overrides only what it needs. */
  function makeSummary(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
    return {
      number: 1,
      title: "PR",
      url: "https://github.com/owner/repo/pull/1",
      repo: "owner/repo",
      bucket: "WAITING_ON_MAINTAINER",
      isDraft: false,
      reviewDecision: null,
      ciState: null,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
      ageDays: 5,
      staleDays: 5,
      ...overrides,
    };
  }

  it("sorts by bucket first: BLOCKED_ON_YOU, STALE, WAITING_ON_MAINTAINER, DRAFT", () => {
    const input = [
      makeSummary({ number: 1, bucket: "DRAFT" }),
      makeSummary({ number: 2, bucket: "WAITING_ON_MAINTAINER" }),
      makeSummary({ number: 3, bucket: "STALE" }),
      makeSummary({ number: 4, bucket: "BLOCKED_ON_YOU" }),
    ];
    const sorted = sortPullRequestSummaries(input);
    assert.deepEqual(
      sorted.map((s) => s.bucket),
      ["BLOCKED_ON_YOU", "STALE", "WAITING_ON_MAINTAINER", "DRAFT"],
    );
  });

  it("sorts by recency within a bucket, most recently updated first", () => {
    const input = [
      makeSummary({ number: 1, bucket: "STALE", updatedAt: daysAgo(20) }),
      makeSummary({ number: 2, bucket: "STALE", updatedAt: daysAgo(14) }),
      makeSummary({ number: 3, bucket: "STALE", updatedAt: daysAgo(90) }),
    ];
    const sorted = sortPullRequestSummaries(input);
    assert.deepEqual(
      sorted.map((s) => s.number),
      [2, 1, 3],
    );
  });

  it("an unparseable updatedAt sorts last within its bucket instead of corrupting the comparator", () => {
    const input = [
      makeSummary({ number: 1, bucket: "BLOCKED_ON_YOU", updatedAt: "not-a-date" }),
      makeSummary({ number: 2, bucket: "BLOCKED_ON_YOU", updatedAt: daysAgo(1) }),
      makeSummary({ number: 3, bucket: "BLOCKED_ON_YOU", updatedAt: daysAgo(10) }),
    ];
    const sorted = sortPullRequestSummaries(input);
    assert.deepEqual(
      sorted.map((s) => s.number),
      [2, 3, 1],
    );
  });

  it("does not mutate the input array", () => {
    const input = [makeSummary({ number: 1, bucket: "DRAFT" }), makeSummary({ number: 2, bucket: "BLOCKED_ON_YOU" })];
    const inputOrderBefore = input.map((s) => s.number);

    const sorted = sortPullRequestSummaries(input);

    assert.notEqual(sorted, input);
    assert.deepEqual(
      input.map((s) => s.number),
      inputOrderBefore,
    );
  });
});
