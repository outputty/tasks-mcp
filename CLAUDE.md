# tasks-mcp — working notes for Claude

`@outputty/tasks-mcp`: outputty's task tracker as an MCP server **and** a library, Node-native, published
to npm. It is split so the MCP layer wraps the core, never the reverse:

- `src/core/` — the business logic: `service` (the `TaskStack` orchestrator), `graph` (pure engine on
  graphology: ready/schedule/prereqs/blockers), and `providers/` — the task layers behind one
  `Provider` seam (`file.ts` on top, the local store all reads hit; `github.ts` beneath it — Octokit,
  GraphQL only) plus `config.ts`, the ConfigProvider (zod-parsed, global spec + per-repo override).
  Exported as the library (`.`).
- `src/mcp/` — the wrapper on the official `@modelcontextprotocol/sdk`: the tool surface (`server`)
  and the `stdio` + `http` transports. Exported as `./mcp`.
- `bin/cli.ts` — the entry, on commander (user ruling: a real CLI library, never homebrew argv
  parsing): MCP server (stdio default, `--http`) or direct subcommands.
- `docs/` — architecture (with the committed SVG), CLI, development. The README is MCP-first; the CLI
  is the secondary aspect.

## Code rules (the user's standing preferences — follow them in every change)

- **A provider is ONE class in ONE file.** Every provider is a class implementing the `Provider` seam,
  and it wraps its own API client (`GitHubProvider` holds its `Octokit`) — no satellite modules
  (client/issues/projects were folded into the class by request). The client is the one injection
  point — constructor parameter, defaulted for production, passed explicitly by tests.
- **Providers form a STACK, and stack order is authority** (user ruling 2026-08-17). The file layer
  sits on top (every read hits it, nothing else), remotes below; the DEEPEST layer wins a sync
  disagreement. Absence is not a claim — a task missing from a layer is pushed into it, never deleted
  from the others (that is what makes adding a layer a free migration) — and deletions never
  propagate. Each layer owns its own handles (issue ids, card ids) in a private index; nothing above
  the seam sees them. The seam is `init` / `pull` / `upsert` — create-vs-update is the layer's call.
- **All remote setup happens in `init()`.** There are no async constructors, so every provider has an
  explicit `async init(ctx)` — credentials, repo resolution, and container selection/creation (for
  GitHub: finding or creating the Projects v2 board) run there, once per project, never lazily inside
  task calls. The service awaits `init` before any operation.
- **The MCP layer is the official `@modelcontextprotocol/sdk`** — never a hand-rolled JSON-RPC
  handler. Tools declare zod input AND output schemas; results carry `structuredContent`.
- **The server version comes from `package.json`** (imported at build time) — never a hand-maintained
  copy in the source.
- **Exit early.** Guard clauses and early returns; `else` only when the branches are genuinely
  symmetric. oxlint's `no-else-return` (no else-if allowed) backs this in the build.
- **Pattern matching is `ts-pattern`.** When a function dispatches on the value or shape of one
  input, write `match(x).with(...).exhaustive()` — `.exhaustive()` whenever the input is a closed
  union, `.otherwise()` only for genuinely open input. (The user asked for "ts-match"; that npm
  package is unmaintained — last publish 2022, ~460 downloads/week — so the maintained standard
  `ts-pattern` (~5.4M/week) fills the role.)
- **Orchestrator/executor.** A public method orchestrates: it sequences executor calls and assumes
  no knowledge of their implementation (`create` = issue then board; `sync` = pull, merge, push).
  Executors (`createIssue`, `syncToBoard`, `mergeRemote`, …) own the specific logic and let errors
  bubble. An orchestrator catches only where business logic demands a fallback the executor cannot
  decide — e.g. the board is best-effort, so board errors are caught and logged at the orchestration
  seam while issue errors always propagate.
- **No imports inside functions.** All imports sit at the top of the module — no lazy
  `await import(...)` to shave startup or dodge a dependency in tests.
- **Configuration is a provider of its own, configured through the server** (user ruling
  2026-08-17). `ConfigProvider` is one class; preferences are set via the `get_config`/`set_config`
  MCP tools and stored beside the caches — a global spec for all repos, overridden per repo
  (precedence: defaults < flags < global < per-repo). The server hardcodes no user preferences;
  label prefs are read live so a change propagates to the next write. Nothing is configured by files
  inside the user's repo.
- **GitHub labels carry the execution properties** (user ruling 2026-08-17: "leverage labels as much
  as possible"). kind/tier/qa/spec/stage/priority are `field:value` labels — created on demand,
  color-coded per field, editable in the GitHub UI and pulled back by sync; foreign labels are never
  touched; junk values are ignored, not crashed on. The body block keeps only what labels cannot
  carry (id, deps, scope, brief, contract, attempts, discovered_from).
- **The two planning questions are first-class tools.** `prereqs` (what must be done before X, as
  dependency-ordered layers) and `blockers` (open tasks ranked by transitive downstream impact, with
  `unblockedBy` and `highPriorityBlocked`). Keep their answers simple and fast — they are the point
  of the graph.
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

- `npm run check` — THE build: format check → oxlint → typecheck → tests → tsdown. This is the exact
  command CI runs; run it before calling any change done.
- `npm test` — vitest. **Not `bun test`:** the GitHub provider tests use **nock**, which needs Node's
  fetch; nock can't intercept Bun's.
- `npm run lint` — oxlint, which enforces the working-set caps: complexity ≤ 7, ≤ 24 lines per
  function, nesting ≤ 3, no else-after-return (see `.oxlintrc.json`). Fix by decomposing; a
  deviation is a targeted disable comment with a written why, never a loosened threshold.
- `npm run typecheck` — TypeScript 7 (the native compiler; the `typescript` package IS ts7 now).
- `npm run build` — tsdown (Rolldown + oxc) → `dist/` (cli, index, mcp). `oxc-transform` is the
  low-level transpile API inside that stack, not a tool to drive directly.
- `npm run format` — oxfmt (user ruling 2026-08-17: the oxc toolchain — oxlint/oxfmt/tsdown — over
  eslint/prettier/tsup).

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
