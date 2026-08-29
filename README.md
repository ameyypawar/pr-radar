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

Scopes are enforced per tool: `radar:read` to view your radar, `radar:nudge` for the write action.

## Layout

```
app/     Skybridge MCP App (server tools + React views)
infra/   AuthPlane authserver config (Docker)
notes/   Setup timings and friction log
```

## Status

Work in progress — built live during the challenge window.

## License

MIT
