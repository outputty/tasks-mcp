# tasks-mcp — Roadmap

> **Why** each target is worth building. **What** we are building — its status, its dependencies and
> its tasks — lives in the `tasks` MCP server: one issue per target, its tasks its sub-issues. Call
> `roadmap` for where things stand; this file says why they are on the list at all. Approaches
> considered and dropped live in `lessons.md`; the mechanisms that shipped live in `architecture.md`.
>
> A row is a target, a link to its issue, and a paragraph. Nothing here is a status, a dependency, or
> a task list — all three are derived, and a hand-maintained copy would only go stale.

## Where we are

v0.15.0 on npm. The tracker is a Node-native MCP server and library: tasks are GitHub issues with a
hidden body block and `field:value` labels, mirrored onto a Projects v2 board, reconciled through a
provider stack whose deepest layer wins; the graph answers `prereqs` and `blockers` offline from a
disposable local copy; each task's trail is its issue comment thread; and the server is a channel that
wakes an idle orchestrator instead of being polled. What is in flight now is the second altitude — the
roadmap itself moving into the graph, and the product docs shedding everything the graph derives.

## Live

### tasks-mcp becomes a CLI + library; the MCP layer is deleted

[#102](https://github.com/outputty/tasks-mcp/issues/102)

The MCP server was the agent interface, and forcing it into a shared, always-on server bred an HTTP
daemon, per-connection project resolution, and a startup race between the daemon and the client that
connects to it — complexity with no payoff, because the CLI that layer wrapped already drives the same
core. Worth doing now because `src/mcp/` is imported only by the CLI entry and the console, so the blast
radius is small and known: run in a repo, the CLI resolves the project id and the GitHub repo from where
it runs, agents drive it through a skill, and the console survives as a local `--tui`. The original
cross-repo problem that surfaced this — filing a task into another repo — dissolves: you run the CLI
there. The plugin-flow rewrite (its `mcp__tasks__*` calls become CLI commands, with the driving skill,
in the `claude-plugin` repo) and any rename of the `@outputty/tasks-mcp` package are separate targets.

### The roadmap becomes a second altitude in the graph

[#34](https://github.com/outputty/tasks-mcp/issues/34)

A task was a peer in one flat list, so which roadmap item it served was a question only a human reading
two documents could answer, and every roadmap status was maintained by hand beside a graph that already
knew the answer. Worth building because it makes the roadmap the thing that *ranks* work rather than a
file consulted beside it — and because the mechanism turned out to be free. A task's `target` is its
issue's parent on GitHub, and `parent` rides a listing query the provider already pages through, so
membership costs no extra round trip and GitHub renders the hierarchy and its progress bar itself.

### Product memory stops duplicating the graph

[#35](https://github.com/outputty/tasks-mcp/issues/35)

Five memory surfaces held the roadmap three times over: rows in `roadmap.yaml`, a story per row under
`roadmap/`, and a feature entry in `architecture.yaml`. With no rule saying which of them owned a
mechanism, the most recent writer picked — and three shipped capabilities (the channel, the spool
broadcast, `in_progress`) never reached the feature index at all. Worth building because it settles the
rule the set never stated: **a doc earns its place only if its content is not derivable from something
live.** Once targets are graph nodes, what and status are derived, so this file keeps only the half
nothing else holds.

### A project is what you call it, and it can sync to more than one provider

[#54](https://github.com/outputty/tasks-mcp/issues/54)

A project's identity is its absolute path, hashed, so every git worktree of one repo becomes a separate
project carrying its own stale copy of the graph — 26 of 32 cache files on the author's machine, 4.2 MB,
each a strict subset of one repo's. The code already disagrees with itself: claims resolve worktrees to
the primary checkout, tasks do not, so a build can hold a claim on a task its own cache cannot see. A
second promise is unkept in the same place: the seam is written for several remotes and `buildStack`
returns exactly two layers, so "one or more connected providers" is a promise the builder does not keep,
and the free migration the stack rules were designed to buy cannot be performed. Worth building together
because they are one decision seen twice — what names a project, and who backs it. Naming it after its
GitHub repo would have fixed the first and entrenched the second; a supplied id fixes both, and frees the
stack to hold as many remotes as a project configures.

### The console seam — list what a tracker holds, and stream when it moves

[#52](https://github.com/outputty/tasks-mcp/issues/52)

Every tool takes a project and answers about it, so nothing can ask a tracker what projects exist; and
nothing pushes, since the channel was deleted in 0a940dd and the HTTP transport answers non-POST `/mcp`
with 405 precisely so it cannot stream. A reader is left typing in project paths and polling on a
guessed interval. Worth building because both gaps sit in the layer that alone can close them — the
tracker knows what it stores, and the process that writes a change is the one that knows it happened —
and because they are small and additive once identity lands. One fix rides along because it cannot ship
after a change stream: `--http` binds every interface while its log claims localhost, serving
unauthenticated task CRUD over the operator's GitHub token to anyone on the network.

## Shipped

The mechanism of each is in `architecture.md`; the arc that produced it, and the approaches dropped on
the way, are in `lessons.md`.

| Target | Version |
| --- | --- |
| The task tracker as a local MCP server | v0.1.0–v0.4.0 |
| npm distribution with tokenless publishing | v0.5.0 |
| Provider architecture — one-class providers on the official SDK | v0.6.0 |
| The provider stack — layered truth, free migrations | v0.7.0 |
| Labels, the two questions, central config | v0.8.0 |
| Per-task trails — the GitHub issue comment thread | v0.10.0 |
| Readable issue bodies — a regenerated visible spec | v0.11.0 |
| Edit and delete tools | v0.12.0 |
| The channel — waking an idle session, and a ranked `list_ready` | v0.14.0 |
| A wake path that needs no flag, and a ring that says what moved | v0.15.0 |
| `in_progress` — the in-flight set moves into the graph | v0.15.0 |
