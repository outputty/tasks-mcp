// The committed cache — the authoritative task model, and the ONLY home of the dependency graph.
//
// Why authoritative, not a snapshot: a sync target like GitHub Issues has no native "depends-on", so the
// edges of the graph cannot live in the backend. They live here, in a file committed to the repo, so they
// survive a fresh clone and travel with the project. Reads (ready/schedule/planning) run over this file;
// writes update it first, then push the representable fields out to the sync targets.

import fs from "fs";
import path from "path";
import type { CacheEntry } from "./types.ts";
import { withDefaults } from "./graph.ts";

const HEADER =
  "# outputty tasks-mcp — the authoritative task graph, including dependencies. Committed on purpose:\n" +
  "# GitHub Issues and Projects cannot store deps, so this file is where they survive a clone.\n";

export class Cache {
  constructor(private readonly file: string) {}

  /** The cache file for a project: always `<project>/.claude/tasks.cache.yaml`. */
  static forProject(project: string): Cache {
    return new Cache(path.join(project, ".claude", "tasks.cache.yaml"));
  }

  load(): CacheEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const parsed = Bun.YAML.parse(fs.readFileSync(this.file, "utf8")) as {
      tasks?: CacheEntry[];
    } | null;
    const tasks = parsed?.tasks ?? [];
    return tasks.map((t) => ({ ...withDefaults(t), refs: t.refs }));
  }

  save(entries: CacheEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
    const body = Bun.YAML.stringify({ tasks: sorted }, null, 2);
    fs.writeFileSync(
      this.file,
      HEADER + (body.endsWith("\n") ? body : body + "\n"),
    );
  }
}
