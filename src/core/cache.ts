// The task cache — the fast local store the graph engine reads. It is NOT in the repo: it lives under
// the OS cache dir (overridable with --cache-dir), one file per project. It is a true cache — a fresh or
// deleted cache is rebuilt from the provider by `sync`, because every task's full record (deps included)
// is mirrored into its issue body.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import type { CacheEntry } from "./types.ts";
import { withDefaults } from "./graph.ts";
import { defaultCacheDir } from "./config.ts";

const HEADER =
  "# tasks-mcp cache — rebuilt from the provider by `sync`. Safe to delete; not committed.\n";

export class Cache {
  constructor(private readonly file: string) {}

  /** The cache file for a project: `<cacheDir>/<basename>-<hash>.yaml`, keyed by the project's path. */
  static forProject(
    project: string,
    cacheDir: string = defaultCacheDir(),
  ): Cache {
    const base = path.basename(project) || "repo";
    const hash = createHash("sha256").update(project).digest("hex").slice(0, 8);
    return new Cache(path.join(cacheDir, `${base}-${hash}.yaml`));
  }

  load(): CacheEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const parsed = parse(fs.readFileSync(this.file, "utf8")) as {
      tasks?: CacheEntry[];
    } | null;
    const tasks = parsed?.tasks ?? [];
    return tasks.map((t) => ({ ...withDefaults(t), refs: t.refs }));
  }

  save(entries: CacheEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
    const body = stringify({ tasks: sorted });
    fs.writeFileSync(
      this.file,
      HEADER + (body.endsWith("\n") ? body : body + "\n"),
    );
  }
}
