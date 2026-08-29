# Demo video — shot list and submission recap

Target length: **5:00 hard cap**. One take per section, cut between sections. Speaking lines below
are notes, not a script — say them in your own words, don't read them.

- Video URL: `TODO`
- Public repo URL: `TODO`
- Total build time: `TODO`

## Before you hit record

- [ ] **Hard refresh the Playground** at `https://cyan-schools-roll-396.alpic.dev/try`
      (Cmd-Shift-R). The view reads its data from a one-shot `tool-result` notification — a stale
      page can miss it entirely and sit on its skeleton for the whole take.
- [ ] **Run `/prs` once to warm up, then clear the chat.** The first call after a page load is the
      unreliable one. Burn it before recording, not during.
- [ ] **Confirm the gate is live** before starting:
      ```
      curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cyan-schools-roll-396.alpic.dev/mcp
      # expect 401
      curl -s -o /dev/null -w '%{http_code}\n' https://cyan-schools-roll-396.alpic.dev/.well-known/oauth-protected-resource/mcp
      # expect 200
      ```
- [ ] **Close the DevTools panel and the model-context sidebar.** The view is the thing being
      demoed; nothing else should compete with it for screen space.

## Shot list

| Time | What's on screen | What you say |
|---|---|---|
| 0:00–0:15 | GitHub PR list, filtered to `is:open is:pr author:<login>` — 77 results | "Seventy-seven open pull requests across twenty-two public repositories." |
| 0:15–0:30 | Scroll the list once, slowly, then stop | "The question is never *what are my PRs*. It's *which ones are blocked on me right now*, and nothing here answers that." |
| 0:30–0:50 | Terminal. `curl -si -X POST https://cyan-schools-roll-396.alpic.dev/mcp` | "Before any of that — the server is gated. An unauthenticated call to `/mcp` gets a 401 before a single tool handler runs." |
| 0:50–1:15 | Highlight the `WWW-Authenticate` header, specifically `resource_metadata=...` | "The 401 carries the address of the protected-resource metadata, RFC 9728. The server publishes where to get a token — nothing is hardcoded in the client." |
| 1:15–1:35 | AuthPlane sign-in page | "That metadata points the client at AuthPlane, which is running self-hosted in Docker." |
| 1:35–2:00 | Consent screen, two scopes visible: `radar:read`, `radar:nudge` | "Two scopes, and that's the whole ask. The token AuthPlane issues is audience-bound to this one server — RFC 8707 — so it isn't usable anywhere else." |
| 2:00–2:30 | Run `radar-ping`. Identity card renders — email, scope pills, client id | "That's the signed-in identity as the authorization server sees it. And this is an MCP App view: a React component rendering in the client, not a wall of text." |
| 2:30–2:50 | Run `pr-radar`. Main view renders: four bucket chips with counts | "Here's the actual product. Every open PR, bucketed by who has to act next — blocked on you, waiting on a maintainer, stale, draft." |
| 2:50–3:10 | Scroll two or three PR rows — CI dot, review state, age | "Each row carries CI state, review state, and how long it's been sitting. Blocked-on-you means changes requested or failing CI." |
| 3:10–3:30 | Click the **Blocked on you** chip, then the **Stale** chip | "Filtering happens in the view. No second round trip to the model." |
| 3:30–3:50 | AuthPlane audit log, tailing. Show `broker_grant.created provider=github` | "Now the part that matters. This is the authorization server's audit log." |
| 3:50–4:15 | Next line: `upstream.token.issued provider=github scopes=public_repo` | "The GitHub refresh grant is encrypted inside AuthPlane and never reaches this server. It presents its own audience-bound token, and AuthPlane exchanges that for a short-lived GitHub token — RFC 8693 — once per call." |
| 4:15–4:30 | Point at the `aes_master` line in the boot-time feature table | "The GitHub refresh grant is encrypted at rest under `aes_master` and never leaves the authorization server." |
| 4:30–4:45 | Scroll back to `scopes=public_repo` in the audit line | "Note the scope: `public_repo`, not `repo`. Every PR being tracked is public, so the private surface was never needed and was never requested." |
| 4:45–5:00 | Run `nudge-pr` on a stale PR. Client stops on the approval prompt — hold on it | "The write path carries a separate scope, `radar:nudge`, and the client still stops here for approval — because the tool declares `readOnlyHint: false`. Least privilege on both sides." |

Close on the approval prompt. Don't approve it on camera, don't add an outro.

## If something goes wrong mid-take

- **Blank or empty view region.** The `tool-result` notification was missed. Hard refresh, warm up
  with one throwaway `/prs`, retake the section. **Do not debug on camera** — it never resolves in
  under a minute and the take is already lost.
- **Tunnel dropped — `/mcp` returns 404.** A watchdog restarts it. Wait ~20 s, re-run the
  pre-flight `curl`, then retake. Nothing to fix by hand.
- **Playground asks you to authorize again.** The AuthPlane session expired. Sign in at
  `/login` first. It lands on a **404 page — that is expected and means it worked**; the session
  cookie is set and `/oauth/authorize` starts working immediately. Then retry the connect flow.

## Text recap for the submission form

Paste as-is. Fill the three `TODO`s first.

---

**PR Radar** — an MCP App on Skybridge that triages my open pull requests into who-acts-next
buckets, with AuthPlane in front of it. Repo: `TODO`. Video: `TODO`. Built in `TODO`.

I have 77 open pull requests across 22 public repositories. The question I need answered isn't
"what are my PRs" — it's "which ones are blocked on me right now". PR Radar answers that inside the
MCP client, as an interactive React view: buckets for blocked-on-you (changes requested or failing
CI), waiting-on-maintainer, stale at 14+ days, and draft.

**SDK and language.** TypeScript, using Skybridge's built-in `authplaneProvider`. The authorization
server is AuthPlane authserver, self-hosted in Docker with SQLite storage and ES256 signing.

**Auth shape.** OAuth 2.1 with PKCE and dynamic client registration. Access tokens are
audience-bound to this MCP server (RFC 8707), and the server publishes protected-resource metadata
(RFC 9728), so the client discovers where to get a token rather than having it hardcoded. Two
scopes: `radar:read` and `radar:nudge`. For GitHub, the refresh grant is encrypted inside AuthPlane
and never reaches this server — it presents its own audience-bound token instead, and AuthPlane
brokers back a short-lived GitHub access token via RFC 8693 token exchange, per call. The exchange
requests `public_repo`, not `repo`.

**Setup feedback.** AuthPlane was answering on its discovery endpoint 13 seconds after `docker
pull`. The one step nothing prompts you to create is the fronting link between a Mint resource and
a Broker resource — registering the broker and completing the connect flow both succeed and both
look like the end of setup. Error codes like `fronting_link_missing` are precise and exactly
documented, but they surface only in the authorization server's audit log, not to the client. Full
log of 13 findings is in `notes/friction-log.md` in the repo.
