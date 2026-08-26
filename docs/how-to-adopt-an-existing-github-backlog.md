# How to adopt an existing GitHub Issues backlog

Bring a repository's existing issues into the task graph, so the queue reasons over the work you
already have instead of a fresh empty graph.

`sync` does the adopting. Before you run it on a real backlog, read the next section — the first sync
writes to every issue in the repository.

## Decide what the first sync is allowed to touch

An unmanaged issue is one with no hidden `outputty:task` block in its body. The first `sync` adopts
every one of them, which means: an edit to each issue body to stamp the block in, a `field:value`
label where a field is not at its default, and a card on the Projects board for each. On a backlog of
three hundred issues that is three hundred notifications for anyone watching the repository.

Turn off the parts you do not want, **before** the first sync:

```jsonc
// set_config
{ "project": "/abs/repo", "scope": "repo", "config": { "projects": false, "labels": false } }
```

Or, if you drive the server from the command line, pass the flags on every invocation:

```bash
tasks-mcp --no-projects sync
```

You can turn either back on later. Widening `labelFields` starts writing more labels; narrowing it
stops writing them but never strips labels already there.

## Run the sync

From inside the repository:

```bash
tasks-mcp sync
```

It prints three counts — `pulled`, `pushed`, `conflicts`. On a first adoption `pulled` is every issue
in the repository, open and closed, and `pushed` is close to the same number, because every unmanaged
issue needs the block written into it.

Over MCP it is the `sync` tool, with no arguments beyond `project`.

## See what you got

```bash
tasks-mcp list
```

Every adopted issue arrives as a task whose id is `gh-<issue number>`, keeping its title, its state —
a closed issue adopts as `done` — and its body prose, which is preserved below the block. Any plain
label the issue wore is adopted as a `tag`, so labelling in the web UI keeps working.

What an adopted task does _not_ have is the structure the graph runs on: no `deps`, no `scope`, no
`target`.

## Give the adopted tasks structure

Work top down. File the roadmap targets first, then point tasks at them:

```bash
tasks-mcp add-target csv-export \
  --title "Finance can export synced orders themselves" \
  --brief "Support re-runs the orders query by hand every month end."

tasks-mcp edit gh-42 --target csv-export --scope src/orders
tasks-mcp edit gh-57 --target csv-export --scope src/api --deps gh-42
```

Two rules bite here:

- A `dep` must stay inside the same target. If `gh-57` genuinely waits on work under a different
  target, that sequencing belongs on the targets' own `deps`, one altitude up.
- `--deps` and `--scope` **replace** the list rather than adding to it. Use `amend_task` over MCP to
  widen a scope without restating it.

Editing `target` re-parents the issue: GitHub shows the task as a sub-issue of the target's issue, and
re-parenting by hand in the web UI flows back on the next sync.

## Live with the `gh-` ids

`id` is the stable key and no surface renames one. An adopted task keeps `gh-42` for good.

If a readable id matters, file a fresh task with the id you want and close the adopted one; both keep
their own issue and the history stays where people already commented. `delete_task` removes an issue
outright, but it needs the token's delete-issue permission (repo admin or triage) and it is
irreversible.

## If `conflicts` is not zero

Two issues carry the same id in their blocks. tasks-mcp resolves to the **oldest** of them, shadows
the newer ones, and names the ids on stderr:

```text
tasks-mcp: acme/orders has duplicate issues for task id(s): gh-42 — using the oldest of each
```

Nothing is deleted; it needs a person. Close or merge the duplicate on GitHub, then run `sync` again.

## Keep it current

A change made in the GitHub UI — a label edited, a card dragged to In Progress, an issue closed —
reaches the graph on the next `sync`. Run the server with `--sync-interval 60` so that happens on its
own; see
[how to register the server with an MCP client](how-to-register-the-server-with-an-mcp-client.md).

## Related

- [About the provider stack](explanation-the-provider-stack.md) — what `sync` merges, and which side
  wins.
- [Task record reference](reference-task-record.md) — the hidden block, the labels, and the board
  columns.
