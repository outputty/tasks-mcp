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

An issue is "managed" iff its body carries the block. Below the hidden block, the body renders a
**visible, concise summary** — the brief (the problem and expected solution), then **What to account
for** (the contract) — wrapped in `<!-- outputty:spec -->` sentinels and **regenerated on every write**,
so the issue reads cleanly in GitHub's web UI. Metadata (scope, deps) stays in the block, not the
summary. The regenerated region is stripped on read; genuinely human-written prose below it is preserved
across updates.

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
- **Duplicates are detected, never deleted.** If two issues ever claim the same task id (a race, or a
  hand-written block), every read resolves deterministically to the OLDEST issue, the collision is
  logged, and `sync` counts it in `conflicts` — merging or closing the newer duplicate is a human
  call.
- **A corrupt task file self-heals.** An unparseable YAML file is quarantined (renamed `.corrupt`)
  instead of crashing reads; the layer continues empty and the next `sync` rebuilds it from the
  layers below — safe because absence is not a claim and GitHub is deeper.

## Trails — the issue comment thread

A task's **trail is its GitHub issue comment thread**. There is no separate trail store: the provider
that owns the issue owns its comments, so trails ride the same GitHub layer as tasks. `append_trail`
posts a comment (`addComment`); `get_trail` reads the issue's `comments` connection — GraphQL, like the
rest of the layer. The `FileProvider` has no comment surface, so the service routes trail calls to the
deepest layer that backs them (GitHub).

![The trail flow: append_trail checks the task has an issue and posts a comment via addComment; get_trail reads the issue's comment thread back, oldest first](trails.svg)

**Every comment is an entry**, people's included, so `get_trail` returns the whole discussion. `kind`
and `link` are optional and ride a hidden `<!-- outputty:trail … -->` marker on the comments outputty
writes — invisible in GitHub's rendered view, parsed back on read — so a plain human comment reads as a
bare `note` plus its GitHub `author` and timestamp. Consequences: trails need a GitHub-backed project,
`append_trail` requires the issue to exist (sync first), and reads hit the network — there is no local
trail cache.

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

`ready`, `planning`, `schedule`, `prereqs`, `blockers`, and `eligible` are pure functions of a
`Task[]` — no I/O, no provider. Reachability (`prereqs`, `blockers`, `eligible`) runs on
[graphology](https://graphology.github.io/); traversal prunes at done tasks, because a finished task
already satisfied its side of the graph.

`eligible` ranks the ready tasks by `(blocks + 1) × priorityWeight` — high 3, normal 2, low 1.
Priority **multiplies** reach rather than outranking it, so a low task blocking five beats a high task
blocking none, while priority decides between tasks of comparable reach. The ranking is a default
order for a caller to start from, never the decision: an orchestrator re-reads its own roadmap before
it chooses, and the roadmap is not a concept this package has.

## The channel — one doorbell, two hops

The MCP server declares the `claude/channel` capability, so Claude Code registers a notification
listener and the server can push `notifications/claude/channel` into a live session.
`claude/channel/permission` is deliberately **not** declared: relay forwards tool-approval prompts to
whoever is on the other end of a channel, and here that is a spool file, not a human.

Exactly one event exists, and it carries no state. Channel events are delivered on the session's next
turn and batched, so any count stamped at emit time would be stale by the time it is read; the reader
calls `list_ready` instead. Two mechanisms carry a ring, because a worker session and an orchestrator
never share a process:

| Hop           | Mechanism                                                            | Where             |
| ------------- | -------------------------------------------------------------------- | ----------------- |
| in-process    | `Doorbell` — coalesces every ring in one tick into a single event    | `core/channel.ts` |
| cross-process | a spool file per note, claimed by rename so it delivers exactly once | `core/channel.ts` |

`TaskStack.notify` does both: it rings locally _and_ posts to the spool, and a drainer discards notes
it posted itself so one ring is never delivered twice. The spool keys on `repoSlug` — the primary
checkout, resolved through `git rev-parse --git-common-dir` — rather than on `projectSlug`, so a note
raised in a worktree reaches a session watching from the checkout it was cut from.

The background sync loop is what drains the spool and compares the eligible set from pass to pass: the
channel is dark without `--sync-interval`. Only the **stdio** transport wires the doorbell to a
notification (`mcp/stdio.ts`), because that is how Claude Code spawns a channel server. Under HTTP the
ring goes nowhere and every tool still works.

**Dispatch is not modelled here.** `list_ready` answers what the graph allows, and a task being worked
right now still appears in it. Tracking what is in flight, and capping how much runs at once, belongs
to whatever starts the work — this package holds the graph, not the schedule.
