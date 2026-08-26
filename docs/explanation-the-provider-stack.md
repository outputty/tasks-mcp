# About the provider stack

Why the tracker is an ordered stack of storage layers rather than a database, what the three rules
governing it are for, and why GitHub Issues is the bottom of it.

![tasks-mcp architecture: the provider stack](architecture.svg)

## The shape

A **provider** is one layer. It implements three methods — `init`, `pull`, `upsert` — and may add
batching, deletion, and trails. `TaskStack` holds an ordered list of them, top first, and knows
nothing about what any of them does internally.

The production stack is two layers: a file cache on top, and the project's configured remote (GitHub)
beneath it. Reads hit only the top layer. Writes fan down through every layer in order. `sync` pulls
every layer and reconciles them.

Errors bubble. There is no fallback at this altitude, because the service cannot know whether a
failure is transient. The two places that do catch are places where the business logic demands it: the
Projects board is a mirror, so a board failure is logged and skipped rather than losing a task, and
the background loop swallows a single project's failure so one bad repository does not stop the sweep.

## Why a cache on top

Every read — `list_ready`, `prereqs`, `blockers`, `roadmap` — is answered from a YAML file on disk.
Nothing touches the network until the first write, or `sync`.

An agent asks the queue what is ready constantly. Making that a GraphQL round trip would put a network
call between the agent and every decision, and it would fail the moment the network did. Answering
from a local file makes those questions free and offline, at the cost of being slightly behind
GitHub — which is why `--sync-interval` exists, and why the cost is worth paying.

The file lives under the OS cache directory, never in the repository. Putting it in the repo would
make a working file into a merge conflict, and would mean the graph diverged per branch. It is a true
cache: delete it and the next `sync` rebuilds it from below, dependencies and all, because every
task's full record round-trips through its issue. A file that fails to parse is renamed `.corrupt`,
the layer continues empty, and the next sync refills it.

## The three rules

**Deepest wins.** `sync` pulls every layer and merges in stack order, so the last layer's version of a
task lands on top. An issue closed in the GitHub UI beats the local file. This is what makes the
remote the source of truth without the service having to know which layer the remote is.

**Absence is not a claim.** A task missing from a layer is pushed _into_ it, never deleted from the
others. This is what makes adding a layer free: a brand-new empty layer at the bottom backfills with
every task instead of erasing the world. It is also what makes an accidentally-deleted cache harmless.

**Deletions never propagate.** A task can close everywhere, but only vanishes by hand. `delete_task`
is an explicit, separate operation, and it fans out deepest-first so a remote that refuses — no
delete-issue permission, most often — throws before the local cache is touched. There is no
half-deleted state to sync back.

The three rules together mean the stack has no destructive path that anyone reaches by accident. Every
way to lose data is a deliberate call.

## Why GitHub Issues rather than a database

The obvious alternative is a table of tasks somewhere. It would be faster to write, easier to query,
and completely invisible to everyone who is not running the tool.

Issues are where the humans already are. A task filed by an agent shows up in the same list as a bug
reported by a colleague; someone can comment on it, close it, relabel it, or drag its card, and the
change flows back. Writing to Issues means the tracker does not create a second reality that has to be
reconciled with the team's by hand.

That choice sets the mapping. A task's full record has to round-trip through an issue, so it is split
across three homes: a hidden YAML block at the top of the body for what nothing else can carry, one
`field:value` label per execution property, and the issue's own title and open/closed state. Details
are in the [task record reference](reference-task-record.md).

Two consequences of that split are worth naming.

**Labels are an interface, not an encoding.** They were chosen over stuffing everything in the body
block because a label is visible in the issue list, filterable in a GitHub search, and editable in the
web UI. Change `tier:2` to `tier:1` on the issue and the next sync pulls it in. The price is that
labels are a namespace shared with the humans, so the parser has to ignore junk (`tier:banana`) rather
than crash on it, foreign labels have to be preserved through an update that replaces the whole label
set, and a `tag` shaped like one of the eight field names is refused on write because it would be read
back as that field and silently vanish.

**A label is only written when it says something.** Absence already means the default. Writing
`tier:3` would put a label carrying no information on nearly every issue in the repository — visual
noise with a maintenance cost. So only the value GitHub cannot otherwise show earns one. This has a
pleasing side effect: setting a field back to its default is the natural way to drop its label, and
removing a field outright is what `clear` is for. It also created a migration problem — labels older
versions had written — solved by having a pull _flag_ an issue wearing a label the record would not
write, so one plain `sync` cleans a repository and the next pushes nothing.

## The board is a mirror, and only a mirror

The Projects v2 board is best-effort throughout. If it cannot be created or reached, the failure is
logged once at init and every later board operation is skipped; issues still sync. A card whose Status
column is not one of the recognised names is left alone.

On the way back, the issue wins for `done` — closing an issue is unambiguous — and otherwise the board
wins, so dragging a card to In Progress in the GitHub UI reaches the graph. That asymmetry is the
whole point of mirroring onto a board: it is a surface people can act on.

## What N layers are actually for

The machinery is not special-cased for two. The stack tests run three layers deep with a controllable
mock at the bottom, and adding a fourth is one entry in a registry plus a class.

The intended uses are a second remote (Linear is the stub the registry is shaped around) and an
archive or audit layer that only ever receives. In both cases the migration is free: add the layer,
run `sync`, and absence-is-not-a-claim backfills it with everything.

The honest caveat is that only one remote is registered today. `--provider` accepts `github` and
throws on anything else, including `file` — so there is no supported way to run the CLI or the server
without GitHub. Injecting your own stack in code is the escape hatch; see
[how to use tasks-mcp as a library](how-to-use-tasks-mcp-as-a-library.md).

## Related

- [MCP tool reference](reference-mcp-tools.md#sync) — what `sync` reports.
- [How to adopt an existing GitHub Issues backlog](how-to-adopt-an-existing-github-backlog.md) — the
  rules above, applied to a real repository.
