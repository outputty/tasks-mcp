# The provider stack

How tasks are stored and reconciled: the layers, the stack rules, and the patterns every
provider follows. The task ↔ GitHub wire format belongs to
[body block](github-mapping.md); the graph questions belong to [graph engine](graph-engine.md).

```mermaid
flowchart TB
    call["TaskStack (orchestrator)"] -->|"every read"| file["FileProvider — top layer\n&lt;cacheDir&gt;/&lt;repo&gt;-&lt;hash&gt;.yaml"]
    call -->|"writes fan down"| file
    call -->|"writes fan down"| gh["GitHubProvider — deepest = truth\nissues + board, GraphQL only"]
    gh -.->|"sync: deepest wins,\nmerged truth pushed back up"| file
```

## provider stack

`TaskStack` orchestrates `Provider[]`, built by `buildStack(remote, options, config)` —
`[FileProvider, GitHubProvider]` in production, three layers in the stack test suite. Order is
authority order: every read is answered by the top layer; the deepest layer wins any sync
disagreement, and the merged truth is pushed back into each layer that lacks a task or
disagrees.

The other two rules: **absence is not a claim** — a task missing from a layer (an empty, newly
added layer included) is pushed into it, never deleted from the others, which makes adding a
layer a free migration — and **deletions never propagate**: a task can close everywhere but
only vanishes by hand.

### Example

`tasks-mcp sync --project /abs/repo` → `{ "pulled": 8, "pushed": 0, "conflicts": 0 }`
(the `sync` example in `examples.yaml`, real observed on this repo).

### Gotchas

- Registered remotes live in one table (`REMOTES` in `src/core/providers/provider.ts`); an
  unknown `--provider` fails loudly naming the known ones. Only `github` exists today.
- The stack is memoized per remote inside `TaskStack`; `buildStack` is a pure builder.

## file layer

`FileProvider`, the top of the stack: one YAML file per project under the OS cache dir
(`XDG_CACHE_HOME` or `~/.cache/tasks-mcp`, overridable with `--cache-dir`), keyed
`<basename>-<hash>.yaml` — never inside the user's repo. Every read tool (`list_ready`,
`prereqs`, `blockers`, …) is answered here: instant, offline, no network.

The file is disposable by design: `sync` reconstructs the full task, deps included, from the
layers below. A legacy `refs:` key in an old cache file still loads and is dropped on read.

### Example

The `ready-and-planning` example in `examples.yaml` — both answers come from this file alone.

### Gotchas

- Deleting the file loses nothing, but until the next sync the project reads as empty.
- `upsertMany` does one read + one write for a batch; sync uses it.

## GitHub layer

`GitHubProvider`: one issue per task, a card on the Projects v2 board, GraphQL end to end. It
wraps its own Octokit; the client is the one injection point (constructor parameter, defaulted
for production, passed by tests). A private index — task id → issue/card node ids, built from
one paginated listing pass and refreshed by every pull — keeps every GitHub handle below the
seam, so a same-id upsert can never duplicate an issue.

### Example

The `add-task` example in `examples.yaml`: the created issue's labels and body block, observed
live on issue #13 of outputty/tasks-mcp.

### Gotchas

- Issues are primary, the board best-effort — see [orchestrator/executor](#orchestratorexecutor).
- `updateIssue` re-sends the whole label set (foreign labels collected and preserved); it also
  pre-fetches the current body + labels per update — tracked as task `update-issue-prefetch`.

## corrupt-file quarantine

An unparseable task YAML is renamed `.corrupt` instead of failing every read: the file layer
continues empty, and the next `sync` rebuilds it from the layers below — safe under the stack
rules, since absence is not a claim and GitHub is deeper. Empty and header-only files read as
empty, not corrupt.

### Gotchas

- The `.corrupt` file is kept for inspection, not deleted.

## first-wins duplicates

When two issues claim one task id (a race, or a hand-written block), every read and write
resolves deterministically to the OLDEST issue. `collate()` owns the rule once for both the
pull map and the upsert index. The collision is logged, flagged per task
(`ProviderState.conflict`), and `SyncResult.conflicts` reports the real count. Nothing is
auto-deleted; merging or closing the newer duplicate is a human call.

### Gotchas

- Before v0.8.0 the NEWEST silently shadowed the record and `conflicts` was hardwired 0 — see
  `lessons.yaml`.

## init-once

There are no async constructors, so every provider has an explicit `async init(ctx)`:
credentials, the repo behind `origin`, the repository node id, the label set, and the board
(found or created) all resolve there, once per project — never lazily inside task calls. Reads
never trigger it; the first write or `sync` does. A memoized FAILED init is forgotten so the
next call retries.

## orchestrator/executor

A public method orchestrates: it sequences executor calls and assumes no knowledge of their
implementation (`create` = issue then board; `sync` = pull, merge, push). Executors
(`createIssue`, `syncToBoard`, `mergeRemote`, …) own the specific logic and let errors bubble.
The orchestrator catches only where business logic demands a fallback the executor cannot
decide: the board is best-effort, so board errors are caught and logged at the orchestration
seam while issue errors always propagate.

## one class per provider

Every provider is ONE class in ONE file implementing the `Provider` seam, wrapping its own API
client — no satellite modules (client/issues/projects were folded into `GitHubProvider` by
request; `ConfigProvider` sits beside the layers in `providers/config.ts`). All imports are
top-level; no lazy `await import(...)`.

## GraphQL-only

The GitHub layer speaks GraphQL only (user ruling 2026-08-17): one protocol, one kind of
handle (node ids) end to end. The board half is forced anyway — as of 2026-08, REST cannot
create a Projects v2 board, link one to a repo, or list a repo's linked boards. Do not port
issues to `octokit.rest.*`.

### Gotchas

- Re-verify the REST gap against GitHub's docs before ever revisiting this ruling.
- Label mutations still need a preview accept header — see
  [label mutations need a preview header](github-mapping.md).
