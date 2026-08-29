# PR Radar — triage spec (proven against live data)

Single GraphQL call (`notes/pr-query.graphql`) returns everything needed. Verified 2026-08-29
against `author:ameyypawar`: **77 open PRs**, 18 with failing CI, 1 changes-requested,
13 awaiting review.

## Query
`search(query: "is:open is:pr author:@me archived:false", type: ISSUE)` returning per PR:
`repository.nameWithOwner`, `number`, `title`, `url`, `isDraft`, `createdAt`, `updatedAt`,
`reviewDecision`, `commits(last:1).commit.statusCheckRollup.state`, `comments`, `reviews`.
`author:@me` resolves against the bearer token on each request — not a configured login.

## Triage buckets — "who is this waiting on?"

| Bucket | Rule | Meaning |
|---|---|---|
| 🔴 `BLOCKED_ON_YOU` | `reviewDecision == CHANGES_REQUESTED` **or** CI `state == FAILURE` | You must act |
| 🟡 `WAITING_ON_MAINTAINER` | `reviewDecision in (REVIEW_REQUIRED, APPROVED)` and CI not failing | Their turn |
| 💤 `STALE` | `updatedAt` older than 14 days and not already blocked-on-you | Candidate for a nudge |
| ⚪ `DRAFT` | `isDraft == true` | Not ready |

Precedence: `DRAFT` → `BLOCKED_ON_YOU` → `STALE` → `WAITING_ON_MAINTAINER`.

## Notes / gotchas
- `reviewDecision` is `null` on repos without review requirements — render as "—", never crash.
- `statusCheckRollup` is `null` when a repo runs no checks — same.
- `search` caps at 100 per page; `first: 40` is plenty for the demo.
- The nudge write action should target PRs in the `STALE` bucket only.
