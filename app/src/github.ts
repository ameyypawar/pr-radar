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
    search(query: $q, type: ISSUE, first: 40) {
      issueCount
      nodes {
        ... on PullRequest {
          number title url isDraft createdAt updatedAt
          repository { nameWithOwner }
          reviewDecision
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          comments(last: 1) { totalCount nodes { author { login } createdAt } }
          reviews(last: 1) { totalCount nodes { author { login } state } }
        }
      }
    }
  }
`;

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
  comments: {
    totalCount: number;
    nodes: ({ author: { login: string } | null; createdAt: string } | null)[] | null;
  } | null;
  reviews: {
    totalCount: number;
    nodes: ({ author: { login: string } | null; state: string } | null)[] | null;
  } | null;
}

export interface FetchOpenPullRequestsResult {
  /** True count of every open PR matching the search, per GitHub — can exceed `prs.length` since the query caps at 40 nodes. */
  issueCount: number;
  /** Up to 40 fetched PR nodes. */
  prs: RawPullRequest[];
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

  const prs = (search.nodes ?? []).filter(
    (node): node is RawPullRequest =>
      !!node && typeof node.number === "number" && typeof node.url === "string" && typeof node.updatedAt === "string",
  );

  const login = json.data?.viewer?.login;

  return { issueCount: search.issueCount, prs, login };
}
