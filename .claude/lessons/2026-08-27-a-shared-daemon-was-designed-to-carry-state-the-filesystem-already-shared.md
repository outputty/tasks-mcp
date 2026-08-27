# A shared always-on daemon was designed to carry state the filesystem already shared

*Killed approach — PLANNING, 2026-08-27.*

## 1. The problem

tasks-mcp is a task tracker. Every stdio server launched from a repo's `.mcp.json` shares its task state
through two places outside the process: the OS cache dir and the remote (GitHub). With no `--cache-dir`,
every launch reads and writes the same cache root:

```ts
// src/core/providers/config.ts
export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "tasks-mcp");     // one root, shared by every server launched with no override
}
```

Trying to make it possible to file a task into a *second* repo's project, a planning session proposed
replacing the per-repo servers with ONE always-on HTTP daemon that every repo connects to, each naming
its project through a `?project=` URL query.

```
BEFORE (proposed): many repos ──HTTP──▶ one always-on daemon ──▶ shared cache
                                         (must be up before a client connects;
                                          per-connection project via ?project=)
```

## 2. What was expected

The premise, in the user's words:

> Any MCP JSON file should spin up its own tasks MCP server when we already have an MCP server that
> should be running in the background that we all connect to.

The belief: a shared long-running server is needed to unify state and to avoid a process per repo.

## 3. What actually happened

Reading the code, the per-repo servers *already* share all task state — the cache root above, plus the
same GitHub. The daemon would save only a Node process spawn, while ADDING three costs the filesystem
never charged: a daemon lifecycle, a startup race (the daemon must be up before a client connects — the
same failure as a dead MCP server), and per-connection project identity the HTTP transport does not even
carry today:

```ts
// src/mcp/http.ts — stateless, ONE launch-time default project, query stripped and ignored
const path = (req.url ?? "").split("?")[0];               // the ?project= a design would add is discarded
const server = createMcpServer(service, defaultProject);  // same default for every client
```

The whole direction was abandoned when the simplest option surfaced: a CLI that runs *in* the repo
resolves the project id and the GitHub repo from where it runs, needs no daemon, and already exists
(`bin/cli.ts`).

## 4. Where it showed, and whether it repeats

1. The daemon + `?project=` design occupied roughly four exchanges before being dropped — target
   [#102](https://github.com/outputty/tasks-mcp/issues/102) `Planned-at` trail note records it.
2. The HTTP transport is stateless with one launch-time `defaultProject` and reads no per-connection
   project — `src/mcp/http.ts:28,49` — the very gap the design existed to fill.
3. The cwd-origin repo fallback the daemon design wanted to DELETE (`github.ts:89`) turned out to be
   *correct* for a per-invocation CLI, because the cwd is the project's repo.

×1

## 5. How to prevent it

**Before designing a shared long-running server, name the state it holds that the filesystem and the
remote do not already share. If the only answer is "a process spawn", stop — a per-invocation CLI over
the shared cache is simpler and carries no lifecycle and no connection to time.**

```
AFTER: many repos ──▶ `tasks-mcp <cmd>` per invocation ──▶ same shared cache + GitHub
                      no daemon, no connection, no ?project= addressing
```
