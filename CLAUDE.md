# tasks-mcp — working notes for Claude

`@outputty/tasks-mcp`: outputty's task tracker as an MCP server **and** a library, Node-native, published
to npm. It is split so the MCP layer wraps the core, never the reverse:

- `src/core/` — the business logic: `service`, `cache`, `graph`, `config`, `providers/` (GitHub via
  GraphQL/Octokit). Exported as the library (`.`).
- `src/mcp/` — the wrapper: `tools`, the JSON-RPC `protocol`, and the `stdio` + `http` transports.
  Exported as `./mcp`.
- `bin/cli.ts` — the entry: MCP server (stdio default, `--http`) or direct subcommands.

## Commands

- `npm test` — vitest. **Not `bun test`:** the GitHub provider tests use **nock**, which needs Node's
  fetch; nock can't intercept Bun's.
- `npm run build` — tsup → `dist/` (cli, index, mcp).
- `npm run format` — prettier.

Keep the code **runtime-portable** — no Bun-only APIs in `src/`/`bin/` (use `yaml`, `node:crypto`,
`node:child_process`, `@hono/node-server`, `process` streams). It must run under both Node and Bun.

## Releasing — always ask first, never publish unprompted

Pushing code **never publishes** — a push only runs CI (`ci.yml`). Publishing happens **only** when a
GitHub **Release** is published, which fires the `Publish` workflow (OIDC/tokenless, provenance automatic).

**When you finish a job that changed shippable code and the tests pass, ASK the user whether to create a
new release.** Do not create a release, bump the version for release, or publish unless the user
explicitly confirms — release creation is theirs to approve every time.

On an explicit "yes":

1. Bump `version` in `package.json` — **patch** for a fix, **minor** for a feature, **major** for a
   breaking change — and keep `SERVER_INFO.version` in `src/mcp/protocol.ts` in sync.
2. Commit and push the bump (this alone still does not publish).
3. `gh release create vX.Y.Z --generate-notes` — the tag must equal the new version. Publishing this
   release is what triggers the npm publish.

On a "no", leave the code pushed and unreleased. Never skip the question, and never create the release
on your own initiative.
