# A feature kept across a deletion was built entirely on the layer being deleted

*An assumption that broke — PLANNING, 2026-08-27.*

## 1. The problem

tasks-mcp ships an MCP server (`src/mcp/`) and an interactive terminal console (`tasks-mcp --tui`). A
planning session decided to delete the MCP layer and keep the console, on the belief that `src/tui/` was
a thin view over the core that would survive.

## 2. What was expected

The chosen option, verbatim from the decision:

> removed: src/mcp/server.ts, http.ts, stdio.ts, events.ts, the @modelcontextprotocol dep
> kept: bin/cli.ts, src/core/, src/tui/

The belief: `src/tui/` does not depend on `src/mcp/`.

## 3. What actually happened

The console IS an MCP client. `runTui` starts an in-process HTTP MCP server on an ephemeral port and
connects to it as a client:

```ts
// src/tui/index.ts
const server = startHttpServer(service, { port: 0 });     // an MCP server, in-process
const local: Tracker = { id: "local", url: base,
  client: await connectTracker(mcpEndpoint(base)) };      // ...consumed as an MCP client
```

```ts
// src/tui/tracker.ts — the header says it outright
// The console's data layer — an MCP CLIENT over Streamable HTTP.
const res = await client.callTool({ name, arguments: args });   // every read is a tool call
```

So "delete MCP, keep `--tui`" is a contradiction until the console's data layer is rebuilt to call
`TaskService` directly — a real task (`tui-reads-core`), not a freebie. The plan's "kept: src/tui/" was
false as written.

## 4. Where it showed, and whether it repeats

1. `runTui` → `startHttpServer` + `connectTracker` — `src/tui/index.ts:29-35`.
2. `src/tui/tracker.ts:1` declares the data layer an MCP client; reads are `client.callTool` at
   `tracker.ts:100-125`.
3. `rg "\.\./mcp" src/tui` returns `index.ts` and `tracker.ts` — the import edges the deletion must
   remove first.

×1

## 5. How to prevent it

**Before promising to keep a feature across a deletion, grep the feature's own directory for imports of
the thing being deleted. An import is a dependency the deletion has to remove first, and turning it into
its own task changes the plan's size.**

```
BEFORE: "delete src/mcp, keep src/tui"          (assumed independent)
AFTER:  rg "\.\./mcp" src/tui   →  two edges  →  tui-reads-core lands BEFORE delete-mcp-layer
```
