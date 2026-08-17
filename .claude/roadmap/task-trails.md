# Per-task trails — the GitHub issue comment thread (roadmap #6)

A task's trail is its **GitHub issue comment thread**: the decisions and actions behind a task live as
comments on the issue, so a later session can backtrack *why*. `append_trail` posts a comment;
`get_trail` reads the whole thread; every comment is an entry.

## Before / After

Before: the MCP server tracked tasks but not the reasoning behind them. outputty's original plugin
paired task tracking with per-branch trails; that backtracking was lost when tasks moved to the MCP
server. A task's history was only `attempts`.

After: trails ride the **same GitHub layer as tasks**. The `Provider` seam gained optional
`getTrail` / `appendTrail`; `GitHubProvider` implements them over GraphQL — `appendTrail` → `addComment`
on the issue, `getTrail` → the issue's `comments` connection. The `FileProvider` has none, so the
service routes trail calls to the deepest layer that backs them (GitHub). Two CLI commands mirror them
(`trail-add`, `trail`). Real observed (v0.10.0, e2e/nock suite): a `decision` comment round-trips its
`kind` and `link`; a plain comment comes back as `{ note, author, at }`.

## The arc

Two designs, one cycle. The **first cut (v0.9.0, merged in PR #21 but never released)** stored trails in
a local `.trails/<id>.yaml` file, append-only, never synced — chosen so decision prose stayed local. On
review the user reversed it: **back trails with GitHub issue comments, one provider for tasks and their
trails** (rulings 2026-08-17). Two calls settled the shape:

1. **One provider, not a separate store.** The provider that owns the issue owns its comments — so the
   standalone `TrailStore` and the local file are gone, and trails are just an aspect of the GitHub
   layer.
2. **Every comment is an entry.** `get_trail` returns the whole thread, people's comments included.
   `kind`/`link` are optional and ride a hidden `<!-- outputty:trail … -->` marker on the comments
   outputty writes — invisible on GitHub, parsed back on read — so a plain human comment reads as a bare
   `note` plus its GitHub `author` and timestamp.

Consequences accepted: trails need a GitHub-backed project, `append_trail` requires the issue to exist
(sync first), and reads hit the network — there is no local trail cache.

## Where the record lives

- Code: `src/core/providers/github.ts` (`getTrail`/`appendTrail`, `addComment`, the comments query, the
  marker codec), `src/core/providers/provider.ts` (the seam), `src/core/service.ts` (`trailLayer`
  routing), `src/mcp/server.ts` (the two tools), `bin/cli.ts` (`trail`/`trail-add`), `src/core/types.ts`
  (`TrailEntry`, `TRAIL_KINDS`).
- Tests: `test/trails.test.ts` (the real stack, nock at the wire) and the trail cases in
  `test/mcp.test.ts` (over real HTTP); `test/nock-github.ts` fakes `addComment` + the comments query.
- Docs: `README.md` (Trails section), `docs/architecture.md` + `docs/trails.svg`,
  `.claude/architecture/trails.md`.
