# Development

```bash
npm install
npm run check        # THE build, exactly what CI runs: oxfmt check -> oxlint -> tsc (TS7) -> tests -> tsdown
npm test             # vitest alone: graph engine · providers (nock) · stack semantics · MCP server
npm run build        # tsdown alone -> dist/ (cli, index, mcp)
```

Developing needs **Node ≥ 22** (the tsdown toolchain); the published package itself still runs on 18.

The toolchain is oxc end to end — oxlint (with build-enforced working-set caps: complexity ≤ 7, ≤ 24
lines per function), oxfmt, tsdown (Rolldown + oxc) — plus TypeScript 7 for typechecking.

## Testing

Tests are end to end, mocked at the network boundary: the suites drive the real `TaskStack`, the real
`FileProvider` and `GitHubProvider`, and the real MCP SDK client over real HTTP — **nock** answers
api.github.com so the actual GraphQL queries and responses are exercised without a network or
credentials. Test repos are real `git init` temp dirs, so repo resolution runs for real too. Stack
semantics get a dedicated three-layer suite with a controllable `MockProvider` as the deepest layer.
The pure graph engine keeps direct unit tests (no I/O to mock).

Run `npm test` — **not `bun test`**: nock needs Node's fetch and cannot intercept Bun's.

## Releasing

Publishing is automated, deliberate, and **tokenless** — it runs only when a GitHub **Release** is
cut, authenticating with **npm Trusted Publishing (OIDC)**: no `NPM_TOKEN` is stored anywhere.

One-time setup:

1. **First publish by hand** (OIDC can't do a package's first publish): `npm run build && npm publish`.
2. On npmjs, open the package → **Settings → Publishing → Add a trusted publisher** → GitHub Actions →
   org `outputty`, repo `tasks-mcp`, workflow `publish.yml`.

After that, **pushing code never publishes** — a push just runs CI (`npm run check`). Releasing is a
separate, manual step:

1. Bump `version` in `package.json`, commit, and push. CI runs; nothing publishes.
2. Create a GitHub **Release** with the tag `vX.Y.Z` (matching the version) — e.g.
   `gh release create v0.8.0 --generate-notes`, or the Releases UI.

Publishing the release fires the `Publish` workflow, which checks the tag matches `package.json` and
the version is new, runs the full check, and `npm publish`es via **OIDC** — the runner proves its
identity to npm with a short-lived token, and **provenance** is attached automatically. Nothing to
store, rotate, or leak.
