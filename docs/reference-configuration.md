# Configuration reference

The settings, the four layers that resolve them, and the files they live in. Generated from
`src/core/providers/config.ts` for version 0.21.0.

Configuration is stored beside the task caches, never in your repository. Nothing here is read from a
file inside the project.

## The settings

Every key is optional. This is the object `set_config` takes and the shape of all four layers
`get_config` returns.

| Key                 | Type       | Default   | Meaning                                                                                          |
| ------------------- | ---------- | --------- | ------------------------------------------------------------------------------------------------ |
| `provider`          | `string`   | `github`  | The remote layer backing this project. `github` is the only registered one.                      |
| `projects`          | `boolean`  | `true`    | Whether to mirror tasks onto a GitHub Projects v2 board.                                         |
| `projectNumber`     | `number`   | absent    | Target an existing board by number. Positive integer.                                            |
| `board`             | `string`   | `Tasks`   | Board title to find or create when `projectNumber` is absent.                                    |
| `labels`            | `boolean`  | `true`    | Whether to wear execution properties as GitHub labels.                                           |
| `labelFields`       | `string[]` | all eight | Which fields become labels: `type`, `kind`, `tier`, `qa`, `spec`, `stage`, `priority`, `status`. |
| `claimStaleMinutes` | `number`   | `15`      | Minutes of silence before a claim is reported stale. Positive integer.                           |

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
| `global`    | `<cacheDir>/config.yaml`                             | every repo    |
| `repo`      | `<cacheDir>/<projectSlug>.config.yaml`               | one repo      |
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

| File                                    | Holds                                                 |
| --------------------------------------- | ----------------------------------------------------- |
| `<cacheDir>/config.yaml`                | The global spec.                                      |
| `<cacheDir>/<projectSlug>.config.yaml`  | One repo's override.                                  |
| `<cacheDir>/<projectSlug>.yaml`         | One project's task cache — the file provider's store. |
| `<cacheDir>/<projectSlug>.yaml.corrupt` | A task cache that failed to parse, set aside.         |
| `<cacheDir>/claims/<repoSlug>.json`     | One repo's claim ledger.                              |

`cacheDir` is `--cache-dir` when given, otherwise `$XDG_CACHE_HOME/tasks-mcp`, otherwise
`~/.cache/tasks-mcp`.

`projectSlug` is `<basename of the project path>-<first 8 hex of sha256(absolute project path)>`, so
two checkouts of the same repository keep separate caches.

`repoSlug` is the same formula applied to the repository's **primary** checkout, resolved with
`git rev-parse --git-common-dir`. A git worktree and the checkout it was cut from therefore share one
claim ledger: a worker claiming from inside a worktree is visible to a dispatcher sweeping from the
primary checkout.

The task cache is disposable. Delete it and the next `sync` rebuilds it from the layers below, deps and
all. A cache file that cannot be parsed is renamed to `.corrupt`, a warning goes to stderr, and the
layer continues empty rather than failing the call.

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
issues. The GitHub layer also needs the project directory to be a git repository whose `origin` remote
points at github.com; otherwise it throws
`no git 'origin' remote in <path> — the GitHub provider needs one`.
