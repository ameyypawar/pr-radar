# PR Radar — App

The Skybridge MCP server for PR Radar: the tools and views that triage a user's open pull
requests and surface which ones are waiting on them.

See the [root README](../README.md) for the auth architecture (AuthPlane inbound/outbound
OAuth) and overall project layout.

## Local development

```bash
npm install
npm run dev
```

Starts the MCP server at `http://localhost:3000/mcp` and the Skybridge DevTools UI at
`http://localhost:3000`. Use `npm run dev:tunnel` to also expose the server publicly, e.g. to
test against a real MCP client.

## Environment variables

Copy `.env.example` to `.env` and fill in:

- `AUTHPLANE_ISSUER` — AuthPlane authorization server issuer URL
- `SERVER_URL` — this server's public resource URL (e.g. `http://localhost:3000/mcp`)
- `GITHUB_TOKEN` — GitHub PAT fallback for local dev (optional). Inert without `ALLOW_ENV_TOKEN_FALLBACK` also set.
- `AUTHPLANE_CLIENT_ID` / `AUTHPLANE_CLIENT_SECRET` — token-exchange broker client credentials (optional)

See `src/env.ts` for which are required vs. optional.

## Deploy

```bash
npm run deploy
```

Pushes to [Alpic](https://alpic.ai/).
