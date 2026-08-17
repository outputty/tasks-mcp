# Per-task trails

A **trail** is a per-task, append-only journal — the decisions and actions behind a task, kept so a
later session can backtrack *why*. Trails are the opposite of the [file layer](provider-stack.md):
that cache is disposable and rebuilt from the stack; a trail is **durable local memory** with no
deeper layer to rebuild it, so it is never quarantined — a corrupt one fails loud with its path.

```mermaid
flowchart LR
    tool["append_trail\n{ id, kind, note, link? }"] --> store["TrailStore\n(text append)"]
    store --> file[".trails/&lt;id&gt;.yaml\nYAML list, oldest first"]
    file --> read["get_trail\nreturns the whole journal"]
    task["task exists?\n(top file layer)"] -.->|"guard: no task &lt;id&gt;"| tool
```

## What a trail holds

One file per task at `<trailsDir>/<id>.yaml` (default `.trails` in the repo root). The file is a YAML
list of entries, each `{ kind, note, link? }` where `kind` is `decision` · `action` · `note` (default
`note`). Real observed (`trail-journal` example):

```yaml
# tasks-mcp trails — per-task journal, append-only. Safe to commit; never synced to a remote.
- kind: decision
  note: prereqs example outputs [[schema],[api,infra]]
  link: README.md:42
- kind: note
  note: fixed the ordering in the example block
```

## Why text-append, never rewrite

The single load-bearing decision. outputty's original tracker (`tasks.js`) refused to write trails at
all, because a full re-serialize (`YAML.stringify`) flattens `|` block scalars and destroys
hand-authored prose. `TrailStore.append` sidesteps that: it concatenates the new entry as one YAML
list item and never touches an earlier byte, so hand-editing a trail between appends is safe. The old
lesson's *reason* (never destroy prose) is honored, not reversed — the tool can now write because it
only ever adds.

An `appendPrefix` guards the join: a new file gets the header comment; an existing file a hand-edit
left without a trailing newline gets a `\n` first, so an appended item can never fuse onto the last
line.

## Local, never synced

Trails are outside the provider stack entirely — `TrailStore` is its own component, not a `Provider`,
and `sync` never touches it. Nothing pushes a trail to GitHub. This is deliberate: the storage fork
(ruled 2026-08-17) chose a repo-root `.trails` folder (path configurable via `trailsDir`) over a
GitHub-synced or cache-only home, so the decision prose stays local and committable.

### Gotchas

- `append_trail` refuses an unknown id (`no task <id>`) — the existence check reads only the top file
  layer, so no network is touched. A task on GitHub but not yet pulled locally must be `sync`ed first.
- A task id containing a path separator (`/`, `\`, `..`) is refused — it must be a safe file name.
- Whether to commit `.trails/` is the user's call; the server only writes there. `git`-ignore it to
  keep trails machine-local, or commit it to share the reasoning with teammates.
