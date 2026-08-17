# npm distribution with tokenless publishing (roadmap #2)

Anyone can run the server with `npx -y @outputty/tasks-mcp` — no clone, no install step — and
publishing a new version is a deliberate GitHub Release, authenticated by OIDC with no stored
npm token anywhere.

## Before / After

Before: a bun-only server inside its own checkout; Bun.YAML, Bun.serve, Bun.hash throughout;
tests could not use nock (it cannot intercept Bun's fetch).

After: Node-native (`yaml`, `node:crypto`, `node:child_process`, process streams), runs under
Node ≥ 18 or bun. `src/core/` is the library (`.`), `src/mcp/` the wrapper (`./mcp`),
`bin/cli.ts` the `tasks-mcp` bin. Real observed: `npm view @outputty/tasks-mcp version` ->
`0.8.0`, with 0.5.0/0.6.0/0.7.0/0.8.0 all served by the registry.

## The arc

- `351b2e8` (v0.5.0) — the split, the Node port, nock e2e tests (the reason the runtime moved),
  CI + publish workflows.
- `b50b486` — npm Trusted Publishing (OIDC) replaced the NPM_TOKEN secret; provenance automatic.
- `88d72c9` — publish trigger moved to a pushed version tag… `7e72465` — …and settled on the
  Release event: pushing code never publishes, only publishing a GitHub Release does.
- `73a4275` — CLAUDE.md rule: always ask before releasing; never publish unprompted.

## Where the record lives

- Workflows: `.github/workflows/ci.yml` (push/PR -> `npm run check`), `publish.yml`
  (release published -> guarded `npm publish` via OIDC).
- Docs: `docs/development.md` (Releasing), `CLAUDE.md` (the ask-first rule).
- Manifest: `package.json` exports `.`, `./mcp`, bin `tasks-mcp`, engines node >= 18.
