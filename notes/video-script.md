# Demo video — shot list and submission recap

Target length: **5:00 hard cap**. One take per section, cut between sections. Speaking lines below
are notes, not a script — say them in your own words, don't read them.

- Video URL: `TODO`
- Public repo URL: `https://github.com/ameyypawar/pr-radar`
- Total build time: `13 hours`
- Open PR total: **78 open PRs across 22 public repositories**

`78` is the canonical value for this file. It is spoken and written in three other places — the
0:00–0:15 screen cell, the 0:00–0:15 narration (spelled out in words), and the submission recap at
the bottom. The pre-flight re-verify step below names all four; change them together or not at all.

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
- [ ] **Re-verify the GitHub total** immediately before recording — a merged PR or a newly archived
      tracked repo changes the number the opening shot puts on screen. It has already gone stale
      once.
      ```
      gh api -X GET search/issues -f q='is:open is:pr author:@me archived:false' \
        --jq '.total_count'
      # expect 78
      gh api -X GET search/issues -f q='is:open is:pr author:@me archived:false' -f per_page=100 \
        --jq '[.items[].repository_url] | unique | length'
      # expect 22
      ```
      **If either number moved, update every one of these four before recording — the count is
      duplicated and nothing cross-checks it:**
      1. the `Open PR total` line at the top of this file (the canonical one),
      2. the `0:00–0:15` row's screen cell in the shot list (`— 78 results`),
      3. the `0:00–0:15` row's narration in the same row — **spelled out in words**
         ("Seventy-eight…"), so a digit-only find-and-replace will miss it,
      4. the first line of the submission recap under **Text recap for the submission form**.
- [ ] **Run `/prs`, hover the `@<login>` in the header, and confirm the tooltip reads "token via
      GitHub connection."** There is no footer any more. The token source is a `title` on the
      account name in the header's second line (`<N> open PRs · @<login>`), so it is revealed by
      hovering, not by reading — hold the pointer on the handle for a second. Three readings, one
      of which is go:
      - **"token via GitHub connection"** — the RFC 8693 broker exchange served this call. **Go.**
      - **"token via local .env"** — a local PAT served it, not the broker. The chat reply also
        opens with "These are the server's fallback account's pull requests, not yours."
        **Do not record.**
      - **No `@<login>` on that line at all, and a "Connect GitHub" banner above the header** — no
        GitHub token was obtained. The chat reply says "GitHub isn't connected yet."
        **Do not record.**

      `GITHUB_TOKEN` and `ALLOW_ENV_TOKEN_FALLBACK` are both absent from `app/.env`, so the middle
      reading should be unreachable — check anyway. This is the auth story the whole video narrates.
- [ ] **Close the DevTools panel and the model-context sidebar.** The view is the thing being
      demoed; nothing else should compete with it for screen space.
- [ ] **Leave the supervisor running.** Do not stop it for the take. The tunnel dies on its own far
      too often to record without a watchdog: over the ~13 hours in `infra/logs/supervise.log`,
      `alpic tunnel` was found down and restarted **16 times, spread across 12 different hours** —
      three of them in the 14:00 hour alone. **13 of those 16 recovered on their own in about five
      or six seconds.** The other three (08:27, 14:11, 14:29) had a restart attempt fail outright
      after 30s and only came back on a later cycle — so recovery is the strong default, not a
      guarantee. Two of the three were in the last hour, so treat the tunnel as *less* settled
      right now, not more.

      The reasoning, because it inverts what looks intuitive: when the tunnel dies, the live MCP
      session is already gone — **killed by the tunnel dying, not by the restart**. The supervisor
      cannot cost you a session that is already lost; it gives it back in seconds. Stop the
      supervisor and that same tunnel death is simply unrecovered, and the take is lost for good.
      The residual risk — the supervisor bouncing a *healthy* dev server — needs three consecutive
      failed probes (`CONFIRM_ATTEMPTS=3`, `CONFIRM_GAP=3`), which means it genuinely was not
      serving.

      Confirm it is up, from the repo root:
      ```
      ./infra/supervise.sh --status    # expect "running (pid ...)"
      ```
- [ ] **Record in short takes, and re-check the stack immediately before each one.** Short takes
      bound what a mid-take drop can cost you. From the repo root, this covers all four gates —
      supervisor, the MCP endpoint, its protected-resource metadata, and the authorization server:
      ```
      ISS=$(/usr/bin/grep -oE '^AUTHPLANE_ISSUER=.*' app/.env | cut -d= -f2-)
      ./infra/supervise.sh --status \
        && curl -s -o /dev/null -w 'mcp %{http_code}\n' -X POST \
             https://cyan-schools-roll-396.alpic.dev/mcp \
        && curl -s -o /dev/null -w 'prm %{http_code}\n' \
             https://cyan-schools-roll-396.alpic.dev/.well-known/oauth-protected-resource/mcp \
        && curl -s -o /dev/null -w 'iss %{http_code}\n' \
             "$ISS/.well-known/oauth-authorization-server"
      # expect: "running (pid ...)", then "mcp 401", "prm 200", "iss 200"
      ```
      The issuer is read out of `app/.env` rather than hardcoded, because it has already moved once
      (it was a `trycloudflare.com` hostname earlier today, now `auth.tubio.pro`). Keep the
      `/usr/bin/grep` spelled out: a bare `grep` is a shell function here that skips gitignored
      files, and `app/.env` is gitignored — if it ever returns nothing, `$ISS` goes empty and the
      last gate silently checks a garbage URL instead of failing loudly.
- [ ] **Do not edit anything under `app/src/` while recording.** This is separate from the
      supervisor and still true: `skybridge dev` watches that directory itself and respawns its own
      server child on any change. The supervisor does not watch files and neither causes nor
      prevents this — leaving it running does not protect you here. No file edits mid-take.

## Shot list

> **Re-run the `iss` gate immediately before the two auth blocks — 1:15–2:00 (sign-in and consent)
> and 3:30–4:15 (the audit log).** Those shots go through `auth.tubio.pro`, and that hostname is the
> one part of the stack with no watchdog at all: it went unreachable 18 times in the 13 hours of
> `infra/logs/supervise.log`, across 11 different hours, most recently at 14:25. Every one of those
> 18 was alarm-only — the supervisor is explicit that it will not act, and nothing else does either.
> See **cloudflared wedged** under *If something goes wrong mid-take*; recovery is a manual step and
> needs `sudo`, so it is not something you want to discover halfway through a take.
>
> ```
> curl -s -o /dev/null -w 'iss %{http_code}\n' \
>   "$(/usr/bin/grep -oE '^AUTHPLANE_ISSUER=.*' app/.env | cut -d= -f2-)/.well-known/oauth-authorization-server"
> # expect 200
> ```

| Time | What's on screen | What you say |
|---|---|---|
| 0:00–0:15 | GitHub PR list, filtered to `is:open is:pr author:@me archived:false` — 78 results | "Seventy-eight open pull requests across twenty-two public repositories." |
| 0:15–0:30 | Scroll the list once, slowly, then stop | "The question is never *what are my PRs*. It's *which ones are blocked on me right now*, and nothing here answers that." |
| 0:30–0:50 | Terminal. `curl -si -X POST https://cyan-schools-roll-396.alpic.dev/mcp` | "Before any of that — the server is gated. An unauthenticated call to `/mcp` gets a 401 before a single tool handler runs." |
| 0:50–1:15 | Highlight the `WWW-Authenticate` header, specifically `resource_metadata=...` | "The 401 carries the address of the protected-resource metadata, RFC 9728. The server publishes where to get a token — nothing is hardcoded in the client." |
| 1:15–1:35 | AuthPlane sign-in page | "That metadata points the client at AuthPlane, which is running self-hosted in Docker." |
| 1:35–2:00 | Consent screen, two scopes visible: `radar:read`, `radar:nudge` | "Two scopes, and that's the whole ask. The token AuthPlane issues is audience-bound to this one server — RFC 8707 — so it isn't usable anywhere else." |
| 2:00–2:30 | Run `radar-ping`. Identity card renders — email, scope pills, client id | "That's the signed-in identity as the authorization server sees it. And this is an MCP App view: a React component rendering in the client, not a wall of text." |
| 2:30–2:50 | Run `pr-radar`. The inline view renders: headline count, four chips — Blocked, Stale, Waiting, Draft — and the PRs blocked on you | "Here's the actual product. Every open PR gets bucketed by who has to act next — blocked on you, stale, waiting on a maintainer, draft — and inline it leads with the ones blocked on you." |
| 2:50–3:10 | Read down the inline rows — CI dot, review state, age. There are at most three and they don't scroll | "Each row carries CI state, review state, and how long it's been sitting. Blocked-on-you means changes requested or failing or errored CI." |
| 3:10–3:30 | Click **Open full radar**. The board takes the full pane — four bucket columns. Click **By repository**, then **By urgency** again | "The chips are a read-out, not buttons — the board is where you browse. Expanding it and switching layout both happen inside the view. No second round trip to the model." |
| 3:30–3:50 | AuthPlane audit log, tailing (window wide enough to reach today's setup). Point at `broker_grant.created provider=github` | "Now the part that matters. This is the authorization server's audit log — that connect grant up top ran during setup, still sitting in the trail." |
| 3:50–4:15 | Next line: `upstream.token.issued provider=github scopes=public_repo` | "The GitHub refresh grant is encrypted inside AuthPlane and never reaches this server. It presents its own audience-bound token, and AuthPlane exchanges that for a short-lived GitHub token — RFC 8693 — once per call." |
| 4:15–4:30 | Terminal. `curl -s localhost:9001/admin/system/config -H "Authorization: Bearer $AUTHPLANE_ADMIN_API_KEY" \| jq .encryption` → `{"driver":"aes_master"}` | "The GitHub refresh grant is encrypted at rest under `aes_master`, straight from the server's own config — and it never leaves the authorization server." |
| 4:30–4:45 | Scroll back to `scopes=public_repo` in the audit line | "Note the scope: `public_repo`, not `repo`. Every PR being tracked is public, so the private surface was never requested. `public_repo` is the narrowest scope declared on this broker resource — narrowing it further is a change on the authorization server, not in this code." |
| 4:45–5:00 | Run `nudge-pr` on a stale PR. Client stops on the approval prompt — approve it, hold on the dry-run response | "This tool declares `readOnlyHint: false` — write-capable — and carries its own scope, `radar:nudge`. The client stops for approval regardless. The post itself is still a dry run." |

Approve on camera and hold on the dry-run response — that line is the honest payoff, not the approval prompt itself. No outro after it.

## If something goes wrong mid-take

- **Blank or empty view region.** The `tool-result` notification was missed. Hard refresh, warm up
  with one throwaway `/prs`, retake the section. **Do not debug on camera** — it never resolves in
  under a minute and the take is already lost.
- **Tunnel dropped — `/mcp` returns 404 or 000.** The take is already lost the moment the tunnel
  died, so stop recording. The supervisor is running and is already on it: it detects the drop
  after three consecutive failed probes and restarts `alpic tunnel`, and in 13 of 16 observed cases
  the endpoint was back within about six seconds. Do nothing by hand. Re-run the health line until
  it reads `mcp 401`, then retake:
  ```
  ./infra/supervise.sh --status \
    && curl -s -o /dev/null -w 'mcp %{http_code}\n' -X POST \
         https://cyan-schools-roll-396.alpic.dev/mcp
  ```
  If it has not come back after a couple of minutes, a restart attempt failed (this happened three
  times overnight). Check `infra/logs/supervise.log` for `tunnel: RESTART FAILED` and
  `infra/logs/alpic-tunnel.log` for the reason. The supervisor keeps retrying on its own cycle —
  it recovered without intervention every time — so wait it out rather than restarting anything
  by hand mid-session.
- **cloudflared wedged — the sign-in, consent, or audit-log shots fail, and the `iss` gate returns
  530 or 000.** This is the one failure in the stack that **nothing recovers on its own**, so it is
  the one worth recognising fast. Confirm it before doing anything:
  ```
  /usr/bin/grep 'cloudflared: WEDGED' infra/logs/supervise.log | tail -3
  ```
  A wedge means the daemon is alive but holding zero live edge connections
  (`readyConnections=0`). Because the process never exited, launchd sees no event — its plist sets
  `KeepAlive={SuccessfulExit=false}`, which relaunches only on a **non-zero exit** — so launchd will
  not act. The supervisor will not act either, and could not if it wanted to: cloudflared is a
  root-owned system LaunchDaemon (`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`) and
  `infra/supervise.sh` runs unprivileged. **Do not wait for a recovery that is not coming.**

  Recovery is a manual operator step and needs `sudo`, which is why it lives here and not in any
  script:
  ```
  sudo launchctl kickstart -k system/com.cloudflare.cloudflared
  ```
  Then confirm recovery in two stages — first that the daemon has a live edge connection again,
  then that the issuer is actually answering. The metrics port is not fixed (cloudflared takes the
  first free port in 20241–20245, and it has already moved from 20241 to 20242 today), so scan the
  range rather than assuming one:
  ```
  for p in 20241 20242 20243 20244 20245; do
    b=$(curl -s --max-time 2 "http://localhost:$p/ready" 2>/dev/null)
    [ -n "$b" ] && { echo "port $p: $b"; break; }
  done
  # expect readyConnections >= 1

  curl -s -o /dev/null -w 'iss %{http_code}\n' \
    "$(/usr/bin/grep -oE '^AUTHPLANE_ISSUER=.*' app/.env | cut -d= -f2-)/.well-known/oauth-authorization-server"
  # expect 200
  ```
  This briefly takes the issuer down while it reconnects, so never run it mid-take — stop
  recording first, recover, re-run the full pre-flight health line, then retake.
- **"Open full radar" does nothing.** Fullscreen is the host's to grant, and the board only draws
  once it has. Retake the shot; if it fails twice, narrate the same point over the inline view and
  drop the board — it is one shot, not the demo.
- **Playground asks you to authorize again.** The AuthPlane session expired. Sign in at
  `/login` first. It lands on a **404 page — that is expected and means it worked**; the session
  cookie is set and `/oauth/authorize` starts working immediately. Then retry the connect flow.

## Text recap for the submission form

Two things to check before this leaves the file. One `TODO` — the video URL, below and at the top
of this file; fill it first. And the PR count in the first line of the recap: it must equal the
`Open PR total` at the top of this file, which the pre-flight step re-verified. This text gets
pasted into a submission form where nothing will catch a stale number.

---

**PR Radar** — an MCP App on Skybridge that triages my open pull requests into who-acts-next
buckets, with AuthPlane in front of it. Repo: `https://github.com/ameyypawar/pr-radar`.
Video: `TODO`. Built in 13 hours.

I have 78 open pull requests across 22 public repositories. The question I need answered isn't
"what are my PRs" — it's "which ones are blocked on me right now". PR Radar answers that inside the
MCP client, as an interactive React view: buckets for blocked-on-you (changes requested or failing
or errored CI), waiting-on-maintainer, stale at 14+ days, and draft.

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
log is in `notes/friction-log.md` in the repo.
