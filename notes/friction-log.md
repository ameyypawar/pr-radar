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

12. **Protected-resource metadata advertises scopes the resource will reject.** AuthPlane's
    `/.well-known/oauth-authorization-server` returns `scopes_supported` as the global union
    across every registered resource — with an MCP server and a GitHub broker both registered,
    the observed value was `["repo","read:user","radar:read","radar:nudge"]`. Skybridge's
    `authplaneProvider` (via `customProvider`) defaults the RFC 9728 protected-resource-metadata
    `scopes_supported` to that AS-level list — `const scopesSupported = opts.scopes ??
    base.scopes_supported` in `node_modules/skybridge/dist/server/auth/providers/custom.js:31` —
    so this MCP server advertised `repo` and `read:user`, scopes that belong to a different
    resource entirely. RFC 9728 §2 defines PRM `scopes_supported` as the scopes used in
    authorization requests *to access this protected resource*, so the list needs to be
    resource-scoped, not AS-global.

    A client that requested exactly what the metadata advertised was rejected. Differential test
    against the same session and client:

    - `scope=radar:read radar:nudge` → `303` to the login page (normal)
    - `scope=repo read:user radar:read radar:nudge` → `303` to the redirect URI with
      `error=invalid_scope&error_description=the requested scope is invalid or not allowed: scope
      "repo" not allowed for resource "https://<app>/mcp"`

    Worth stating explicitly: the `invalid_scope` rejection happens *before* the authentication
    check, so it surfaces to the end user as a generic "Authorization failed" with an opaque
    reference id. Signing in again never clears it, which sends debugging down the wrong path —
    we lost real time here, repeatedly re-testing login.

    Workaround: pass `scopes` explicitly to `authplaneProvider`
    (`scopes: ["radar:read","radar:nudge"]`) — a typed, documented option, just not the default.
    Suggested fixes: (a) AuthPlane exposes per-resource scopes so the provider can scope the PRM
    automatically; (b) `authplaneProvider` derives PRM scopes from the registered resource rather
    than AS metadata; (c) at minimum, surface `error_description` to the end user, since the AS
    produces a precise, actionable message that the client currently swallows.

13. **A Mint→Broker token exchange needs a fronting link that nothing prompts you to
    create.** Setup was, we thought, complete: a Mint resource (`pr-radar-live`) for the MCP
    server, a Broker resource (`github`) pointing at a GitHub broker provider, the Broker's
    `policy.exchange.allowed_client_ids` naming our confidential client, and a completed user
    connect flow that produced a real `broker_grant` (audit: `broker_grant.created
    provider=github version=1`, refresh token encrypted under `aes_master`). Every RFC 8693
    exchange still failed:

    ```
    POST /oauth/token -> 400
    audit: token.exchange_denied  reason=fronting_link_missing
    ```

    The missing piece is a `fronting_links` row declaring that the Mint may exchange for the
    Broker. It's admin-API-only — there is no YAML config block for it, so an operator who
    configures everything else through `config.yaml` has no reason to know it exists. Fixed
    with a single admin call:

    ```
    POST /admin/fronting
    {"source":"pr-radar-live","target":"github","scope_map":{"radar:read":["public_repo","read:user"],"radar:nudge":["public_repo"]}}
    -> 201
    ```

    Three things stood out, in order of how useful they'd be to AuthPlane — two of which are
    on us, not them:

    - **On us: two steps that succeeded and looked terminal, so we stopped there.**
      Registering the Broker resource and completing the connect flow both succeed, and both
      look like the end of setup — you finish with a stored grant and reasonably conclude
      you're done. We did, and we were wrong. A hint at Broker-resource creation time — e.g.
      flagging that no fronting link references this resource yet — or a
      `GET /admin/resources/<slug>` field listing inbound links, would have closed the gap
      before we ever hit the `400`.
    - **Credit due: `reason=fronting_link_missing` is a genuinely excellent error code.**
      `docs/topologies/mcp-gateway-broker.md` documents it with the exact fix, and once we had
      the reason string, resolution took minutes. The only gap is that the reason lives solely
      in the authorization server's own audit log — the client we were testing from saw
      nothing but a bare `400`.
    - **On us: a fallback we built ourselves hid the bug from us.** The tool degrades to a
      static token when the broker is unavailable, and that fallback silently masked this
      misconfiguration — it returned correct-looking data from the fallback path, so nothing
      looked wrong until we went and read the AS audit log directly. Lesson for anyone wiring
      a broker: log the token source explicitly and assert on it in testing, or a working
      fallback will hide a broken exchange.

    One more small thing: the CLI's `--scope-map` flag separates source scope from target
    scopes with `:` (`--scope-map A:AA,B:BB`), which is ambiguous when the scopes themselves
    contain colons, as OAuth scopes commonly do (`radar:read`, `read:user`). We used the JSON
    admin API instead, which has no such ambiguity — worth documenting the JSON form as the
    default for colon-bearing scopes.

## Things that were notably good

- **The boot-time feature self-check.** authserver prints a table of every subsystem
  (`data_encryption`, `connect`, `token_exchange`, `client_credentials`, `dpop`, `dcr`, seeded
  resources) with enabled/disabled and *why*. It answered "is token exchange actually on?" before
  we had to ask.
- **Dynamic Client Registration just worked** — one unauthenticated POST to `/oauth/register`
  returned a usable `client_id` for a Claude callback URL, no dashboard round-trip.
- **Protected-resource and AS discovery metadata are served automatically, no
  hand-authoring needed** — both endpoints come up correctly out of the box, and
  `resource`/audience binding is correct by default. One gap: PRM `scopes_supported` is the
  AS's global union across every registered resource, not scoped to this one (see #12) —
  invisible until a second resource exists.
