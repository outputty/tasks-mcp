# Deriving a project id from a provider makes that provider the authority

*PLANNING, 2026-08-26. Target [#54](https://github.com/outputty/tasks-mcp/issues/54).*

## 1. The problem

tasks-mcp stores a project's tasks in a **provider stack**: a `FileProvider` cache on top, remotes
beneath it, deepest layer authoritative. The stack is explicitly built to hold more than one remote —
`src/core/providers/provider.ts` opens with "remotes below it (GitHub today, Linear tomorrow)", and
registration is a one-line table:

```ts
// Registered remote layers. Adding Linear is one entry here plus its class — nothing else moves.
const REMOTES: Record<string, (config: ConfigProvider) => Provider> = {
  github: (config) => new GitHubProvider(config),
};
```

A project also needs an **identity** — the key its cache file, config override and claim ledger are all
stored under. Until this session that key was the project's absolute filesystem path, hashed.

```
BEFORE
  project = /Users/me/code/tasks-mcp
      -> projectSlug()  ->  tasks-mcp-c9d0823e
      -> <cacheDir>/tasks-mcp-c9d0823e.yaml
```

## 2. What was expected

Planning proposed replacing the path with the project's GitHub repository, and the case looked strong.
The trail records it as settled:

> A project IS its GitHub repo: the normalised `owner/repo` from `origin`, stored at
> `<cacheDir>/<owner>/<repo>.yaml`.

The reasoning was measured, not asserted. Identity-by-path was demonstrably broken: 26 of 32 cache files
on the author's machine were partial copies of one repository's graph, 4.2 MB, one per git worktree,
because `FileProvider` keyed on the raw path while `ClaimStore` keyed on a slug that resolved worktrees
to their primary checkout. Keying on the repository fixed that, made two checkouts correctly one project,
made a moved folder a non-event, and made the id readable instead of hashed.

It was also cheap: `buildState` calls `resolveRepo(project)` and everything downstream uses only the
resolved coordinates, so the path's remaining job was serving as a memo key.

## 3. What actually happened

The user rejected it, in one sentence:

> I wrongfully used the term that GitHub is central, but GitHub is just one of the providers.

The proposal was correct about the bug and wrong about the fix. Reading `owner/repo` out of
`git remote get-url origin` makes **GitHub the authority over what every project is called** — including
projects configured to use a different remote entirely. A Linear-backed project would have had no
identity at all, and the failure would have surfaced as an unresolvable git error rather than as a
design decision anyone made.

The session had already read the file that says so. `provider.ts` was quoted in the very task brief that
proposed the derivation, for its *optional seam method* pattern, while its opening paragraph about
"Linear tomorrow" went past unremarked.

The settled model derives nothing:

```
AFTER
  tasks-mcp --project-id outputty/tasks-mcp     # supplied, opaque, provider-agnostic
      -> <cacheDir>/outputty/tasks-mcp.yaml
      -> per-project config: { provider: "github", repo: "outputty/tasks-mcp" }
```

Where a remote lives became per-project *configuration*, defaulting to the launch directory's `origin`
when the provider is github. The worktree bug is still fixed, for a better reason: `.mcp.json` is checked
into the repository, so every worktree inherits the same `--project-id` with nothing to configure.

## 4. Where it showed, and whether it repeats

1. `src/core/providers/provider.ts:1` — "remotes below it (GitHub today, Linear tomorrow)": read during
   planning, cited for a different reason, and contradicted in the same brief.
2. `src/core/providers/provider.ts:63` — `REMOTES`, whose comment states adding a provider moves nothing
   else. A derived identity would have made that false.
3. `.claude/product.md` — the North Star promises "one or more connected providers", written before this
   session and unchanged by it.
4. `src/core/service.ts:105` — `config.get(ctx.project).provider` already selects the remote **per
   project**, so the code had a per-project provider concept the identity proposal ignored.
5. The same session found the reciprocal gap: `buildStack` returns exactly two layers, so the N-remote
   promise is unkept in the builder as well. Folded into the same target.

×1 in this archive. The shape to watch is broader than identity: **any key derived from one layer's
coordinates silently promotes that layer**, and the promotion is invisible while only one layer exists.

## 5. How to prevent it

**When a design proposes deriving a system-wide key from a layer's data, name the layer that would be
demoted, and check whether the seam claims to support more than one.** Do this at the point the
derivation is proposed, not at review — the derivation looked free precisely because only one
implementation existed to test it against.

The concrete rule for this repository, now in `product.md`'s Language:

> **project id** — an opaque, provider-agnostic string the user supplies (`--project-id`), never derived.
> Deriving it from a remote was rejected: it would make one provider the authority over projects that may
> not use it.

A seam with one implementation is not evidence of a single-implementation design. Read what the seam says
it is for, not what it currently holds.
