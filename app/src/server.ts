import { authplaneProvider, McpServer } from "skybridge/server";
import { z } from "zod";
import { env } from "./env.js";
import { ConsentRequiredError, getGitHubToken, type GitHubTokenSource } from "./github-token.js";
import { fetchOpenPullRequests, type RawPullRequest } from "./github.js";
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

/** One-line, model-readable summary. Deliberately terse: the view renders the full list, so this must not enumerate individual PRs. */
function summarize(totalCount: number, counts: ReturnType<typeof countByBucket>): string {
  if (totalCount === 0) {
    return "You have no open pull requests.";
  }
  return `Results are shown in the view above. ${counts.blockedOnYou} blocked on you, ${counts.waitingOnMaintainer} waiting on a maintainer, ${counts.stale} stale, ${counts.draft} draft.`;
}

/** Readable message for any caught error, so handlers never leak `[object Object]` or a raw stack. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const server = new McpServer(
  { name: "pr-radar", version: "0.1.0" },
  { capabilities: {} },
  {
    oauth: await authplaneProvider<{ email?: string }>({
      issuer: env.AUTHPLANE_ISSUER,
      resource: env.SERVER_URL,
      // Pin to this resource's own scopes — AuthPlane's AS-level scopes_supported is a
      // global union across every registered resource, and without this the PRM (RFC 9728)
      // leaks other resources' scopes (e.g. the GitHub broker's "public_repo", "read:user").
      scopes: ["radar:read", "radar:nudge"],
    }),
  },
).registerTool(
  {
    name: "radar-ping",
    description:
      "Verify the signed-in identity for PR Radar. Returns who you are according to the authorization server.",
    inputSchema: {},
    outputSchema: {
      subject: z.string().optional(),
      email: z.string().optional(),
      scopes: z.array(z.string()),
      clientId: z.string().optional(),
      verifiedAt: z.string(),
    },
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
      content: [
        { type: "text" as const, text: `Signed in as ${email ?? subject ?? "unknown"} — full details in the view above.` },
      ],
      isError: false,
    };
  },
)
  .registerTool(
    {
      name: "pr-radar",
      description:
        "Fetch your open GitHub pull requests, triaged by who needs to act next: blocked on you (changes requested or failing CI), stale (no activity in 14+ days), waiting on a maintainer, or draft. Results render in an interactive view — do not restate them in your reply.",
      inputSchema: {
        bucket: z
          .string()
          .optional()
          .describe(
            "Optional filter: BLOCKED_ON_YOU, STALE, WAITING_ON_MAINTAINER, or DRAFT. Omit to return every open PR.",
          ),
      },
      outputSchema: {
        totalCount: z.number(),
        counts: z.object({
          blockedOnYou: z.number(),
          waitingOnMaintainer: z.number(),
          stale: z.number(),
          draft: z.number(),
        }),
        prs: z.array(
          z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            repo: z.string(),
            bucket: z.enum(["BLOCKED_ON_YOU", "STALE", "WAITING_ON_MAINTAINER", "DRAFT"]),
            isDraft: z.boolean(),
            reviewDecision: z.string().nullable(),
            ciState: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
            ageDays: z.number(),
            staleDays: z.number(),
          }),
        ),
        login: z.string().optional(),
        tokenSource: z.enum(["broker", "env", "none"]),
        connectPrompt: z
          .object({
            needed: z.literal(true),
            url: z.string(),
            reason: z.string(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      auth: { scopes: ["radar:read"] },
      view: { component: "pr-radar", description: "Open PRs triaged by who needs to act next" },
    },
    async (input, extra) => {
      let token: string;
      let source: GitHubTokenSource;
      let connectPrompt: { needed: true; url: string; reason: string } | undefined;

      try {
        ({ token, source } = await getGitHubToken(extra));
      } catch (err) {
        if (!(err instanceof ConsentRequiredError)) {
          return {
            content: [{ type: "text" as const, text: `Could not get a GitHub token: ${errorMessage(err)}` }],
            isError: true,
          };
        }

        if (env.GITHUB_TOKEN) {
          // Fallback token still works — degrade gracefully and keep going.
          token = env.GITHUB_TOKEN;
          source = "env";
          connectPrompt = {
            needed: true,
            url: err.consentUrl,
            reason: "GitHub is not linked to your account yet — showing results from the server's fallback token.",
          };
        } else {
          // No fallback either — nothing to render. Ask the user to connect, without erroring the call.
          return {
            structuredContent: {
              totalCount: 0,
              counts: { blockedOnYou: 0, waitingOnMaintainer: 0, stale: 0, draft: 0 },
              prs: [] as PullRequestSummary[],
              tokenSource: "none" as const,
              connectPrompt: {
                needed: true as const,
                url: err.consentUrl,
                reason: "GitHub is not linked to your account yet — connect it to see your pull requests.",
              },
            },
            content: [
              {
                type: "text" as const,
                text: `GitHub isn't connected yet. Open this URL to connect your account: ${err.consentUrl}`,
              },
            ],
            isError: false,
          };
        }
      }

      let issueCount: number;
      let rawPrs: RawPullRequest[];
      let login: string | undefined;

      try {
        const fetched = await fetchOpenPullRequests(token);
        issueCount = fetched.issueCount;
        rawPrs = fetched.prs;
        login = fetched.login;
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Failed to fetch pull requests from GitHub: ${errorMessage(err)}` },
          ],
          isError: true,
        };
      }

      const allPrs = sortPullRequestSummaries(rawPrs.map((pr) => triage(pr)));
      const counts = countByBucket(allPrs);
      const prs = isBucket(input.bucket) ? allPrs.filter((pr) => pr.bucket === input.bucket) : allPrs;

      return {
        structuredContent: {
          totalCount: issueCount,
          counts,
          prs,
          login,
          tokenSource: source,
          connectPrompt,
        },
        content: [{ type: "text" as const, text: summarize(issueCount, counts) }],
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
