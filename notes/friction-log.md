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

9. **🔴 The highest-value finding: Claude cannot connect to a default authserver, and the error
   is actively misleading.** Claude's recommended OAuth path is CIMD (Client ID Metadata
   Document). authserver fetches Claude's document correctly — then rejects the client outright:

   ```
   cimd auto-registration blocked by disabled grant
     client_id=https://claude.ai/oauth/mcp-oauth-client-metadata
     grant_types=[authorization_code refresh_token urn:ietf:params:oauth:grant-type:jwt-bearer]
   ```

   Claude advertises three grants; `jwt-bearer` is disabled by default, so authserver refuses the
   *whole* client rather than registering it with the grants it does support. Three separate
   problems compound here:

   - **Interop.** Claude is the most common MCP client. Out of the box, against a
     quickstart-configured authserver, its recommended connection mode fails. Intersecting the
     advertised grants with the supported set (and registering the overlap) would make this work
     with no configuration at all.
   - **The error names a variable that does not exist.** It says *"set `AUTHPLANE_XAA_ENABLED=true`
     to enable it"*. There is no such env var — `docs/guides/federation/README.md` states plainly:
     "There is no `AUTHPLANE_XAA_ENABLED` env var. XAA is enabled via the YAML `xaa.enabled: true`
     only." Following the error message verbatim leaves the server in exactly the same broken
     state, which is the worst possible outcome for a first-run experience.
   - **The user-facing message is wrong.** The browser shows *"Invalid Client — The client_id is
     not recognized."* The client_id **was** recognized: authserver fetched and parsed the metadata
     document successfully. The failure was grant-type validation. A user without server log access
     has no path from that message to the fix.

   Fix that actually works: `xaa: { enabled: true }` in `config.yaml`. Enabling an enterprise
   federation feature to satisfy a grant-type check is a surprising requirement for "let Claude
   sign in".

10. **Restarting the AS silently invalidates browser sessions, and the client-side failure is
    opaque.** After restarting authserver to enable broker features, Claude's connect flow failed
    with only `Authorization with PR RADAR failed … reference ofid_…`. Server-side the cause was
    plain — `/oauth/authorize` 303-ing to `/login` in a retry loop because the browser session was
    gone — but nothing surfaced that to the user. Signing in again at `/login` fixed it instantly.

11. **Post-login lands on a 404.** The login form submits `redirect=""`, and on success redirects
    to `/`, which is not served on the public port (the admin UI is on `:9001`). So a successful
    login *looks* like a failure: you get "404 page not found" even though the session cookie was
    set correctly and `/oauth/authorize` immediately starts working. Landing on a simple "you're
    signed in, you can close this tab" page would remove a genuinely confusing dead end.

## Things that were notably good

- **The boot-time feature self-check.** authserver prints a table of every subsystem
  (`data_encryption`, `connect`, `token_exchange`, `client_credentials`, `dpop`, `dcr`, seeded
  resources) with enabled/disabled and *why*. It answered "is token exchange actually on?" before
  we had to ask.
- **Dynamic Client Registration just worked** — one unauthenticated POST to `/oauth/register`
  returned a usable `client_id` for a Claude callback URL, no dashboard round-trip.
- **`scopes_supported` in the protected-resource metadata is populated from the resource
  registered in AuthPlane**, so the MCP server advertises the right scopes without restating them.
