/**
 * GitHub data layer. One job: run the verified search query against GitHub's
 * GraphQL API and hand back raw PR nodes. No triage logic here — see
 * `triage.ts` for bucketing.
 */

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/**
 * Verified against live data — do not change the field selection without
 * re-checking it against the GitHub GraphQL schema.
 */
const OPEN_PULL_REQUESTS_QUERY = `
  query($q: String!) {
    viewer { login }
    search(query: $q, type: ISSUE, first: 100) {
      issueCount
      nodes {
        ... on PullRequest {
          number title url isDraft createdAt updatedAt
          repository { nameWithOwner }
          reviewDecision
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        }
      }
    }
  }
`;

// TODO: accounts with more than 100 open PRs need pageInfo { hasNextPage
// endCursor } pagination — first: 100 is GitHub's per-page max for `search`,
// and this fetch only ever requests the one page.

/**
 * One PR node as returned by `OPEN_PULL_REQUESTS_QUERY`. Every nested field
 * can come back null (no CI configured, no reviews yet, deleted author,
 * etc.) — callers must not assume any of it is present.
 */
export interface RawPullRequest {
  number: number;
  title: string | null;
  url: string;
  isDraft: boolean | null;
  createdAt: string;
  updatedAt: string;
  repository: { nameWithOwner: string } | null;
  reviewDecision: string | null;
  commits: {
    nodes: ({ commit: { statusCheckRollup: { state: string } | null } | null } | null)[] | null;
  } | null;
}

export interface FetchOpenPullRequestsResult {
  /** True count of every open PR matching the search, per GitHub — can exceed `prs.length` since the query caps at 100 nodes. */
  issueCount: number;
  /** Up to 100 fetched PR nodes. */
  prs: RawPullRequest[];
  /**
   * True when `issueCount` exceeds `prs.length`, meaning the list is incomplete. This can be
   * true because the page cap (100) dropped nodes, or because malformed nodes were filtered out
   * of `prs` below — either way the rendered list is a subset, so both cases are correctly
   * reported as truncated.
   */
  truncated: boolean;
  /** Login of the token holder, per `viewer.login`. Undefined if the response didn't include it — callers must not assume it is present. */
  login: string | undefined;
}

interface GraphQlErrorPayload {
  message: string;
}

interface GraphQlResponse {
  data?: {
    viewer?: { login: string } | null;
    search?: {
      issueCount: number;
      nodes: (Partial<RawPullRequest> | null)[] | null;
    } | null;
  } | null;
  errors?: GraphQlErrorPayload[];
}

/**
 * Fetches every open PR authored by the holder of `token`, using `token` as
 * the GitHub bearer credential. `author:@me` resolves against that token, so
 * the result set — and the returned `login` — follow whoever the token
 * belongs to. Throws a clear `Error` on a non-200 response or a GraphQL-level
 * `errors` payload; never throws on null/missing nested fields in a
 * successful response.
 */
export async function fetchOpenPullRequests(token: string): Promise<FetchOpenPullRequestsResult> {
  const q = `is:open is:pr author:@me archived:false`;

  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "User-Agent": "pr-radar",
    },
    body: JSON.stringify({ query: OPEN_PULL_REQUESTS_QUERY, variables: { q } }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub GraphQL request failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ""}`,
    );
  }

  const json = (await res.json()) as GraphQlResponse;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`GitHub GraphQL returned errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const search = json.data?.search;
  if (!search) {
    throw new Error("GitHub GraphQL response was missing `data.search` — unexpected response shape.");
  }

  // Structural checks only — number/url must be present and well-typed. createdAt/updatedAt
  // are deliberately NOT validated here: an unparseable date is triage()'s problem to absorb
  // (STALE bucket, null day count, "last update unknown" — see triage.ts), not a reason to drop
  // the PR from the radar. Dropping it would hide it entirely, which reads as good news. See #27.
  const prs = (search.nodes ?? []).filter((node): node is RawPullRequest => {
    return node !== null && typeof node.number === "number" && typeof node.url === "string";
  });

  const login = json.data?.viewer?.login;

  return { issueCount: search.issueCount, prs, truncated: search.issueCount > prs.length, login };
}
