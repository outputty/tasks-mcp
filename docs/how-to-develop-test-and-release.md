# How to develop, test, and release this package

For contributors working on tasks-mcp itself, not for people using it. If you are here to track tasks,
start with [the tutorial](tutorial-your-first-task-graph.md).

## Set up

```bash
git clone https://github.com/outputty/tasks-mcp.git
cd tasks-mcp
npm install
```

CI runs on Node 26, the floor the `--tui` console's renderer (`@opentui/core`) needs — its native FFI
wants Node 26.4+, and vitest passes `--experimental-ffi` to its workers (see `vitest.config.ts`). That
floor is what `engines` now declares (`>=26.4.0`); the tsdown build still targets a lower baseline for
the server and library, which run on older Node.

The toolchain is oxc end to end: **oxlint** for linting, **oxfmt** for formatting, **tsdown**
(Rolldown + oxc) for bundling, plus **TypeScript 7** for typechecking and **vitest** for tests.

## Run the build

One command runs exactly what CI runs, in order — format check, lint, typecheck, tests, bundle:

```bash
npm run check
```

The pieces, when you want one of them alone:

| Command                | Does                                                  |
| ---------------------- | ----------------------------------------------------- |
| `npm run format`       | Rewrite with oxfmt.                                   |
| `npm run format:check` | Fail on anything oxfmt would rewrite.                 |
| `npm run lint`         | oxlint.                                               |
| `npm run typecheck`    | `tsc --noEmit`.                                       |
| `npm test`             | `vitest run`.                                         |
| `npm run test:watch`   | vitest in watch mode.                                 |
| `npm run build`        | tsdown into `dist/` — `cli.js`, `index.js`, `mcp.js`. |
| `npm run dev`          | tsdown in watch mode.                                 |

Lint enforces working-set caps on top of oxlint's correctness defaults: cyclomatic complexity ≤ 7,
≤ 24 lines per function (blank lines and comments excluded), nesting depth ≤ 3. When a function
genuinely has to break one, add a targeted `oxlint-disable-next-line` with the reason written above
it. Do not loosen the threshold in `.oxlintrc.json`.

## Run the tests

```bash
npm test
```

Use npm, **not** `bun test`. The suites depend on nock, which intercepts Node's HTTP layer and cannot
intercept Bun's fetch; under Bun every GitHub-backed test fails inside
`convertFetchRequestToClientRequest`.

The suites are end to end, mocked only at the network boundary. They drive the real `TaskStack`, the
real `FileProvider` and `GitHubProvider`, and the real MCP SDK client over real HTTP; **nock** answers
`api.github.com`, so the actual GraphQL queries and responses are exercised without a network or
credentials. Test projects are real `git init` temp directories, so repo resolution runs for real too.

| Suite                  | Covers                                                                        |
| ---------------------- | ----------------------------------------------------------------------------- |
| `test/graph.test.ts`   | The pure graph engine: ready, planning, schedule, prereqs, blockers, ranking. |
| `test/lanes.test.ts`   | Scope containment, lane filtering, overlap.                                   |
| `test/claims.test.ts`  | The claim ledger, heartbeats, staleness, the release transitions.             |
| `test/github.test.ts`  | The GitHub layer: bodies, labels, sub-issue edges, board cards.               |
| `test/trails.test.ts`  | Issue comment threads in both directions.                                     |
| `test/service.test.ts` | Service semantics: authoring guards, adoption, conflicts, migration.          |
| `test/stack.test.ts`   | Stack semantics over three layers, plus the background loop.                  |
| `test/mcp.test.ts`     | The whole surface over the real SDK client and real HTTP.                     |

`test/helpers.ts` gives you `task()`, `tmp()`, and `tmpRepo()`; `test/nock-github.ts` is the fake
GitHub; `test/mock-provider.ts` is a controllable third layer for stack tests.

Adding a tool means adding its name to `TOOL_NAMES` in `test/mcp.test.ts`, beside the test that
asserts the surface.

## Release

Pushing code never publishes. A push runs CI (`npm run check`); publishing fires only when a GitHub
**Release** is created.

Authentication is npm Trusted Publishing over OIDC — no `NPM_TOKEN` is stored anywhere, and provenance
is attached automatically.

To cut a release:

1. Bump `version` in `package.json`. Nothing else carries the version: the server name and version
   come from the package at runtime.
2. Commit and push. CI runs; nothing publishes.
3. Create the Release with a tag matching the version:

   ```bash
   gh release create v0.21.0 --generate-notes
   ```

Publishing the release runs `.github/workflows/publish.yml`, which checks the tag matches
`package.json`, checks the version is not already on npm, runs the full `npm run check`, and publishes.
A mismatch fails the workflow with the two values printed.

### One-time setup, already done for this package

OIDC cannot perform a package's first publish; that one was done by hand. The trusted publisher is
configured on npmjs under **Settings → Publishing**, pointing at `outputty/tasks-mcp` and
`publish.yml`.

## What ships

`files` in `package.json` is `["dist", "README.md"]`. The `docs/` directory is not published, which is
why every link out of the README is an absolute GitHub URL — a reader arriving from npmjs.com cannot
follow a relative one.

`dts` is off in `tsdown.config.ts`, so no type declarations are published.
