# tasks-mcp — working notes for Claude

`@outputty/tasks-mcp`: outputty's task tracker as an MCP server **and** a library, Node-native, published
to npm. It is split so the MCP layer wraps the core, never the reverse:

- `src/core/` — the business logic: `service`, `cache`, `graph`, `config`, `providers/` (GitHub via
  Octokit, GraphQL only). Exported as the library (`.`).
- `src/mcp/` — the wrapper on the official `@modelcontextprotocol/sdk`: the tool surface (`server`)
  and the `stdio` + `http` transports. Exported as `./mcp`.
- `bin/cli.ts` — the entry: MCP server (stdio default, `--http`) or direct subcommands.

## Code rules (the user's standing preferences — follow them in every change)

- **A provider is ONE class in ONE file.** Every provider is a class implementing the `Provider` seam,
  and it wraps its own API client (`GitHubProvider` holds its `Octokit`) — no satellite modules
  (client/issues/projects were folded into the class by request). The client is the one injection
  point — constructor parameter, defaulted for production, passed explicitly by tests.
- **All remote setup happens in `init()`.** There are no async constructors, so every provider has an
  explicit `async init(ctx)` — credentials, repo resolution, and container selection/creation (for
  GitHub: finding or creating the Projects v2 board) run there, once per project, never lazily inside
  task calls. The service awaits `init` before any operation.
- **The MCP layer is the official `@modelcontextprotocol/sdk`** — never a hand-rolled JSON-RPC
  handler. Tools declare zod input AND output schemas; results carry `structuredContent`.
- **The server version comes from `package.json`** (imported at build time) — never a hand-maintained
  copy in the source.
- **No imports inside functions.** All imports sit at the top of the module — no lazy
  `await import(...)` to shave startup or dodge a dependency in tests.
- **The GitHub provider speaks GraphQL only** (user ruling, 2026-08-17). The Projects v2 board is
  GraphQL-only regardless (as of 2026-08, REST cannot create a board, link one to a repo, or list a
  repo's linked boards), and the user chose one protocol over a REST/GraphQL mix — one API, one kind
  of handle (node ids) end to end. Do not port issues to `octokit.rest.*`.
- **Tests are e2e, mocked at the network with nock.** Drive the real stack — provider, service,
  protocol, transport — and fake only the wire: nock answers api.github.com (REST + GraphQL), test
  repos are real `git init` temp dirs. No in-memory fake providers. The one exception is a pure
  algorithm module with no I/O boundary (`graph.ts`), which may keep direct unit tests.
- **No HTTP framework.** The HTTP transport is plain `node:http` — two routes never justified a
  framework dependency. Prefer platform builtins and widely adopted tools over niche frameworks.

## Commands

- `npm test` — vitest. **Not `bun test`:** the GitHub provider tests use **nock**, which needs Node's
  fetch; nock can't intercept Bun's.
- `npm run build` — tsup → `dist/` (cli, index, mcp).
- `npm run format` — prettier.

Keep the code **runtime-portable** — no Bun-only APIs in `src/`/`bin/` (use `yaml`, `node:crypto`,
`node:child_process`, `node:http`, `process` streams). It must run under both Node and Bun.

## Releasing — always ask first, never publish unprompted

Pushing code **never publishes** — a push only runs CI (`ci.yml`). Publishing happens **only** when a
GitHub **Release** is published, which fires the `Publish` workflow (OIDC/tokenless, provenance automatic).

**When you finish a job that changed shippable code and the tests pass, ASK the user whether to create a
new release.** Do not create a release, bump the version for release, or publish unless the user
explicitly confirms — release creation is theirs to approve every time.

On an explicit "yes":

1. Bump `version` in `package.json` — **patch** for a fix, **minor** for a feature, **major** for a
   breaking change. (`SERVER_INFO.version` reads it from `package.json`; nothing else to sync.)
2. Commit and push the bump (this alone still does not publish).
3. `gh release create vX.Y.Z --generate-notes` — the tag must equal the new version. Publishing this
   release is what triggers the npm publish.

On a "no", leave the code pushed and unreleased. Never skip the question, and never create the release
on your own initiative.
