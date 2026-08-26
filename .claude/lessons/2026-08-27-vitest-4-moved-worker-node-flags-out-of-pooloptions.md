# Vitest 4 removed `poolOptions`, so worker node flags go in top-level `test.execArgv` and the old shape is a silent no-op

## 1. The problem

The `--tui` console's renderer (`@opentui/core`) reaches native code over Node's FFI, which is gated
behind `--experimental-ffi`. Vitest runs each test file in a forked worker, so a test that constructs the
renderer needs the flag on the WORKER's node, not the runner's. The documented-everywhere way to pass
node flags to vitest workers is the pool's `execArgv`:

```ts
// vitest.config.ts — the Vitest 3 shape
export default defineConfig({
  test: { pool: "forks", poolOptions: { forks: { execArgv: ["--experimental-ffi"] } } },
});
```

## 2. What was expected

With `poolOptions.forks.execArgv` set, the forked worker starts with `--experimental-ffi`, and
`createTestRenderer()` initialises the native FFI.

## 3. What actually happened

The flag never reached the worker. The renderer test failed with the exact error the flag is supposed to
fix:

```
Error: Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet
```

Running the same suite with `NODE_OPTIONS=--experimental-ffi` (which DID work) printed the reason:

```
DEPRECATED  `test.poolOptions` was removed in Vitest 4. All previous `poolOptions` are now top-level
options. Please, refer to the migration guide.
```

Vitest 4 accepts the `poolOptions` key without error and silently ignores it. The fix is the top-level
option:

```ts
// vitest.config.ts — Vitest 4
export default defineConfig({
  test: { execArgv: ["--experimental-ffi"] }, // pool defaults to "forks"
});
```

With that, the renderer test passed and the full suite (232 tests) stayed green.

## 4. Where it showed, and whether it repeats

1. `vitest.config.ts` — the first version used `poolOptions.forks.execArgv` and the FFI test failed;
   the top-level `test.execArgv` version passed.
2. The `DEPRECATED test.poolOptions was removed in Vitest 4` warning is the only signal — no error, no
   non-zero exit, so a config that looks right is inert.
3. This repo is on `vitest@^4.1.10`; any future need to pass a node flag to a worker (another native or
   experimental dependency) hits the same removed key.
   ×1.

## 5. How to prevent it

**On Vitest 4, pass worker node flags with a top-level `test.execArgv`, never `poolOptions` — the old
key is accepted and silently ignored.** When a config that should change worker behaviour has no effect,
run the suite once and read the `DEPRECATED` lines: Vitest 4 flattened the pool options and warns rather
than errors.

BEFORE: `test.poolOptions.forks.execArgv` → flag dropped → `FFI is not available`.
AFTER: `test.execArgv` → flag reaches the worker → the renderer initialises.

## References

1. **Vitest** — the migration guide the deprecation warning links (`vitest.dev/guide/migration`,
   "pool rework"): `poolOptions` were removed in v4 and promoted to top-level `test` options, `execArgv`
   among them.
