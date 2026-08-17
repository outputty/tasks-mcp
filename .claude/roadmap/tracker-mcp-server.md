# The task tracker as a local MCP server (roadmap #1)

A coding agent can call a dependency-aware task tracker as typed MCP tools, and every task it
files appears on GitHub — one issue per task, a card on a Projects v2 board — where a human can
read it, close it, or open new issues that the tracker adopts on the next sync.

## Before / After

Before: the tracker was `tasks.js` inside outputty's plugin — a script one repo could run, no
server surface, no GitHub mirror, the graph invisible to humans.

After: `.mcp.json` registers `npx -y @outputty/tasks-mcp` (see the `mcp-registration` example
in `examples.yaml`); `add_task` lands a task as a managed issue; `sync` reconciles both ways,
adopts hand-opened issues as `gh-<number>`, and rebuilds a deleted cache from GitHub.

## The arc

Five commits, four versions, one day (2026-08-17):

- `808cab2` (v0.1.0) — initial import: bun + hono, pure graph engine ported from tasks.js,
  GitHub Issues via Octokit, id worn as a label, hand-rolled minimal MCP over Streamable HTTP.
- `d000f7b` (v0.2.0) — v2: a committed `.claude/tasks.cache.yaml` became the authority and the
  only home of the dep graph; Issues + Projects became two-way sync targets behind a port.
- `60820a3` (v0.2.0) — all-GraphQL; the id-label dropped for the body block; one `Provider`
  seam bundling Issues (primary) and the board (best-effort).
- `3d8a5b3` (v0.3.0) — true two-way: the board read back (a card in Done marks the task done),
  hand-opened issues adopted and stamped. Verified live against real GitHub.
- `1dac343` (v0.4.0) — the cache left the repo for the OS cache dir and became disposable:
  sync reconstructs the full task, deps included, from the issue bodies.

The committed-cache-as-authority idea (v0.2) was reversed within the same day (v0.4) — the
cache is valuable as a disposable local answer, not as the record. `lessons.yaml` carries it.

## Where the record lives

- Code: `src/core/graph.ts` (pure engine), `src/core/service.ts`, `src/core/providers/`.
- Tests: the 53-test e2e suite (`npm test`), nock at api.github.com, real `git init` temp dirs.
- Docs: `README.md`, `docs/architecture.md` (sync semantics, task ↔ GitHub mapping).
