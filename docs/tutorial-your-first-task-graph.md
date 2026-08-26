# Your first task graph

In this tutorial we will build a small task graph — one roadmap target and two tasks, one waiting on
the other — and ask it what to work on. Everything happens in a throwaway GitHub repository that we
create at the start and delete at the end, so nothing here touches work you care about.

We will use the command line the whole way. The same graph is what an agent sees through the MCP
server; connecting one is a separate step, and there is a
[how-to](how-to-register-the-server-with-an-mcp-client.md) for it.

Allow about fifteen minutes.

## What you need

- **Node 26.4 or newer.** Check with `node --version`. (The floor moved up for the `--tui` console's
  native renderer; the server itself runs on older Node, but the package's floor tracks the console.)
- **The GitHub CLI**, logged in and holding two extra scopes. Two commands set that up:

  ```bash
  gh auth login
  gh auth refresh -s project -s delete_repo
  ```

  `gh auth refresh` opens a browser to confirm the scopes. `project` is what lets tasks-mcp create the
  kanban board we will look at later; `delete_repo` is what lets us throw the scratch repository away
  at the end.

## Step 1: make the scratch repository

```bash
gh repo create tasks-mcp-tutorial --private --clone
cd tasks-mcp-tutorial
```

The repository is private and empty. tasks-mcp reads the `origin` remote to find out which GitHub
repository a project belongs to, which is why we work from inside a clone.

## Step 2: install the tracker

```bash
npm install -g @outputty/tasks-mcp
```

Check it:

```console
$ tasks-mcp --version
0.21.0
```

## Step 3: file the target

A **target** is a roadmap row. It is never built itself — it is the thing a set of tasks adds up to,
and it needs a name and a paragraph saying why it is worth building.

```console
$ tasks-mcp add-target csv-export \
    --title "Finance can export synced orders themselves" \
    --brief "Support re-runs the orders query by hand every month end. Until finance can pull the file itself, every close costs an engineer half a day."
{
  "id": "csv-export",
  "title": "Finance can export synced orders themselves",
  "status": "open",
  "deps": [],
  "scope": [],
  "type": "target",
  "brief": "Support re-runs the orders query by hand every month end. Until finance can pull the file itself, every close costs an engineer half a day."
}
```

The output is the record that was created. That one command did three things: wrote the record into a
local cache, opened a GitHub issue for it, and created a Projects v2 board named **Tasks**, linked to
the repository. The first write to a repository is the slow one; everything after it is quick.

## Step 4: file two tasks, one waiting on the other

```console
$ tasks-mcp add order-schema \
    --title "Give an order a stable export shape" \
    --scope src/orders \
    --target csv-export
{
  "id": "order-schema",
  "title": "Give an order a stable export shape",
  "status": "open",
  "deps": [],
  "scope": [
    "src/orders"
  ],
  "target": "csv-export"
}
```

Now the second task, which cannot start until the first is done:

```console
$ tasks-mcp add export-endpoint \
    --title "Serve the export over HTTP" \
    --deps order-schema \
    --scope src/api \
    --target csv-export \
    --priority high
{
  "id": "export-endpoint",
  "title": "Serve the export over HTTP",
  "status": "open",
  "deps": [
    "order-schema"
  ],
  "scope": [
    "src/api"
  ],
  "target": "csv-export",
  "priority": "high"
}
```

`--deps order-schema` is the edge that makes this a graph rather than a list. `--scope` names the
folders each task is allowed to edit, and `--target` files both tasks under the roadmap row.

## Step 5: ask what is ready

```console
$ tasks-mcp ready
[
  "order-schema"
]
```

One task, not two. `export-endpoint` is urgent — we gave it `--priority high` — and it is still not
offered, because its dependency is open. Priority orders the work that _can_ start; it never lets work
start early.

Ask about the other task directly:

```console
$ tasks-mcp prereqs export-endpoint
[
  [
    "order-schema"
  ]
]
```

Each inner array is a layer: finish everything in layer 1, then layer 2, and so on. Here there is one
layer holding one task.

## Step 6: look at the roadmap

```console
$ tasks-mcp roadmap
[
  {
    "id": "csv-export",
    "summary": "Finance can export synced orders themselves",
    "status": "open",
    "progress": {
      "total": 2,
      "open": 2,
      "in_progress": 0,
      "done": 0
    },
    "ready": [
      "order-schema"
    ]
  }
]
```

Nobody typed that progress. It is counted from the tasks that name the target, every time you ask.

## Step 7: look at the same graph on GitHub

```bash
gh repo view --web
```

Open the **Issues** tab. There are three issues: the target and its two tasks. The target's issue
lists the two tasks as sub-issues with GitHub's own progress bar, because a task's `target` _is_ the
sub-issue edge. The `export-endpoint` issue wears a `priority:high` label; the other two wear no
priority label at all, because `normal` is the default and a label carrying the default would say
nothing.

Open the **Projects** tab and then the **Tasks** board: the three cards are sitting in Todo.

## Step 8: pick the task up, then finish it

A worker marks a task in progress as it starts, which takes it out of the ready list so nothing picks
it up twice:

```console
$ tasks-mcp start order-schema
{
  "status": "in_progress",
  "deps": [],
  "scope": [
    "src/orders"
  ],
  "title": "Give an order a stable export shape",
  "id": "order-schema",
  "target": "csv-export"
}
```

The fields come back in a different order here because the record has been read back through the local
cache. It is the same record.

```console
$ tasks-mcp ready
[]
```

Nothing is ready: one task is being worked and the other is waiting on it. Now finish it:

```console
$ tasks-mcp close order-schema
{
  "closed": "order-schema"
}
```

```console
$ tasks-mcp ready
[
  "export-endpoint"
]
```

The dependency cleared and the queue moved on its own. The roadmap moved with it:

```console
$ tasks-mcp roadmap
[
  {
    "id": "csv-export",
    "summary": "Finance can export synced orders themselves",
    "status": "open",
    "progress": {
      "total": 2,
      "open": 1,
      "in_progress": 0,
      "done": 1
    },
    "ready": [
      "export-endpoint"
    ]
  }
]
```

Reload the GitHub Issues tab: the `order-schema` issue is closed, and its card has moved to Done on the
board.

## Step 9: clean up

```bash
cd ..
gh repo delete tasks-mcp-tutorial --yes
npm uninstall -g @outputty/tasks-mcp
```

The local cache for the repository stays behind under `~/.cache/tasks-mcp/`. It is safe to delete the
files whose names start with `tasks-mcp-tutorial-`.

## What we built

A graph with two altitudes — one roadmap target and two tasks under it — held locally, mirrored onto
GitHub Issues and a Projects board, and able to answer what can be worked right now.

From here:

- [How to register the server with an MCP client](how-to-register-the-server-with-an-mcp-client.md) —
  give the same graph to a coding agent.
- [About the two altitudes](explanation-two-altitudes.md) — why targets and tasks share one graph.
- [CLI reference](reference-cli.md) — every subcommand and option.
