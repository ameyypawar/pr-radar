# Setup friction log — AuthPlane × Skybridge

Kept live during the build. Feeds the honest-feedback section of the submission.

## Timings

| Milestone | Time |
|---|---|
| `docker pull` → AuthPlane discovery endpoint answering (cold, image pull included) | **13 s** |
| AuthPlane admin user + resource + 2 scopes registered | under 1 min |

AuthPlane's "working OAuth 2.1 server in under a minute" claim held up — this was the
smoothest part of the whole stack.

## Friction

1. **Node 24 is a hard floor, and it isn't obvious until it fails.** Skybridge requires
   `>=24.18.0`. A machine on Node 20 (still in LTS) scaffolds fine and only breaks later.
   Worth a preflight check in `create-skybridge`.

2. **`create-skybridge` prompts interactively with no non-interactive escape.** After copying
   the template it asks "Install coding agent skills?" — with stdin closed (CI, agent-driven
   setup, scripted install) it stalls there. The template is written, so it's recoverable, but
   a `--yes` / `--no-skills` flag would make it automatable.

3. **`config.yaml` interpolates `${AUTHPLANE_ADMIN_API_KEY}` but the docker quickstart never
   passes it into the container.** Following the documented steps literally, the admin key
   resolves empty. Passing `-e AUTHPLANE_ADMIN_API_KEY` fixes it — the docs should show it in
   the `docker run` snippet.

4. **`@types/react` is missing from the blank template.** The scaffold ships React 19 and expects
   TSX views, but `@types/react` isn't a dependency anywhere. `tsc --noEmit` fails with ~30
   `TS7026`/`TS7016` JSX errors the moment you add your first view. Worth baking into the template.

5. **Wrong Node version fails cryptically, not helpfully.** On Node 20, `skybridge dev` dies with
   `The requested module 'node:fs' does not provide an export named 'globSync'` and
   `Error: command dev not found`. `package.json` already declares `engines.node >= 24.18.0` — a
   startup version check would turn a confusing module error into a one-line fix.

6. **`/.well-known/oauth-protected-resource` 404s on the bare path — by design.** Per RFC 9728, when
   the resource identifier has a path (`.../mcp`), the metadata lives at
   `/.well-known/oauth-protected-resource/mcp`. Correct behaviour, but surprising if you curl the
   bare path first; the `WWW-Authenticate` challenge does point at the right URL.

7. **The Alpic tunnel subdomain is bound to the project directory, not the port.** Running
   `alpic tunnel --port 9000` from the app directory silently reuses the *app's* subdomain and
   repoints it, so you can't tunnel two local services from one project. Nice property for
   stability (the URL survives restarts, which let us bake it into `SERVER_URL`), surprising if
   you need a second tunnel.

8. **`session.secure must be true when server.issuer is not localhost`** — hit this the moment the
   issuer moved to a public HTTPS URL. Exactly the kind of error message you want: it names the
   field, the condition, and the reason. No guessing.

## Things that were notably good

- **The boot-time feature self-check.** authserver prints a table of every subsystem
  (`data_encryption`, `connect`, `token_exchange`, `client_credentials`, `dpop`, `dcr`, seeded
  resources) with enabled/disabled and *why*. It answered "is token exchange actually on?" before
  we had to ask.
- **Dynamic Client Registration just worked** — one unauthenticated POST to `/oauth/register`
  returned a usable `client_id` for a Claude callback URL, no dashboard round-trip.
- **`scopes_supported` in the protected-resource metadata is populated from the resource
  registered in AuthPlane**, so the MCP server advertises the right scopes without restating them.
