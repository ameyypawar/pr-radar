# PR Radar

An **MCP App** that triages your open pull requests across every upstream repo you contribute to, and tells you which ones are *waiting on you*.

Built for the [AuthPlane × Alpic speedrun challenge](https://www.authplane.ai/challenge/) with
[Skybridge](https://github.com/alpic-ai/skybridge) (TypeScript/React MCP App framework) and
[AuthPlane authserver](https://github.com/authplane/authserver) (open-source OAuth 2.1 authorization server).

## The problem

If you contribute to open source, your open PRs scatter across upstream repos and you lose track of
which ones actually need *you* next — versus which are sitting with a maintainer. GitHub's own
notification surface doesn't answer that question.

PR Radar answers it inside Claude.

## Auth architecture

Two distinct OAuth layers, both handled by AuthPlane:

**1. Inbound — Claude to the app.** AuthPlane mints an access token bound to this server via an
RFC 8707 resource indicator. Skybridge's `authplaneProvider` verifies it against AuthPlane's JWKS
and enforces auth at the transport: unauthenticated requests to `/mcp` get **HTTP 401** before any
tool handler runs. Client registration is dynamic (RFC 7591), so the MCP client registers itself.

**2. Outbound — the app to GitHub.** The tool exchanges the user's token for a real GitHub access
token via RFC 8693 token exchange against an AuthPlane *Broker* resource. The GitHub refresh grant
is encrypted at rest inside AuthPlane and never reaches this server.

Scopes are enforced per tool: `radar:read` to view your radar, `radar:nudge` for the write-capable tool — a dry run today.

## Running the authorization server

AuthPlane authserver ships as a prebuilt image; there's no compose file or
Dockerfile in this repo for it (the only Dockerfile here is `app/Dockerfile`,
for the MCP App itself). `infra/config.yaml` is the server's tracked
*configuration* — everything the broker story needs at runtime is *data*
that lives only in the container's SQLite volume, so bringing up a working
server from a clean clone is two steps: start the container, then run
`infra/setup.sh` to populate that data.

**1. Create `infra/.secrets.env`** (gitignored — never commit it) with:

```
AUTHPLANE_ADMIN_API_KEY         # bearer token for the :9001 admin API
AUTHPLANE_SESSION_SECRET        # session cookie signing key
AUTHPLANE_DATA_ENC_KEY          # hex-encoded; e.g. `openssl rand -hex 32`
AUTHPLANE_CONNECT_STATE_SECRET  # >=32 chars; e.g. `openssl rand -hex 32`
AUTHPLANE_ISSUER                # public issuer URL for this server
AUTHPLANE_REDIRECT_BASE_URL     # base URL for /connect/{provider} callbacks
AUTHPLANE_APP_URL               # this app's public URL (used as the
                                 # pr-radar-live resource's base URI)
CONNECTOR_GITHUB_CLIENT_ID      # your GitHub OAuth App's client id
CONNECTOR_GITHUB_SECRET         # your GitHub OAuth App's client secret
```

`AUTHPLANE_ISSUER` / `AUTHPLANE_REDIRECT_BASE_URL` also need to match what's
hardcoded in `infra/config.yaml`'s `server.issuer` / `connect.redirect_base_url`
(config.yaml isn't templated from these env vars — they're passed to the
container as-is, for tooling that reads them directly). Update both places
together if the issuer changes.

**2. Start the container** (tested against `authplane/authserver:latest`,
resolving to v0.1.1 at time of writing):

```bash
set -a; source infra/.secrets.env; set +a

docker run -d \
  --name authserver \
  -p 9000:9000 -p 9001:9001 \
  -v "$(pwd)/infra/config.yaml:/config.yaml:ro" \
  -v authserver-data:/data \
  -e AUTHPLANE_ADMIN_API_KEY \
  -e AUTHPLANE_SESSION_SECRET \
  -e AUTHPLANE_DATA_ENC_KEY \
  -e AUTHPLANE_CONNECT_STATE_SECRET \
  -e CONNECTOR_GITHUB_SECRET \
  -e AUTHPLANE_ISSUER \
  -e AUTHPLANE_REDIRECT_BASE_URL \
  -e AUTHPLANE_APP_URL \
  authplane/authserver:latest serve --config /config.yaml
```

Port 9000 is the public OAuth surface, 9001 is the admin API. The named
volume `authserver-data` is where the SQLite DB and signing keys persist
across restarts — `docker rm` the container freely, but keep the volume.

**3. Populate the data plane:**

```bash
./infra/setup.sh
```

This registers the GitHub broker provider, the `github` broker resource and
its scope catalogue, the `pr-radar-live` mint resource, the confidential
client that performs the token exchange, the two policy bindings that
authorize it, and the fronting link between the two resources — the objects
`infra/config.yaml` alone can't recreate. It reads every credential from the
environment (sourcing `infra/.secrets.env` itself if the variables aren't
already exported), and it's safe to re-run: each step checks whether its
object already exists before creating it, so a re-run against an
already-configured server just reports what it found and changes nothing.
The one exception worth knowing about — the confidential client has no
natural key to check against (the admin API assigns its `client_id` and
shows `client_secret` exactly once), so `setup.sh` persists both into
`infra/.secrets.env` as `PR_RADAR_SERVER_CLIENT_ID` /
`PR_RADAR_SERVER_CLIENT_SECRET` on first creation and checks that exact id
on every later run.

## Layout

```
app/     Skybridge MCP App (server tools + React views)
infra/   AuthPlane authserver config + setup (prebuilt image, no local Dockerfile)
notes/   Setup timings and friction log
```

## Status

Work in progress — built live during the challenge window.

## License

MIT
