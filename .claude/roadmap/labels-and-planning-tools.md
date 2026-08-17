# Labels, the two questions, central config (roadmap #5)

A task's execution properties are visible, filterable `field:value` labels on its GitHub issue
— editable there and pulled back by sync; the graph answers its two planning questions through
dedicated tools; preferences are configured centrally through the server, never by files in
the user's repo.

## Before / After

Before: execution properties hid in the body block; the graph had `ready`/`schedule` but could
not answer "what must be done before X" or "what blocks the most work"; configuration was CLI
flags plus an in-repo `.claude/tasks-mcp.config.yaml`.

After: kind/tier/qa/spec/stage/priority are labels (`tier:2`, `priority:high`), created on
demand and color-coded per field; foreign labels never touched; `tier:banana` ignored, not
crashed on. `prereqs` returns dependency-ordered layers; `blockers` ranks by transitive
downstream impact with `unblockedBy` and `highPriorityBlocked`. `ConfigProvider` stores a
global spec plus per-repo overrides beside the caches (defaults < flags < global < per-repo),
read live so `set_config` affects the very next write. Real observed: 12 MCP tools registered;
label round-trip and junk-label tests green within the 53.

## The arc

PR #11 (`4c11121`, v0.8.0), six internal steps: labels + the two tools + graphology +
commander + zod config; ConfigProvider centralization (the in-repo config file removed); the
architecture SVG redrawn as a swimlane; corrupt-file quarantine and first-wins duplicate-id
resolution with real conflict counts; a four-angle simplification pass (value domains stated
once in `types.ts`, one `buildTask` for every surface, batched per-layer writes, mtime-memoized
config); ConfigProvider moved beside the other providers as `providers/config.ts`.

One noted-not-fixed item from the review: reusing pull's listing to skip `updateIssue`'s
pre-fetch (staleness risk, larger surgery) — filed as a task by bootstrap.

## Where the record lives

- Code: `src/core/providers/config.ts`, `src/core/graph.ts` (graphology reachability),
  `bin/cli.ts` (commander), `src/core/types.ts` (the value domains, stated once).
- Tests: label round-trips, junk tolerance, both questions over real MCP HTTP.
- Docs: `README.md` (the two questions with real shapes), `docs/architecture.md` (mapping
  table), `docs/cli.md`.
