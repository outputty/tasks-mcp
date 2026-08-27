# A cache file not at its project id's path is listed as a project but yields no tasks

## 1. The problem

The file layer stores one YAML per project at the path the id maps to. A slash in the id **nests** it
into subfolders:

```
cachePath(cacheDir, "other/proj", ".yaml")  ->  <cacheDir>/other/proj.yaml
```

Two reads reach that store by different routes:

- **`list_projects`** (`readProjectSummaries`) WALKS every file under the cache dir and reads each
  file's declared `project:` key. It lists a project from wherever the file physically sits.
- **`list_tasks`** goes through `FileProvider.load(project)`, which reads
  `cachePath(cacheDir, project, ".yaml")` — the path DERIVED from the id. It reads only the one
  canonical location (`src/core/providers/file.ts:68-75`).

So the two disagree the moment a file is not at its id's path: the walk still finds it, the derived read
does not.

## 2. What was expected

A cross-process test wrote a task into the cache from a second OS process and expected the console —
which reads `list_projects` then `list_tasks` per project — to show it:

```js
// project id "other/proj", but the file written to a FLATTENED name
const full = path.join(cacheDir, "other-proj.yaml");
fs.writeFileSync(full, "project: other/proj\ntasks:\n  - id: a\n    title: A\n    status: open\n");
```

The belief: a file declaring `project: other/proj` is that project's store, so its task appears in the
queue.

## 3. What actually happened

`list_projects` reported the project (it read the declared id), but `list_tasks` for it came back
empty — it looked at `<cacheDir>/other/proj.yaml` (nested), which did not exist. Real output from a
repro over the shipped tool:

```
fetchQueues projects: [ 'acme/seed', 'other/proj' ]
fetchQueues readyIds: [ [], [] ]
other/proj tasks: []
```

The console rendered only the seed; the new project never appeared, and four `test/tui-events.test.ts`
cases failed with `frame never contained "other/proj"`. The chase cost a debug cycle — a standalone
repro that first proved the SSE subscription fired (`onChanged: other/proj`), then proved
`fetchQueues` returned the project with zero tasks — before the flattened path was the answer. Placing
the file at the nested path fixed it:

```
fetchQueues readyIds: [ [], [ 'a' ] ]  // expected
```

## 4. Where it showed, and whether it repeats

1. The four failing cases in `test/tui-events.test.ts` (PR #97), each `frame never contained "<proj>"`.
2. The repro: `fetchQueues projects` listed `other/proj` while `other/proj tasks` was `[]`.
3. The fix: `writeFromAnotherProcess` now writes `path.join(cacheDir, ...project.split("/")) + ".yaml"`.
4. `test/events.test.ts` avoided the trap by construction — it uses flat ids (`other-proj`) or the
   nested path (`acme/gadget.yaml`) that matches the id.

×1.

## 5. How to prevent it

**When you hand-write a cache file for a cross-process test, put it at the id's `cachePath` — a slash
nests it (`a/b` → `<cacheDir>/a/b.yaml`), never a flattened name.** And remember the two read paths
disagree: `list_projects` walks and reads each file's declared `project:`, so it lists a project from
any path, while `list_tasks` derives the path from the id and reads only the canonical location. A
project that appears in `list_projects` but returns no tasks is a file off its id's path.

```js
// AFTER — the file at the path the id maps to
const full = path.join(cacheDir, ...project.split("/")) + ".yaml"; // "other/proj" -> other/proj.yaml
fs.mkdirSync(path.dirname(full), { recursive: true });
fs.writeFileSync(full, `project: ${project}\ntasks:\n  - id: a\n    title: A\n    status: open\n`);
```
