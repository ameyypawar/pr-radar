import { authplaneProvider, McpServer } from "skybridge/server";
import { z } from "zod";
import { env } from "./env.js";
import { getGitHubToken } from "./github-token.js";
import { fetchOpenPullRequests } from "./github.js";
import type { Bucket, PullRequestSummary } from "./triage.js";
import { sortPullRequestSummaries, triage } from "./triage.js";

const KNOWN_BUCKETS: Bucket[] = ["BLOCKED_ON_YOU", "STALE", "WAITING_ON_MAINTAINER", "DRAFT"];

function isBucket(value: unknown): value is Bucket {
  return typeof value === "string" && (KNOWN_BUCKETS as string[]).includes(value);
}

function countByBucket(prs: PullRequestSummary[]) {
  return {
    blockedOnYou: prs.filter((pr) => pr.bucket === "BLOCKED_ON_YOU").length,
    waitingOnMaintainer: prs.filter((pr) => pr.bucket === "WAITING_ON_MAINTAINER").length,
    stale: prs.filter((pr) => pr.bucket === "STALE").length,
    draft: prs.filter((pr) => pr.bucket === "DRAFT").length,
  };
}

/** One-line, model-readable summary of what needs the user's attention. */
function summarize(totalCount: number, prs: PullRequestSummary[]): string {
  if (totalCount === 0) {
    return "You have no open pull requests.";
  }
  const blocked = prs.filter((pr) => pr.bucket === "BLOCKED_ON_YOU");
  const changesRequested = blocked.filter((pr) => pr.reviewDecision === "CHANGES_REQUESTED").length;
  const failingCi = blocked.filter((pr) => pr.ciState === "FAILURE").length;
  return `${blocked.length} of ${totalCount} open PRs need you: ${changesRequested} with changes requested, ${failingCi} with failing CI.`;
}

const server = new McpServer(
  { name: "pr-radar", version: "0.1.0" },
  { capabilities: {} },
  {
    oauth: await authplaneProvider<{ email?: string }>({
      issuer: env.AUTHPLANE_ISSUER,
      resource: env.SERVER_URL,
    }),
  },
).registerTool(
  {
    name: "radar-ping",
    description:
      "Verify the signed-in identity for PR Radar. Returns who you are according to the authorization server.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
    auth: { scopes: ["radar:read"] },
    view: { component: "radar-ping", description: "Signed-in identity card" },
  },
  (_input, extra) => {
    const subject = extra.authInfo?.extra?.subject;
    const email = extra.authInfo?.extra?.email;
    const scopes = extra.authInfo?.scopes ?? [];
    const clientId = extra.authInfo?.clientId;
    return {
      structuredContent: { subject, email, scopes, clientId, verifiedAt: new Date().toISOString() },
      content: [{ type: "text" as const, text: `Signed in as ${email ?? subject ?? "unknown"}` }],
      isError: false,
    };
  },
)
  .registerTool(
    {
      name: "pr-radar",
      description:
        "List your open GitHub pull requests, triaged by who needs to act next: blocked on you (changes requested or failing CI), stale (no activity in 14+ days), waiting on a maintainer, or draft.",
      inputSchema: {
        bucket: z
          .string()
          .optional()
          .describe(
            "Optional filter: BLOCKED_ON_YOU, STALE, WAITING_ON_MAINTAINER, or DRAFT. Omit to return every open PR.",
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      auth: { scopes: ["radar:read"] },
      view: { component: "pr-radar", description: "Open PRs triaged by who needs to act next" },
    },
    async (input, extra) => {
      if (!env.GITHUB_LOGIN) {
        throw new Error("GITHUB_LOGIN is not set. Add it to .env before calling pr-radar.");
      }

      const { token, source } = await getGitHubToken(extra);
      const { issueCount, prs: rawPrs } = await fetchOpenPullRequests(token, env.GITHUB_LOGIN);

      const allPrs = sortPullRequestSummaries(rawPrs.map((pr) => triage(pr)));
      const counts = countByBucket(allPrs);
      const prs = isBucket(input.bucket) ? allPrs.filter((pr) => pr.bucket === input.bucket) : allPrs;

      return {
        structuredContent: {
          totalCount: issueCount,
          counts,
          prs,
          login: env.GITHUB_LOGIN,
          tokenSource: source,
        },
        content: [{ type: "text" as const, text: summarize(issueCount, allPrs) }],
        isError: false,
      };
    },
  )
  .registerTool(
    {
      name: "nudge-pr",
      description:
        "Preview a follow-up comment on one of your pull requests. Dry run only — does not post to GitHub.",
      inputSchema: {
        repo: z.string().describe('Repository as "owner/name", e.g. "OpenHands/OpenHands".'),
        number: z.number().int().positive().describe("Pull request number."),
        message: z.string().optional().describe("Custom nudge text. Defaults to a generic check-in message."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      auth: { scopes: ["radar:nudge"] },
    },
    (input) => {
      const body =
        input.message?.trim() || "Just checking in on this PR — let me know if there's anything blocking review.";
      const wouldPostTo = `https://api.github.com/repos/${input.repo}/issues/${input.number}/comments`;

      // TODO: actually POST `body` to `wouldPostTo` (with the nudge-scoped
      // GitHub token) once this tool is ready to write to GitHub. Deferred
      // intentionally for now — this exists to demonstrate `radar:nudge` as
      // a scope gated separately from `radar:read`.
      return {
        structuredContent: { wouldPostTo, body, dryRun: true },
        content: [
          {
            type: "text" as const,
            text: `Dry run: would comment on ${input.repo}#${input.number}. No request was sent.`,
          },
        ],
        isError: false,
      };
    },
  );

export default await server.run();
export type AppType = typeof server;
