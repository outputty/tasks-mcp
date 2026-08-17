# Provider architecture — one-class providers on the official SDK (roadmap #3)

A provider is one class in one file wrapping its own API client, with all remote setup in an
explicit `async init()`; the MCP layer is the official SDK with zod schemas per tool; the whole
build runs on the oxc toolchain with enforced working-set caps.

## Before / After

Before: the GitHub provider was satellite modules (`client.ts`/`issues.ts`/`projects.ts`) with
a lazy `await import("octokit")`; the MCP layer was a hand-rolled JSON-RPC handler
(`protocol.ts`/`tools.ts`); the HTTP transport was hono; tests drove an in-memory FakeProvider.

After: `GitHubProvider` is one class, its Octokit the sole injection point (constructor param,
defaulted for production); `init(ctx)` resolves repo, config, repository node id, and the board
once per project; the server is `McpServer` with zod input AND output schemas, stdio +
stateless Streamable HTTP on plain `node:http`; tests are e2e with nock at the wire and the
FakeProvider deleted. Real observed: `npm run check` green end to end in this worktree.

## The arc

One squashed PR (#8, `0956e3e`, v0.6.0) carrying seven internal steps: the class fold-in; the
GraphQL-only ruling recorded (REST still cannot create/link/list Projects v2 boards); hono
dropped (two routes never justified a framework); the SDK migration with SERVER_INFO read from
package.json; sustainable-code caps wired into oxlint (complexity ≤ 7, ≤ 24 lines, nesting ≤ 3)
with every violation fixed by decomposition; an intermittent MCP-test hang killed (405 on
non-POST /mcp + closeAllConnections in test cleanup); TS7 + oxfmt + tsdown + ts-pattern.

## Where the record lives

- Code: `src/core/providers/github.ts` (the one class), `src/mcp/server.ts`, `src/mcp/http.ts`.
- Rules: `CLAUDE.md` Code rules (one class per provider, GraphQL-only, orchestrator/executor,
  no lazy imports); `.oxlintrc.json` (the caps).
- Docs: `docs/development.md` (toolchain, test discipline).
