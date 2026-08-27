# A failed MCP-server notice can be a redundant server, not the tracker being down

*BUILD, 2026-08-27.*

## 1. The problem

A dispatched build's first act is to confirm the `mcp__tasks__*` tools are present; the outputty flow
says missing means halt and report, because a build with no task tracker cannot claim, trail or close.

This repository is served by TWO tasks servers at once:

1. Its OWN, declared in `.mcp.json` under the key `tasks`, launched as `node dist/cli.js --project-id
   outputty/tasks-mcp`. Every agent in the repo uses it.
2. The outputty plugin's GENERIC one, `npx -y @outputty/tasks-mcp`, surfaced as `plugin:outputty:tasks`.
   Here it is redundant, and it fails to connect.

Both can appear at session start. The plugin's failure emits a session notice:

```
plugin:outputty:tasks: "Skipping connection (recent failure cached retries automatically in 15 min …)"
```

## 2. What was expected

That a failed tasks-server notice means the tracker is down, so the halt-and-report rule fires. The rule
reads a failed `tasks`-shaped server as "the tracker is unavailable, stop."

## 3. What actually happened

The repo's own `tasks` server was connected the whole time. Its tools were present as DEFERRED tools
(`mcp__tasks__roadmap`, `mcp__tasks__start_task`, …, callable after one `ToolSearch` to load the schema),
and its server instructions loaded into context. The server that failed was the plugin's redundant one,
named `plugin:outputty:tasks` — not the repo's `tasks`.

The distinction is the whole answer, and it is checkable at a glance:

```
FAILED notice:  plugin:outputty:tasks   → the plugin's redundant npx server (expected to fail here)
DEFERRED tools: mcp__tasks__*           → the repo's own server, connected and usable
```

This was not hypothetical. The base commit `ac29008` was made precisely because the same notice had
already misled a builder once:

```
Deny the plugin's redundant npx tasks server in this repo
… its cached-failure notice misled a dispatched builder into halting as if
the tracker were down. deniedMcpServers matches on serverCommand, so it
blocks only the plugin's command and leaves the repo server working.
```

⚠ The `deniedMcpServers` deny reduces the harm but does NOT remove the notice: `plugin:outputty:tasks:
Skipping connection` still appeared twice in this session's reminders, including mid-build, while the repo
server kept working. So a builder still meets the notice and must recognize it.

## 4. Where it showed, and whether it repeats

1. `ac29008` commit message — "its cached-failure notice misled a dispatched builder into halting as if
   the tracker were down" (a prior instance, on another build).
2. This session's opening reminder — `plugin:outputty:tasks: Skipping connection (recent failure
   cached …)`, while `mcp__tasks__*` sat in the deferred-tools list and the `tasks` server instructions
   had loaded. The halt rule's literal trigger nearly fired.
3. Mid-session, a second identical reminder fired after `ac29008`'s deny was already in the tree —
   evidence the deny does not suppress the notice.

×2 as near-halts (the `ac29008` builder, and this session), both resolved by reading the failed server's
NAME rather than its shape.

## 5. How to prevent it

**Before halting on a "tasks server failed" notice, read the FAILED server's name and check the
deferred-tools list. A `plugin:*` server failure with the repo's own `mcp__tasks__*` tools present as
deferred tools is a redundant server, not the tracker being down — load a schema with `ToolSearch` and
proceed. Halt only when NO `mcp__tasks__*` tool is available at all.**

```
BEFORE
  reminder: "plugin:outputty:tasks: Skipping connection …"
  → read as "the tracker is down" → halt and report        (a false halt)

AFTER
  reminder: "plugin:outputty:tasks: Skipping connection …"
  → is the FAILED name the repo's `tasks`, or a `plugin:*` duplicate?
  → are `mcp__tasks__*` in the deferred-tools list?
     yes → redundant server; ToolSearch the schema and build on
     no, and no `.mcp.json` tasks entry either → genuinely down; halt and report
```
