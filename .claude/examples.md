# tasks-mcp — Examples

> The canonical worked examples, one per concept. Reused verbatim wherever an example is shown; a new
> example is pinned here first. Values are REAL OBSERVED.
>
> The canonical GRAPH behind every graph example below (observed 2026-08-17, v0.8.0, seeded through the
> public FileProvider API and read through the real CLI and server):
>
> | id | title | deps | properties |
> | --- | --- | --- | --- |
> | `schema` | Design the schema | — | tier 3 |
> | `api` | Build the API | `schema` | tier 2, qa inline, priority high |
> | `infra` | Provision infra | — | tier 3 |
> | `ui` | Build the UI | `api` | priority high |
> | `deploy` | Deploy to production | `api`, `infra` | tier 3 |

## mcp-registration

Input:

```
// .mcp.json — the MCP client launches the server on demand; no clone, no install step
{ "mcpServers": { "tasks": { "command": "npx", "args": ["-y", "@outputty/tasks-mcp"] } } }
```

Output:

```
21 tools registered (REAL OBSERVED 2026-08-26, counted in src/mcp/server.ts): list_ready,
roadmap, list_planning, schedule, list_tasks, list_projects, get_task, add_task, add_target,
amend_task, edit_task, start_task, close_task, delete_task, get_trail, append_trail, sync,
prereqs, blockers, get_config, set_config.
```

## prereqs

Input:

```
// tool: prereqs — "I want to start on deploy; what has to be done first?"
{ "project": "/abs/repo", "id": "deploy" }
```

Output:

```
{
  "id": "deploy",
  "startable": false,
  "order": [["infra", "schema"], ["api"]],
  "tasks": [
    { "id": "infra", "status": "open", "deps": [], "summary": "Provision infra",
      "tier": 3, "qa": "subagent", "priority": "normal" },
    { "id": "schema", "status": "open", "deps": [], "summary": "Design the schema",
      "tier": 3, "qa": "subagent", "priority": "normal" },
    { "id": "api", "status": "open", "deps": ["schema"], "summary": "Build the API",
      "tier": 2, "qa": "inline", "priority": "high" }
  ]
}
```

## blockers

Input:

```
// tool: blockers — "what holds up the most work right now?"
{ "project": "/abs/repo" }
```

Output:

```
{
  "blockers": [
    { "id": "schema", "summary": "Design the schema", "priority": "normal", "blocks": 3,
      "blocked": ["api", "deploy", "ui"], "highPriorityBlocked": ["api", "ui"],
      "unblockedBy": [] },
    { "id": "api", "summary": "Build the API", "priority": "high", "blocks": 2,
      "blocked": ["deploy", "ui"], "highPriorityBlocked": ["ui"],
      "unblockedBy": [["schema"]] },
    { "id": "infra", "summary": "Provision infra", "priority": "normal", "blocks": 1,
      "blocked": ["deploy"], "highPriorityBlocked": [], "unblockedBy": [] }
  ]
}
```

## schedule

Input:

```
// tool: schedule — the whole open plan as dependency layers
{ "project": "/abs/repo" }
```

Output:

```
{
  "layers": [
    { "layer": 1, "ids": ["infra", "schema"], "display": "infra, schema" },
    { "layer": 2, "ids": ["api"], "display": "api" },
    { "layer": 3, "ids": ["deploy", "ui"], "display": "deploy, ui" }
  ]
}
```

## add-task

Input:

```
tasks-mcp add readme-prereqs-order \
  --title "README prereqs example shows an engine-impossible order" \
  --tier 1 --qa inline --priority normal --scope README.md \
  --brief "..." --project /abs/repo
```

Output:

```
CLI prints the created task; on GitHub (issue #13 of outputty/tasks-mcp, observed):
labels ["tier:1", "qa:inline", "priority:normal"], and the body leads with the block:

<!-- outputty:task
id: readme-prereqs-order
deps: []
scope:
  - README.md
brief: "README.md's prereqs example outputs order [[schema],[api,infra]] ..."
-->
```

## ready-and-planning

Input:

```
tasks-mcp ready --project /abs/repo      # open + spec settled + every dep done
tasks-mcp planning --project /abs/repo   # spec drafting / replan
```

Output:

```
# this repo's own tracker, observed after bootstrap filed its eight findings:
ready:    ["dead-label-fallback", "readme-prereqs-order", "stale-bun-lock",
           "stale-mcp-json-example", "sync-tool-desc-seed", "update-issue-prefetch"]
planning: ["kind-not-settable", "unused-branch-param"]
```

## sync

Input:

```
tasks-mcp sync --project /abs/repo
```

Output:

```
{ "pulled": 8, "pushed": 0, "conflicts": 0 }
```

## library-blockers

Input:

```
import { makeService, blockers } from "@outputty/tasks-mcp";
const service = makeService({ projects: false });
const tasks = await service.list({ project: "/abs/repo" });
console.log(blockers(tasks)[0]?.task.id); // the biggest blocker
```

Output:

```
schema
```

## trail-journal

Input:

```
tasks-mcp trail-add readme-prereqs-order --kind decision \
  --note "prereqs example outputs [[schema],[api,infra]]" --link README.md:42 --project /abs/repo
tasks-mcp trail-add readme-prereqs-order --note "fixed the ordering in the example block" --project /abs/repo
tasks-mcp trail readme-prereqs-order --project /abs/repo
```

Output:

```
# `trail` (get_trail) returns the whole thread, oldest first. kind/link ride a hidden marker on
# outputty's writes; a plain comment has neither. author + at come from GitHub:
[ { "kind": "decision", "note": "prereqs example outputs [[schema],[api,infra]]",
    "link": "README.md:42", "author": "test-user", "at": "2026-01-01T00:00:00Z" },
  { "note": "fixed the ordering in the example block",
    "author": "test-user", "at": "2026-01-01T00:00:01Z" } ]
```

## roadmap

Input:

```
// tool: roadmap — "where does every target stand?"
{ "project": "/abs/repo" }
```

Output:

```
// REAL OBSERVED 2026-08-20 against outputty/tasks-mcp: two live targets (issues #34 and #35),
// one task filed under the second. Progress is DERIVED from the tasks naming each target.
{
  "targets": [
    { "id": "roadmap-in-graph", "summary": "The roadmap becomes a second altitude in the graph",
      "status": "open", "deps": [], "priority": "normal",
      "progress": { "total": 0, "open": 0, "in_progress": 0, "done": 0 }, "ready": [] },
    { "id": "memory-is-derived", "summary": "Product memory stops duplicating the graph",
      "status": "open", "deps": ["roadmap-in-graph"], "priority": "normal",
      "progress": { "total": 1, "open": 1, "in_progress": 0, "done": 0 },
      "ready": ["plugin-roadmap-is-why"] }
  ]
}
```

## add-target

Input:

```
tasks-mcp add-target memory-is-derived --project /abs/repo \
  --title "Product memory stops duplicating the graph" \
  --deps roadmap-in-graph --brief "<the WHY: what makes this worth building>"
tasks-mcp add plugin-roadmap-is-why --project /abs/repo --target memory-is-derived
```

Output:

```
// REAL OBSERVED 2026-08-20 on GitHub — the target is an issue wearing type:target, and the task
// filed under it is its SUB-ISSUE, so GitHub's own progress counter tracks the target:
#35  "Product memory stops duplicating the graph"  labels ["type:target"]
     subIssues [36]   subIssuesSummary { total: 1, completed: 0, percentCompleted: 0 }
#36  "Teach the outputty plugin that roadmap is why, not what"  parent 35
```

## identify

⚠ EXPECTED — not yet built. Target #54.

Input:

```
tasks-mcp identify --project outputty/tasks-mcp
```

Output:

```json
{ "id": "outputty/tasks-mcp" }
```

The id is opaque and never resolved against a provider or the filesystem, so any non-empty string works:

Input:

```
tasks-mcp identify --project my-thing
```

Output:

```json
{ "id": "my-thing" }
```

An id that would escape the cache directory is refused:

Input:

```
tasks-mcp identify --project ../../etc/passwd
```

Output:

```
Error: invalid project id '../../etc/passwd' — an id may not contain path traversal
```

## list-projects

REAL OBSERVED 2026-08-26 — `tasks-mcp projects` against a one-project cache. `tasks` counts every
record (targets included), so it equals `open + in_progress + done`; `updated_at` is the cache mtime.

Input:

```
tasks-mcp projects
```

Output:

```json
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

## events-stream

REAL OBSERVED 2026-08-26 — one frame captured from `GET /events` while a write landed. The event names
which project moved and nothing else; the reader re-reads the graph.

Input:

```
curl -N http://127.0.0.1:3917/events
```

Output:

```
event: changed
data: {"project":"outputty/tasks-mcp","at":"2026-08-26T19:12:53.638Z"}
```
