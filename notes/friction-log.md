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
