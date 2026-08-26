# Configuration reference

The settings, the four layers that resolve them, and the files they live in. Generated from
`src/core/providers/config.ts` for version 0.21.0.

Configuration is stored beside the task caches, never in your repository. Nothing here is read from a
file inside the project.

## The settings

Every key is optional. This is the object `set_config` takes and the shape of all four layers
`get_config` returns.

| Key                 | Type       | Default   | Meaning                                                                                                     |
| ------------------- | ---------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `provider`          | `string`   | `github`  | The remote layer backing this project (singular form of `providers`; a one-element list).                   |
| `providers`         | `string[]` | absent    | The remote layers, deepest last. A one-element list equals `provider`. `github` is the only registered one. |
| `repo`              | `string`   | absent    | GitHub `owner/repo`. Absent falls back to the `origin` of the server's launch directory.                    |
| `projects`          | `boolean`  | `true`    | Whether to mirror tasks onto a GitHub Projects v2 board.                                                    |
| `projectNumber`     | `number`   | absent    | Target an existing board by number. Positive integer.                                                       |
| `board`             | `string`   | `Tasks`   | Board title to find or create when `projectNumber` is absent.                                               |
| `labels`            | `boolean`  | `true`    | Whether to wear execution properties as GitHub labels.                                                      |
| `labelFields`       | `string[]` | all eight | Which fields become labels: `type`, `kind`, `tier`, `qa`, `spec`, `stage`, `priority`, `status`.            |
| `claimStaleMinutes` | `number`   | `15`      | Minutes of silence before a claim is reported stale. Positive integer.                                      |

The schema is strict. An unknown key or a mistyped value throws and names where it came from:

```text
Error: invalid config /Users/you/.cache/tasks-mcp/config.yaml — projectNumber: Expected number, received string
```

Setting `projectNumber` to a board that is not linked to the repository throws
`Projects v2 board #<n> not found`. Without `projectNumber`, a board with the configured title is
created and linked if none exists.

## Layers

Weakest first: **defaults < CLI flags < global spec < per-repo override**. Each layer is a shallow
merge over the one before it, key by key. `get_config` returns all four:

| Layer       | Source                                               | Applies to    |
| ----------- | ---------------------------------------------------- | ------------- |
| `flags`     | The CLI options the server process was started with. | every project |
| `global`    | `<cacheDir>/config.yaml`                             | every project |
| `repo`      | `<cacheDir>/<id>.config.yaml`                        | one project   |
| `effective` | The three merged.                                    | —             |

Only four CLI options reach the `flags` layer: `--provider`, `--project-number`, `--no-projects`, and
`--board`. `--cache-dir` and `--sync-interval` are deployment knobs and never appear in any layer.

```json
{
  "flags": {},
  "global": {},
  "repo": {
    "claimStaleMinutes": 30
  },
  "effective": {
    "claimStaleMinutes": 30
  }
}
```

Config files are re-read on every operation, memoized on mtime, so a change made centrally reaches a
running server without a restart. A change to any effective setting also rebuilds the GitHub layer's
resolved state on its next call.

`set_config` writes YAML. It merges the patch into whichever file the `scope` names and returns the
new effective object. There is no CLI subcommand that writes configuration.

## Files

| File                           | Holds                                                 |
| ------------------------------ | ----------------------------------------------------- |
| `<cacheDir>/config.yaml`       | The global spec.                                      |
| `<cacheDir>/<id>.config.yaml`  | One project's override.                               |
| `<cacheDir>/<id>.yaml`         | One project's task cache — the file provider's store. |
| `<cacheDir>/<id>.yaml.corrupt` | A task cache that failed to parse, set aside.         |
| `<cacheDir>/claims/<id>.json`  | One project's claim ledger.                           |

`cacheDir` is `--cache-dir` when given, otherwise `$XDG_CACHE_HOME/tasks-mcp`, otherwise
`~/.cache/tasks-mcp`.

`<id>` is the [project id](reference-cli.md#the-project-id) verbatim — no hash. An id with a `/` nests
into folders (`outputty/tasks-mcp.yaml` lives under `<cacheDir>/outputty/`), so the directory stays
human-readable. An id that would escape the cache directory (a `..` segment) is refused; an absolute
path passed as an id nests harmlessly rather than escaping.

Because the id is supplied, not derived, every git worktree launched from the same checked-in
`.mcp.json` shares one `--project-id` and therefore one task cache and one claim ledger — no git
resolution of a worktree back to its primary checkout. (Before this, the cache filename was hashed off
the absolute path, e.g. `tasks-mcp-1a2b3c4d.yaml`, so each worktree kept a separate, partial copy.)

The task cache is disposable. Delete it and the next `sync` rebuilds it from the layers below, deps and
all. A cache file that cannot be parsed is renamed to `.corrupt`, a warning goes to stderr, and the
layer continues empty rather than failing the call.

> **Upgrading from a hashed cache.** Caches written before the id model have a hashed filename
> (`<cacheDir>/tasks-mcp-1a2b3c4d.yaml` and a matching `claims/…json`). They are orphaned, not migrated:
> safe to delete, and the first `sync` under the new id rebuilds the cache from the remote.

## Credentials

| Source          | Checked                               |
| --------------- | ------------------------------------- |
| `GITHUB_TOKEN`  | first                                 |
| `GH_TOKEN`      | second                                |
| `gh auth token` | last, by shelling out to the `gh` CLI |

With none of the three, any GitHub-touching call throws:

```text
Error: no GitHub credentials: set GITHUB_TOKEN, or run `gh auth login`
```

The token is re-read for each client lookup, so a rotated `gh` credential is picked up without a
restart.

| Capability                      | Requires                                           |
| ------------------------------- | -------------------------------------------------- |
| Issues, labels, sub-issue edges | ordinary repository write access                   |
| Projects v2 board               | the `project` scope — `gh auth refresh -s project` |
| `delete_task`                   | the delete-issue permission: repo admin or triage  |

Without the `project` scope the board is skipped with a warning on stderr and tasks still land as
issues.

## Which repository the GitHub layer talks to

The project id is opaque, so it never names a repository. GitHub coordinates come from configuration
instead:

1. The project's `repo` setting (`owner/repo`), if set. This makes the provider work with **no git
   repository present at all** — a shared server can back a project it has no checkout of.
2. Otherwise, the `origin` remote of the directory the server was **launched from**. A server started
   by a repo's `.mcp.json` is launched in that repo, so `origin` supplies its coordinates with nothing
   to configure.

A server started outside any git repository with no `repo` set has neither, and any GitHub-touching
call throws — naming `repo`, not git:

```text
Error: no GitHub repo for this project — set `repo` (owner/repo) in its config, or launch the server from the repository so `origin` can supply it
```

The remedy is `set_config` with `{ "repo": "owner/repo" }` for that project.
