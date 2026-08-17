# Per-task trails — a local, append-only decision journal (roadmap #6)

Every task gains a trail: an append-only journal of the decisions and actions behind it, so a
later session can backtrack *why*. Trails are durable local memory — one YAML file per task in
`.trails/<id>.yaml` at the repo root — deliberately outside the provider stack and never synced.

## Before / After

Before: the MCP server tracked tasks but not the reasoning behind them. outputty's original
plugin paired task tracking with per-branch trails (`trails/<branch>.trail.yaml`); that
backtracking was lost when tasks moved to the MCP server. A task's history was only `attempts`.

After: `TrailStore` owns a per-task journal — `append_trail` adds one `{ kind, note, link? }`
entry (kind `decision` · `action` · `note`), `get_trail` reads it oldest-first. Two CLI commands
mirror them (`trail-add`, `trail`), and `TrailStore` is exported for the library. Real observed
(v0.9.0): two appends then a read return the journal in order; the on-disk file is header-stamped,
append-only YAML.

## The arc

Two user rulings (2026-08-17) shaped it:

1. **Granularity — per-task, not per-branch.** The old trail grouped a whole branch; the MCP
   server is task-centric (the branch param was just removed), so the trail attaches to the task.
2. **Storage — repo-root `.trails`, path configurable.** Chosen over a GitHub-synced or
   cache-only home, so decision prose stays local and committable. `trailsDir` resolves with full
   config precedence; a `--trails-dir` flag sets it too.

The load-bearing decision is **text-append, never rewrite**: `TrailStore.append` concatenates one
YAML list item and never touches an earlier byte. This honors — rather than reverses — the reason
the original `tasks.js` refused to write trails at all: a full re-serialize flattens `|` block
scalars and destroys hand-authored prose. Because the tool only ever *adds*, hand-editing a trail
between appends is safe. Trails sit outside the stack, so `sync` never touches them and a corrupt
trail fails loud (nothing rebuilds it) rather than being quarantined like the cache.

## Where the record lives

- Code: `src/core/trails.ts` (`TrailStore`), `src/core/service.ts` (`getTrail`/`appendTrail`),
  `src/mcp/server.ts` (the two tools), `bin/cli.ts` (`trail`/`trail-add`), `src/core/types.ts`
  (`TrailEntry`, `TRAIL_KINDS`, `trailsDir`).
- Tests: `test/trails.test.ts` (store + service, network-free) and the trail cases in
  `test/mcp.test.ts` (over real HTTP). 63 tests total, +10 over v0.8.0.
- Docs: `README.md` (Trails section), `docs/architecture.md` (the design contrast),
  `.claude/architecture/trails.md` (the deep record).
