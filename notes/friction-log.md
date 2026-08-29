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

1. **Node 24 is a hard floor, and it isn't obvious until it fails.** The floor comes from the
   scaffold, not the framework: `packages/create-skybridge/templates/blank/package.json` pins
   `engines.node >= 24.18.0`, while `skybridge` itself declares `>=22.23.1`. A machine on Node 20
   — out of support since 2026-04-30, but still the default on plenty of dev boxes — scaffolds
   fine and only breaks later. Worth a preflight check in `create-skybridge`.

2. **We hung on a `create-skybridge` prompt that has a documented escape hatch.** With stdin
   closed (CI, agent-driven setup, scripted install) the bare command stalls at "Install coding
   agent skills?". The flags exist and we simply didn't look: `--yes` and `--skip-skills` are
   both declared in `packages/create-skybridge/src/index.ts`, and `--help` carries a section
   headed "Non-interactive usage". Ours to fix, not theirs. The only thing left worth saying is
   small — an invocation with no usable stdin waits forever rather than failing fast and naming
   `--yes`.

3. **`config.yaml` interpolates `${AUTHPLANE_ADMIN_API_KEY}` but the docker quickstart never
   passes it into the container.** Following the documented steps literally, the admin key
   resolves empty. Passing `-e AUTHPLANE_ADMIN_API_KEY` fixes it — the docs should show it in
   the `docker run` snippet.

4. **`@types/react` is missing from the blank template.** The blank template declares no `react`
   at all — React arrives via `skybridge`'s peer dependency (`react >=18.0.0`, resolved to 19.2.8
   here) — yet the template expects TSX views and declares neither `react` nor `@types/react`.
   `packages/core` keeps `@types/react` in its own devDependencies, so the framework type-checks
   its TSX while a consumer's `tsc --noEmit` fails with ~30 `TS7026`/`TS7016` JSX errors the
   moment you add your first view. Worth baking into the template.

5. **Wrong Node version fails cryptically, not helpfully.** On Node 20, `skybridge dev` dies with
   `The requested module 'node:fs' does not provide an export named 'globSync'` and
   `Error: command dev not found`. `package.json` already declares `engines.node >= 24.18.0` — a
   startup version check would turn a confusing module error into a one-line fix.

6. **`/.well-known/oauth-protected-resource` 404s on the bare path — by design, on the code path
   we were on.** Per RFC 9728, when the resource identifier has a path (`.../mcp`), the metadata
   lives at `/.well-known/oauth-protected-resource/mcp`. Which form you get is a config branch:
   `packages/core/src/server/auth/setup.ts` mounts the path-scoped router when `oauth.baseUrl` is
   set and a root-scoped handler when it isn't, and we took the first branch because
   `authplaneProvider` passes `baseUrl: resource`. Correct behaviour either way, and the
   `WWW-Authenticate` challenge does point at the right URL. Not new information, either —
   AuthPlane's `docs/reference/compliance.md` already documents
   `/.well-known/oauth-protected-resource/<mcp-path>` as the form its SDKs register. Surprising
   only if, like us, you curl the bare path before reading either.

7. **A second `alpic tunnel` displaces the first — the subdomain is per-account, not
   per-directory.** We read this as directory-bound. It isn't. `@alpic-ai/sdk`'s
   `Tunnel.open(opts)` uses only `opts.port`; the subdomain comes from a server-issued ticket
   (`api.tunnels.getTicket.v1()`, which takes no arguments) against the OAuth-authenticated
   account, and nothing in that path reads `.alpic/project.json`. It isn't silent either — the
   SDK models takeover explicitly, closing with `{ displaced: true }`, and `alpic tunnel` prints
   *"Tunnel closed: a new tunnel was opened for this account"*. So the real shape is one tunnel
   per account, and the displaced one says so. The stability we liked — a URL that survives
   restarts, which let us bake it into `SERVER_URL` — is a property of the account-scoped
   subdomain, not of the directory. Misread on our side, not a gap on theirs.

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

10. **A session that didn't survive the move to a public issuer, and a client-side failure that
    said nothing about it.** We first wrote this up as "restarting the AS invalidates sessions."
    That is wrong, and worth correcting rather than quietly dropping: AuthPlane sessions are
    signed cookies keyed on `session.secret` — `docs/guides/deploy/helm.md` says so plainly
    ("Sessions are signed cookies — no affinity needed") — and our `infra/config.yaml` pins that
    secret to a fixed value, so a restart cannot drop them. What actually changed in the same step
    was #8: the issuer moved from `http://localhost:9000` to the public HTTPS URL with
    `session.secure: true`, and the cookie we were carrying had been set on the old origin over
    plain `http://`. The browser was never going to present it to the new one. The restart was
    coincident, not causal.

    The finding that survives is the client-side half. Claude's connect flow failed with only
    `Authorization with PR RADAR failed … reference ofid_…`. Server-side the cause was plain —
    `/oauth/authorize` 303-ing to `/login` in a retry loop because there was no session — but
    nothing surfaced that to the user, and signing in again at `/login` fixed it instantly. We did
    not capture the cookie jar at the time, so the mechanism above is reconstruction from config,
    not something we observed directly.

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
    Broker. This is documented, and we should say so: `docs/concepts/broker-vs-mint.md` states
    "Fronting links are admin-API-only (no YAML config block)", and its "Coexistence in one
    deployment" section walks our exact topology — a Mint MCP resource alongside a `github`
    broker gated by `policy.exchange.allowed_client_ids` — then follows the YAML with the
    fronting-link curl. The gap is in the path, not the corpus: nothing on the route we actually
    took (quickstart → admin API → connect flow) points at that page, and we assembled the broker
    topology piece by piece instead of finding the one doc that describes it end to end. Fixed
    with a single admin call:

    ```
    POST /admin/fronting
    {"source":"pr-radar-live","target":"github","scope_map":{"radar:read":["public_repo","read:user"],"radar:nudge":["public_repo"]}}
    -> 201
    ```

    That `201` was valid when it was made, and the timing matters for reading #14: `github`
    declared `public_repo` **and** `read:user` at that moment. The full order, from the session's
    admin-API audit log, was — register `github` with `repo` + `read:user`; patch it to
    `public_repo` + `read:user`; create the fronting link above (**201**, because both target
    scopes were declared); patch the link to map both mint scopes to `["public_repo"]`; then patch
    the resource again to declare `public_repo` **only**, dropping `read:user`. Everything in #14
    happens after that last step.

    Three things stood out, in order of how useful they'd be to AuthPlane — two of which are
    on us, not them:

    - **On us: two steps that succeeded and looked terminal, so we stopped there.**
      Registering the Broker resource and completing the connect flow both succeed, and both
      look like the end of setup — you finish with a stored grant and reasonably conclude
      you're done. We did, and we were wrong. The lookup that would have told us already ships:
      `GET /admin/resources/{slug}/fronting` returns `fronts` and `fronted_by`, so an empty
      `fronted_by` on `github` was the answer sitting there the whole time. It only helps an
      operator who already suspects the answer, though. The cheap win is pushing the same fact
      rather than waiting to be asked — echo `fronted_by: []` in the `POST /admin/resources`
      response for a broker, or give it a line in the boot-time feature table that already tells
      an operator which subsystems are live.
    - **Credit due: `reason=fronting_link_missing` is a genuinely excellent error code.**
      `docs/topologies/mcp-gateway-broker.md` documents it with the exact fix, and once we had
      the reason string, resolution took minutes. The only gap: the client we were testing from
      surfaced nothing but a bare `400`.
    - **On us: a fallback we built ourselves hid the bug from us.** The tool degrades to a
      static token when the broker is unavailable. In the version we were running at the time
      that fallback was silent and unconditional — it returned correct-looking data from the
      fallback path, so nothing looked wrong until we went and read the AS audit log directly.
      We took our own lesson: the code that ships now logs
      `Using GITHUB_TOKEN fallback (<reason>)` and gates the branch behind
      `ALLOW_ENV_TOKEN_FALLBACK`, which is off by default, so an unconfigured exchange fails
      loudly rather than quietly succeeding (`app/src/github-token.ts`). For anyone else wiring
      a broker: log the token source explicitly and assert on it in testing, or a working
      fallback will hide a broken exchange.

    One more small thing, offered as a question rather than a finding. The CLI's `--scope-map`
    grammar separates source scope from target scopes with `:` (`--scope-map A:AA,B:BB`), and
    every documented example uses colon-free source names. We could not tell from the docs how
    something like `--scope-map radar:read:public_repo` is meant to split when the scopes
    themselves contain colons, as OAuth scopes commonly do (`radar:read`, `read:user`). We did
    not test it — we used the JSON admin API, which has no such ambiguity — so this is not a
    claim that the parser gets it wrong, only that the docs don't settle which way it goes. One
    worked colon-bearing example would.

14. **A fronting link cannot express an unscoped exchange, so a read-only consumer is
    forced to over-privilege.** `pr-radar`'s read path reads public pull request metadata
    through GitHub's GraphQL API. GitHub documents a token bearing no scopes as granting
    "read-only access to public information (including user profile info, repository info, and
    gists)", and documents `public_repo` as *read/write* access to public repositories — so the
    minimal ask here is plausibly nothing, and is certainly far less than `public_repo`. We can't
    put a number on "plausibly": GitHub's GraphQL guide says only that the data you request
    dictates the scopes you need, and we never confirmed the zero-scope floor empirically,
    because the config surface wouldn't let us express it in order to try.

    A dry-run call with an empty target list confirms it:

    ```
    POST /admin/fronting?dry_run=true
    {"source":"pr-radar-live","target":"github","scope_map":{"radar:read":[]}}
    -> 400
    scope_map entry radar:read must list at least one target scope
    ```

    Every mapped mint scope must map to at least one upstream scope — there's no way to
    say "exchange for a token with no upstream scopes." The fallback — map `radar:read` to
    a non-write GitHub scope like `read:user` instead of `public_repo` — is also closed:

    ```
    POST /admin/fronting?dry_run=true
    {"source":"pr-radar-live","target":"github","scope_map":{"radar:read":["read:user"]}}
    -> 400
    scope_map value "read:user" (under key "radar:read") is not a scope on target resource "github"
    ```

    The first response is the substantive constraint. The second compounds it: even a
    narrower, non-write value has to already be declared on the target resource. Worth being
    precise about why none was available, because we removed it ourselves. `read:user` *was*
    declared on `github` when the fronting link was first created — that's the `201` in #13 —
    and we dropped it in a later patch that narrowed the resource to `public_repo` only. So "no
    non-write value left to try" describes the state we had put the resource in, not a
    constraint AuthPlane imposed on us. The substantive point is unchanged: whatever the
    resource declares is the floor, and here that floor is `public_repo` — read *and* write to
    public repositories, for a query that needs neither.

    **Why it matters.** The narrowest thing a read-only consumer can be granted is bounded
    by whatever the broker resource declares, not by what the consumer actually needs. If
    the only scope declared on a resource is write-capable, every read consumer inherits
    write capability it will never use, no matter how tightly its own mint-side scope is
    defined. That's backwards for what a token broker is for — brokering exists precisely
    so the downstream token carries less than the upstream grant, not the same privilege
    under a different name.

    Suggested fixes, as options rather than a single ask: (a) allow an empty target list in
    `scope_map`, meaning "exchange for a token with no upstream scopes"; (b) if that's
    unsafe as a default, gate it behind an explicit opt-in on the target resource; (c) at
    minimum, document that the achievable floor for any consumer is the narrowest scope
    already declared on the broker resource, so an operator wiring up a read-only consumer
    knows to declare a deliberately harmless one.

    We kept `public_repo` on the `github` resource rather than restructure it
    mid-challenge, so `pr-radar`'s read exchange requests more than it needs. Worth saying
    plainly: this is a gap we left open, not one we solved.

15. **Two AuthPlane docs disagree on the fronting-link request body.**
    `docs/concepts/broker-vs-mint.md` — the page that walks the Mint-plus-Broker topology, and
    the one an operator following the concepts path would copy from — posts
    `{"source_slug": …, "target_slug": …}`. The DTO reference declares the required fields as
    `source`, `target`, `scope_map` (`createFrontingLinkRequest`, `api/admin/dto.go`), and
    `docs/topologies/mcp-gateway-mint.md` uses that form, as did the call that worked for us.
    We did not run the concepts-page curl verbatim, so we can't say whether the handler
    tolerates both — but if it doesn't, the copy-paste path fails on a page that is otherwise
    the best end-to-end description of this topology in the docs.

## Things that were notably good

- **The boot-time feature self-check.** authserver prints a table of the subsystems it tracks —
  we noted `data_encryption`, `connect`, `token_exchange`, `client_credentials`, `dpop`, `dcr`,
  and seeded resources — with enabled/disabled and *why*. It answered "is token exchange actually
  on?" before we had to ask. Not exhaustive, though: `xaa` was not among what we saw, which is
  exactly why #9's fix wasn't visible at boot. That's the argument for widening the table, not a
  mark against it.
- **Dynamic Client Registration just worked** — one unauthenticated POST to `/oauth/register`
  returned a usable `client_id` for a Claude callback URL, no dashboard round-trip.
- **Protected-resource and AS discovery metadata are served automatically, no
  hand-authoring needed** — both endpoints come up correctly out of the box, and
  `resource`/audience binding is correct by default. One gap: PRM `scopes_supported` is the
  AS's global union across every registered resource, not scoped to this one (see #12) —
  invisible until a second resource exists.
