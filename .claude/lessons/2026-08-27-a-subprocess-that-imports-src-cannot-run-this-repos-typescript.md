# A subprocess that imports `src/*.ts` cannot run this repo's TypeScript, so a "module not loaded" test runs in-process

## 1. The problem

A lazy-import invariant needed a test: starting the MCP server must NOT load `@opentui/core` (a ~20 MB
native renderer), which is imported only under `--tui`. The obvious way to prove a module is absent from
a graph is a clean OS process — spawn `node`, register a resolve hook that records every specifier,
import the server entry, and check the renderer never resolved:

```js
// the child, spawned with process.execPath
import { registerHooks } from "node:module";
const seen = [];
registerHooks({ resolve(s, c, n) { seen.push(s); return n(s, c); } });
await import(`${root}/src/mcp/stdio.ts`);      // the stdio server's whole static graph
await runStdio(new TaskStack(opts, [new FileProvider(opts)]));
console.log("OPENTUI_LOADED=" + seen.some((s) => s.includes("@opentui/core")));
```

Node 26 runs `.ts` directly (a standalone `node file.ts` worked), so importing the source seemed fine.

## 2. What was expected

The child would import `src/mcp/stdio.ts`, load its static graph (`server.ts`, `service.ts`, providers),
start the stdio server, and print `OPENTUI_LOADED=false`. Node's native type stripping would handle the
`.ts` files the same way `node tmp/probe.ts` had.

## 3. What actually happened

Two distinct failures, back to back:

1. `ERR_IMPORT_ATTRIBUTE_MISSING` — `src/mcp/server.ts` does `import pkg from "../../package.json"`, and
   raw Node ESM requires `with { type: "json" }`. The toolchain (vitest/tsdown) shims this; a plain
   `node` does not. Injecting the attribute in the resolve hook (`{ format: "json", importAttributes:
   { type: "json" } }`) got past it — into the second wall.
2. `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in
   strip-only mode`, at `src/core/providers/config.ts`:

   ```
   export class ConfigProvider {
     constructor(private readonly options: ServerOptions = {}) {}
                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^
   ```

Node's type stripping only *removes* type syntax; it cannot *transform*. A `private readonly` parameter
property (and an `enum`) needs emitting real code, which strip-only mode refuses. This codebase uses
parameter properties throughout (every provider), so a child that imports `src/` dies on the first one.

## 4. Where it showed, and whether it repeats

1. `test/tui-isolation.test.ts` was first written as a spawned child importing `src/mcp/stdio.ts`; it
   failed with both errors above before being rewritten in-process.
2. `src/core/providers/config.ts:102` — the `constructor(private readonly options…)` that Node's
   strip-only mode rejects; the same shape is in every `src/core/providers/*.ts` and `src/mcp/http.ts`.
3. A pure `.ts` file with no parameter properties DID run under `node` (`tmp/probe.ts`), which is the
   trap: a one-file probe succeeds, the real graph does not.
   ×1.

## 5. How to prevent it

**Test a "module X is not loaded on path Y" invariant IN-PROCESS with vitest's `registerHooks`, in a test
file that does not import X, not in a subprocess that imports `src/`.** Vitest transforms the TypeScript
(parameter properties, JSON imports and all), and `@opentui/core` is a real `node_modules` package, so a
Node resolve hook still sees it resolve. A positive control (import the module and assert the hook fires)
proves the check is live rather than a hook that never runs.

```js
// test/tui-isolation.test.ts — no top-level @opentui/core import
import { registerHooks } from "node:module";
const resolved = [];
registerHooks({ resolve(s, c, n) { resolved.push(s); return n(s, c); } });
await import("../src/mcp/stdio.ts");          // vitest transforms this fine
createMcpServer(new TaskStack(/* file-only */));
expect(resolved.some((s) => s.includes("@opentui/core"))).toBe(false);
await import("@opentui/core");                 // positive control
expect(resolved.some((s) => s.includes("@opentui/core"))).toBe(true);
```

BEFORE: spawn `node child.mjs` importing `src/*.ts` → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
AFTER: in-process `registerHooks` under vitest → the graph loads, the hook records, the assertion holds.
