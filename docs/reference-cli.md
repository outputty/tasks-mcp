# CLI reference

Every option and subcommand of the `tasks-mcp` binary. Generated from `bin/cli.ts` and `--help` for
version 0.21.0.

```bash
npx -y @outputty/tasks-mcp [options] [command]
```

With no command the binary runs the MCP server: stdio by default, or the HTTP server with `--http`.
The subcommands drive the same core directly, with no MCP protocol involved. Every subcommand prints
JSON, indented two spaces, to stdout.

## Global options

These are declared on the program, so they may appear before or after a subcommand name.

| Option                   | Argument | Default                  | Meaning                                                                                                 |
| ------------------------ | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `-V`, `--version`        | —        | —                        | Print the package version and exit.                                                                     |
| `-h`, `--help`           | —        | —                        | Print help for the program or a subcommand and exit.                                                    |
| `--http`                 | —        | stdio                    | Run the standalone HTTP server instead of stdio.                                                        |
| `--port <n>`             | integer  | `3917`                   | HTTP port. Only meaningful with `--http`.                                                               |
| `--host <ip>`            | string   | `127.0.0.1`              | HTTP bind address. `--host 0.0.0.0` exposes the server to every interface, deliberately. `--http` only. |
| `--provider <name>`      | string   | `github`                 | The remote layer backing each project.                                                                  |
| `--project-number <n>`   | integer  | find or create           | Target an existing Projects v2 board by number.                                                         |
| `--no-projects`          | —        | board on                 | Disable the Projects v2 board sync.                                                                     |
| `--board <title>`        | string   | `Tasks`                  | Board title to find or create.                                                                          |
| `--cache-dir <dir>`      | path     | OS cache dir             | Where the file layer and the config files live.                                                         |
| `--sync-interval <secs>` | integer  | `0` (off)                | Background reconcile cadence while the MCP server runs.                                                 |
| `--project-id <id>`      | string   | —                        | The default [project id](#the-project-id) for the server and subcommands.                               |
| `--project <id>`         | string   | `--project-id`, then cwd | The project id a subcommand acts on (overrides `--project-id`).                                         |

`--provider`, `--project-number`, `--no-projects`, and `--board` are the CLI-flag layer of the
[configuration](reference-configuration.md); `--cache-dir` and `--sync-interval` are deployment knobs
and never reach the config surface. `github` is the only registered remote; any other value throws
`unknown provider '<name>' (known: github)`.

### The project id

A **project** is identified by an opaque, supplied string — never derived from a path or a provider. As
the MCP server, `--project-id` sets the default a tool call uses when it omits `project`; a call may
override it. As a subcommand, `--project` names the id (falling back to `--project-id`, then the current
directory used verbatim). The id is validated for path traversal and used verbatim as a cache filename,
but is never resolved against git or the filesystem:

```console
$ tasks-mcp identify --project outputty/tasks-mcp
{
  "id": "outputty/tasks-mcp"
}

$ tasks-mcp identify --project ../../etc/passwd
Error: invalid project id '../../etc/passwd' — an id may not contain path traversal
```

A repo's checked-in `.mcp.json` carries `--project-id`, so every git worktree cut from it shares one id
and therefore one task cache — see [how to register the server](how-to-register-the-server-with-an-mcp-client.md).

## Reading the graph

| Command        | Argument | Prints                                                                                             |
| -------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `list`         | —        | Every record, full, straight from the top layer.                                                   |
| `ready`        | —        | The ids ready to build right now, best first.                                                      |
| `roadmap`      | —        | Every target: `id`, `summary`, `status`, `progress`, `ready`.                                      |
| `projects`     | —        | Every project the cache holds, with task counts. Takes no `--project` — it asks about the server.  |
| `planning`     | —        | The ids the planning stage owns, resubmitted ones first.                                           |
| `schedule`     | —        | The whole open plan as an array of layers of ids.                                                  |
| `prereqs <id>` | task id  | The open prerequisites as an array of layers of ids.                                               |
| `blockers`     | —        | Each blocker: `id`, `blocks`, `blocked`, `priority`.                                               |
| `get <id>`     | task id  | One record, or `null`.                                                                             |
| `trail <id>`   | task id  | The task's issue comment thread, oldest first.                                                     |
| `config`       | —        | `flags`, `global`, `repo`, `effective`.                                                            |
| `identify`     | —        | The [project id](#the-project-id) a call would use: `{ "id": ... }`. Touches no git or filesystem. |

The CLI's `roadmap` and `blockers` print a narrower row than the MCP tools of the same name; see the
[MCP tool reference](reference-mcp-tools.md) for the full shapes. The CLI has no `--target` option on
`schedule` and no `--scope` lane filter on `ready`; both live on the MCP tools only. There is no
subcommand that writes configuration — use the `set_config` MCP tool.

```console
$ tasks-mcp ready
[
  "order-schema"
]
```

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

```console
$ tasks-mcp prereqs export-endpoint
[
  [
    "order-schema"
  ]
]
```

`projects` is the one read that takes no `--project`: it walks the cache directory and reports every
project it holds, each with its task counts by status and the cache file's mtime. `updated_at` is when
the cache last changed, so a project edited only on GitHub shows an older stamp until the next sync.

```console
$ tasks-mcp projects
{
  "projects": [
    {
      "project": "outputty/tasks-mcp",
      "tasks": 3,
      "open": 1,
      "in_progress": 1,
      "done": 1,
      "updated_at": "2026-08-26T19:12:32.494Z"
    }
  ]
}
```

`tasks` counts every record the project holds, targets included, so it equals `open + in_progress +
done`.

## `add <id>`

Create a task. Prints the created record.

| Option               | Argument | Meaning                                  |
| -------------------- | -------- | ---------------------------------------- |
| `--title <text>`     | string   | One-line summary.                        |
| `--deps <ids>`       | csv      | Ids this task waits on.                  |
| `--scope <folders>`  | csv      | Folders the task may edit.               |
| `--tier <n>`         | integer  | 1–4; how much model the work needs.      |
| `--qa <level>`       | string   | `skip`, `inline`, `subagent`.            |
| `--priority <level>` | string   | `high`, `normal`, `low`.                 |
| `--spec <state>`     | string   | `drafting`, `settled`, `replan`.         |
| `--stage <label>`    | string   | Narrative label on a staged deliverable. |
| `--brief <text>`     | string   | The build brief.                         |
| `--contract <text>`  | string   | The done-condition.                      |
| `--kind <text>`      | string   | Free-text classifier.                    |
| `--tags <labels>`    | csv      | Plain GitHub labels, no `field:` prefix. |
| `--target <id>`      | string   | The roadmap target this task serves.     |

`--discovered_from` has no CLI flag; set it through `add_task` or `edit_task` over MCP.

```console
$ tasks-mcp add export-endpoint --title "Serve the export over HTTP" \
    --deps order-schema --scope src/api --target csv-export --priority high
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

## `add-target <id>`

Create a roadmap target. Prints the created record.

| Option               | Argument | Required | Meaning                                           |
| -------------------- | -------- | -------- | ------------------------------------------------- |
| `--title <text>`     | string   | yes      | The target, nameable in one sentence.             |
| `--brief <text>`     | string   | yes      | The why: what makes this worth building, and now. |
| `--deps <ids>`       | csv      | no       | Targets that must ship before this one.           |
| `--priority <level>` | string   | no       | `high`, `normal`, `low`.                          |
| `--spec <state>`     | string   | no       | `drafting`, `settled`, `replan`.                  |
| `--kind <text>`      | string   | no       | Free-text classifier.                             |
| `--tags <labels>`    | csv      | no       | Plain GitHub labels.                              |

Commander enforces `--title` and `--brief`; the core refuses a blank one.

## `edit <id>`

Change any field. Only the fields passed change; the id is fixed. Prints the updated record.

| Option               | Argument | Meaning                                  |
| -------------------- | -------- | ---------------------------------------- |
| `--title <text>`     | string   | One-line summary.                        |
| `--deps <ids>`       | csv      | Replaces the list.                       |
| `--scope <folders>`  | csv      | Replaces the list.                       |
| `--tier <n>`         | integer  | 1–4.                                     |
| `--qa <level>`       | string   | `skip`, `inline`, `subagent`.            |
| `--priority <level>` | string   | `high`, `normal`, `low`.                 |
| `--spec <state>`     | string   | `drafting`, `settled`, `replan`.         |
| `--stage <label>`    | string   | Narrative label on a staged deliverable. |
| `--brief <text>`     | string   | The build brief.                         |
| `--contract <text>`  | string   | The done-condition.                      |
| `--kind <text>`      | string   | Free-text classifier.                    |
| `--tags <labels>`    | csv      | Replaces the list.                       |
| `--target <id>`      | string   | Move under a different roadmap target.   |
| `--type <node>`      | string   | `task` or `target`.                      |
| `--clear <fields>`   | csv      | Fields to remove outright.               |

Clearable field names: `type`, `target`, `kind`, `brief`, `contract`, `tier`, `qa`, `priority`,
`spec`, `stage`, `discovered_from`, `deps`, `scope`, `tags`.

There is no `amend` subcommand; `amend_task` lives on the MCP surface only.

## Writing status

| Command       | Argument | Prints                                                         |
| ------------- | -------- | -------------------------------------------------------------- |
| `start <id>`  | task id  | The updated record, now `in_progress`.                         |
| `close <id>`  | task id  | `{ "closed": "<id>" }`.                                        |
| `delete <id>` | task id  | `{ "deleted": "<id>" }`. Permanent; needs delete-issue rights. |
| `sync`        | —        | `{ "pulled": n, "pushed": n, "conflicts": n }`.                |

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

A record read back through the file layer prints its structural fields first — that is the key order
the cache writes, not a different record.

## `trail-add <id>`

Append one entry to a task's trail by posting a comment on its GitHub issue. Prints the whole trail.

| Option          | Argument | Required | Meaning                             |
| --------------- | -------- | -------- | ----------------------------------- |
| `--note <text>` | string   | yes      | What was decided, done, or noticed. |
| `--kind <kind>` | string   | no       | `decision`, `action`, or `note`.    |
| `--link <ref>`  | string   | no       | A file:line, URL, or commit.        |

## Exit behaviour

A failing command throws; Node prints the stack trace to stderr and exits non-zero. The message is the
first line, for example:

```text
Error: no GitHub repo for this project — set `repo` (owner/repo) in its config, or launch the server from the repository so `origin` can supply it
```

Warnings that do not fail a command — a Projects board that could not be reached, a duplicate task id,
a sub-issue edge that had to wait — are written to stderr and prefixed `tasks-mcp:`.
