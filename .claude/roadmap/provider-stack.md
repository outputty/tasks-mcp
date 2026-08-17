# The provider stack — layered truth, free migrations (roadmap #4)

Tasks live in an ordered stack of provider layers behind one seam: the file layer on top
answers every read locally, remotes sit beneath, and the deepest layer wins any sync
disagreement — which makes adding a layer a free migration and the local file disposable.

## Before / After

Before: `CachedTaskService` hardwired one cache + one provider; remote handles (`refs`)
traveled through the shared model; an empty new backend meant migration tooling.

After: `TaskStack` orchestrates `Provider[]` — `[FileProvider, GitHubProvider]` in production,
three layers in the stack test suite. The seam is `init` / `pull` / `upsert`; each layer keeps
its handles in a private index built from one listing pass, so a same-id upsert can never
duplicate an issue. Real observed: the stack suite (within the 53) shows a task present only
in the deepest MockProvider backfilled into every layer above on sync.

## The arc

PR #10 (`382939c`, v0.7.0), implementing three user rulings dated 2026-08-17:

1. Deepest wins — the merged truth is pushed back into every layer that lacks a task or
   disagrees.
2. Absence is not a claim — missing means push it in, never delete elsewhere; deletions never
   propagate.
3. Handles are the layer's own — nothing above the seam sees an issue or card id; legacy cache
   files with a `refs` key still load, the key dropped on read.

Breaking for the library: `CachedTaskService` -> `TaskStack`; `Cache`/`Refs`/`CacheEntry`/
`providerFor` gone; `stackFor`/`FileProvider` exported.

## Where the record lives

- Code: `src/core/providers/provider.ts` (`buildStack`, the seam), `file.ts`, `github.ts`,
  `src/core/service.ts` (`TaskStack`).
- Tests: the dedicated three-layer stack suite with `MockProvider` as the deepest layer.
- Docs: `docs/architecture.md` (the three stack rules, the swimlane SVG).
