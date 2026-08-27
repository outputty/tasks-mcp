# How to use tasks-mcp as a library

Import the core instead of talking to a server. Use this when you are embedding the tracker in your own
tool, reasoning over a task graph you built yourself, or hosting the MCP server inside a process you
already run.

```bash
npm install @outputty/tasks-mcp
```

Two entry points:

| Import                    | Gives you                                                     |
| ------------------------- | ------------------------------------------------------------- |
| `@outputty/tasks-mcp`     | The core: the service, the provider layers, the graph engine. |
| `@outputty/tasks-mcp/mcp` | The MCP wrapper: the server factory and the two transports.   |

The package is ESM only and ships no `.d.ts` files, so TypeScript consumers get no types from it.
Examples below are JavaScript.

> **Breaking change.** A project is now an opaque, supplied id used verbatim as its cache filename, so
> the three path-hashing and repo-resolution helpers that used to be exported (the ones that turned a
> project path into a slug and resolved a worktree back to its primary checkout) are **removed**. There
> is no replacement: pass whatever stable id you like as `project`, and validate it with the exported
> `validateProjectId` if it might contain user input.

## Reason over a graph without any storage

Every scheduling function is a pure function of an array of task objects. No service, no provider, no
I/O:

```js
import { eligible, prereqs, blockers, roadmap, withDefaults } from "@outputty/tasks-mcp";

const tasks = [
  withDefaults({ id: "order-schema", title: "Give an order a stable export shape" }),
  withDefaults({
    id: "export-endpoint",
    title: "Serve the export over HTTP",
    deps: ["order-schema"],
  }),
];

eligible(tasks); // ranked, best first, each with blocks/score/overlap
prereqs(tasks, "export-endpoint"); // [[order-schema]]
blockers(tasks); // biggest bottleneck first
roadmap(tasks); // one row per target, progress derived
```

`withDefaults` fills the structural fields — `status`, `deps`, `scope`, `title` — so the graph
functions never see `undefined`. Use it on anything you hand-build.

Also exported: `ready`, `planning`, `schedule`, `inLane`, `scopesIntersect`, `overlappingClaims`,
`targets`, `tasksOf`, `progressOf`, `idList`, and the field readers `tierOf`, `qaOf`, `priorityOf`,
`specSettled`, `typeOf`, `isTarget`.

## Drive the real stack

`makeService()` builds the production stack — the file layer on top, the project's configured remote
beneath it — and takes the same knobs the CLI flags set:

```js
import { makeService } from "@outputty/tasks-mcp";

const service = makeService({ cacheDir: "/var/lib/tasks", projects: false });
const ctx = { project: "/abs/repo" };

await service.create(ctx, {
  id: "api",
  title: "Build the API",
  status: "open",
  deps: [],
  scope: [],
});
await service.start(ctx, "api");
await service.appendTrail(ctx, "api", { kind: "decision", note: "GraphQL only" });
await service.close(ctx, "api");
```

The service methods are `list`, `get`, `create`, `update`, `close`, `start`, `delete`, `sync`,
`syncSeen`, `claims`, `getTrail`, `appendTrail`, `getConfig`, `setConfig`, and `stop`.

Note what you build yourself: the argument normalizing behind `add_task` — comma strings into arrays,
tier and qa validated before the write — is not exported. `create` takes a complete task object. Fill
it with `withDefaults` and validate with `tierOf` / `qaOf` / `priorityOf` if you are accepting loose
input.

`create` throws `DuplicateTaskError` on an id the stack already holds; it is exported so you can
`instanceof` it rather than match a message.

## Run without GitHub

The GitHub layer is the only registered remote, and it needs a github.com `origin` remote plus a
token. To keep everything local, inject the stack yourself — one file layer and nothing below it:

```js
import { TaskStack, FileProvider, withDefaults, eligible } from "@outputty/tasks-mcp";

const cacheDir = "/tmp/tasks-cache";
const service = new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);
const ctx = { project: "/abs/repo" };

await service.create(
  ctx,
  withDefaults({ id: "order-schema", title: "Give an order a stable export shape" }),
);
await service.create(
  ctx,
  withDefaults({
    id: "export-endpoint",
    title: "Serve the export over HTTP",
    deps: ["order-schema"],
  }),
);

console.log(eligible(await service.list(ctx)).map((e) => `${e.task.id} score=${e.score}`));
// [ 'order-schema score=4' ]
```

`project` is still required — it keys the cache file — but with no GitHub layer it never has to be a
real repository. Trails do not work in this configuration: `getTrail` and `appendTrail` throw
`trails need a GitHub-backed project`, because the file layer has no comment surface.

## Add your own provider layer

A layer implements `init`, `pull`, and `upsert`, and may add `upsertMany`, `delete`, `getTrail`, and
`appendTrail`. Order is authority order: the last layer wins a disagreement.

```js
import { TaskStack, FileProvider, GitHubProvider, ConfigProvider } from "@outputty/tasks-mcp";

const config = new ConfigProvider({ cacheDir });
const service = new TaskStack({ cacheDir }, [
  new FileProvider({ cacheDir }),
  new GitHubProvider(config),
  myArchiveLayer,
]);
```

Adding a layer is a free migration: the next `sync` backfills it with every task, because absence is
never read as a deletion. `buildStack(remote, options, config)` is exported if you want the standard
two-layer stack for a named remote.

## Host the MCP server yourself

```js
import { createMcpServer, createHttpServer, runStdio, SERVER_INFO } from "@outputty/tasks-mcp/mcp";
import { makeService } from "@outputty/tasks-mcp";

const service = makeService();

createHttpServer(service).listen(3917); // POST /mcp, GET /health
await runStdio(service); // stdin/stdout
createMcpServer(service); // the McpServer itself, connect your own transport
```

`SERVER_INFO` is `{ name, version }`, read from the package rather than hand-maintained.

The background reconcile loop is not exported. If you want one, call `service.syncSeen()` on your own
timer; it reconciles every project the service has been asked about and swallows per-project failures.

## Reach the claim ledger

```js
import { ClaimStore, DEFAULT_STALE_MINUTES } from "@outputty/tasks-mcp";

const store = new ClaimStore(cacheDir, "/abs/repo");
store.all(); // every claim, raw
store.aged(); // every claim with its stale_for_minutes, longest silence first
```

`service.claims(ctx)` is the aged list a caller reads — it applies no threshold, so a fresh claim comes
back with `stale_for_minutes: 0`. Filter it yourself if you are building a sweeper:
`claims.filter((c) => c.stale_for_minutes >= DEFAULT_STALE_MINUTES)`.

## Related

- [Task record reference](reference-task-record.md) — the shape `create` and `update` expect.
- [About the provider stack](explanation-the-provider-stack.md) — what the layer order means.
