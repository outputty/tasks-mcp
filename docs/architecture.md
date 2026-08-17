# Architecture

The package is split into a **core** (all the business logic, importable as a library) and a thin
**MCP wrapper** over it. The core's centre is the **provider stack**.

The swimlane below reads like the system runs: rows are the layers, columns are the stages of one
call — down a stage column, then right to the next stage.

![tasks-mcp architecture: the provider stack](architecture.svg)

## The provider stack

Every layer implements one seam — `init` / `pull` / `upsert` — and the `TaskStack` service
orchestrates them as an ordered list, top-first:

- **`FileProvider` (top).** One YAML file per project under the OS cache dir
  (`<cacheDir>/<repo>-<hash>.yaml`), never in the repo. Every read is answered here, so `list_ready`,
  `prereqs`, and `blockers` are instant and work offline. The file is disposable: `sync` rebuilds it
  from the layers below.
- **`GitHubProvider`.** One issue per task, a Projects v2 board card per issue, all over GraphQL. The
  layer keeps a private index (task id → issue/card node ids) built from one listing pass, so nothing
  above the seam ever sees a GitHub handle and a same-id write can never duplicate an issue.
- **Any further layer.** The machinery is N-layer: tests run a three-layer stack. Adding a layer is a
  free migration — the next `sync` backfills it with every task.

Three rules govern the stack (and are pinned by tests):

1. **Deepest wins.** `sync` pulls every layer, merges with the deepest layer taking precedence on any
   disagreement, then pushes the merged truth back into each layer that lacks a task or disagrees. An
   issue closed in the GitHub UI beats the local file on the next sync.
2. **Absence is not a claim.** A task missing from a layer — including an empty, newly added layer —
   is pushed into it, never deleted from the others.
3. **Deletions never propagate.** A task can close everywhere, but only vanishes by hand.

The service is an orchestrator: it sequences layer calls and knows nothing of their internals. Errors
bubble; the only catches sit where business logic demands a fallback (the board is best-effort — a
board hiccup is a warning, never a lost task).

## The task ↔ GitHub mapping

A task's full record round-trips through its issue, split across three homes:

| Task field                                                                | GitHub home                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `id`, `deps`, `scope`, `brief`, `contract`, `attempts`, `discovered_from` | a hidden YAML block leading the issue body (`id` first — the stable key) |
| `kind`, `tier`, `qa`, `spec`, `stage`, `priority`                         | **labels**, one `field:value` each (`tier:2`, `priority:high`, …)        |
| `title` / `status`                                                        | issue title / open ↔ closed                                              |

An issue is "managed" iff its body carries the block. Prose a human writes below the block is
preserved across updates.

**Labels are first-class.** They make the execution properties visible and filterable in the GitHub
UI, and they are writable there too: change `tier:2` to `tier:1` on the issue and the next `sync`
pulls it into the task. Missing labels are created on demand (color-coded per field); labels the
tracker does not manage (`bug`, `help wanted`, …) are never touched; a hand-typed junk value
(`tier:banana`) is ignored rather than crashed on. Labels win over a legacy body block that still
carries those fields.

## The kanban board (GitHub Projects v2)

Each task-issue is added to a Projects v2 board and its **Status** column tracks the task
(`open → Todo`, `done → Done`) — and flows back: a card dragged to Done marks the task done on the
next `sync`. By default the server finds or creates a board named **Tasks** linked to the repo; point
it at an existing board with `projectNumber`, or turn it off with `--no-projects`.

The board needs the token's `project` scope (`gh auth refresh -s project`). Without it the board is
skipped with a warning and issues remain the status source.

## Sync semantics

`sync` reconciles every layer of the stack both ways:

- **Status converges.** A task is done when its issue is closed or its card sits in a Done column;
  `sync` writes that everywhere — cache, issue state, card column all agree after.
- **Hand-opened issues are adopted.** Any repo issue without the block is imported as a task
  (`gh-<number>`) and its body stamped, so it is tracked from then on.
- **Offline tasks are pushed.** A task added while a layer was unreachable is created there on the
  next `sync`.
- **A new layer backfills.** Adding a layer to the stack is configuration, not migration tooling.

## Configuration — its own provider

The server carries no user preferences of its own: `ConfigProvider` is a class of its own, and the MCP
tools `get_config` / `set_config` are its surface. Preferences are stored beside the task caches —
one **global spec** (`<cacheDir>/config.yaml`) applying to every repo, overridable per repo
(`<cacheDir>/<repo>-<hash>.config.yaml`). Precedence, weakest first: defaults < CLI flags < global
spec < per-repo override. Every provider layer reads the same ConfigProvider, so a preference set
centrally propagates to all of them — label preferences are read live, taking effect on the very next
write. Files are zod-parsed; unknown keys and mistyped values fail loudly with the file's path.

## Init

There are no async constructors, so each layer has an explicit `init(ctx)`: everything remote is
resolved once per project — the repo behind `origin`, config, the repository node id, the label set,
and the board (found or created). Reads never trigger it; the first write or `sync` does.

## The graph engine

`ready`, `planning`, `schedule`, `prereqs`, and `blockers` are pure functions of a `Task[]` — no I/O,
no provider. Reachability (`prereqs`, `blockers`) runs on [graphology](https://graphology.github.io/);
traversal prunes at done tasks, because a finished task already satisfied its side of the graph.
