// The file layer — the top of the provider stack: the fast local store every read hits. One YAML file
// per project under the OS cache dir (overridable with --cache-dir), NEVER in the repo. It is a true
// cache — a fresh or deleted file is rebuilt by `sync` from the layers below, because every task's full
// record (deps included) is mirrored into them.

import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { ProjectContext, Task } from "../types.ts";
import type { ServerOptions } from "../types.ts";
import { defaultCacheDir, projectSlug } from "./config.ts";
import { withDefaults } from "../graph.ts";
import type { Provider, ProviderState } from "./provider.ts";

const HEADER =
  "# tasks-mcp cache — rebuilt from the stack by `sync`. Safe to delete; not committed.\n";

/** The file's tasks ([] for an empty file), or null when the YAML is unreadable or the wrong shape. */
function tryParse(text: string): Task[] | null {
  try {
    const parsed = parse(text) as { tasks?: unknown } | null;
    if (parsed === null || parsed === undefined) return [];
    if (typeof parsed !== "object") return null;
    if (parsed.tasks === undefined) return [];
    return Array.isArray(parsed.tasks) ? (parsed.tasks as Task[]) : null;
  } catch {
    return null;
  }
}

export class FileProvider implements Provider {
  readonly name = "file";

  constructor(private readonly options: ServerOptions = {}) {}

  async init(_ctx: ProjectContext): Promise<void> {}

  async pull(ctx: ProjectContext): Promise<Map<string, ProviderState>> {
    const out = new Map<string, ProviderState>();
    for (const task of this.load(ctx.project)) out.set(task.id, { task });
    return out;
  }

  async upsert(ctx: ProjectContext, task: Task): Promise<void> {
    await this.upsertMany(ctx, [task]);
  }

  /** The batch form the service prefers: one read and one write however many tasks change. */
  async upsertMany(ctx: ProjectContext, tasks: Task[]): Promise<void> {
    const all = this.load(ctx.project);
    for (const task of tasks) {
      const at = all.findIndex((t) => t.id === task.id);
      if (at === -1) all.push(task);
      else all[at] = task;
    }
    this.save(ctx.project, all);
  }

  /** The file for a project: `<cacheDir>/<basename>-<hash>.yaml`, keyed by the project's path. */
  private fileFor(project: string): string {
    return path.join(this.options.cacheDir ?? defaultCacheDir(), `${projectSlug(project)}.yaml`);
  }

  private load(project: string): Task[] {
    const file = this.fileFor(project);
    if (!fs.existsSync(file)) return [];
    const tasks = tryParse(fs.readFileSync(file, "utf8"));
    if (tasks === null) return this.quarantine(file);
    // Files written before the stack carried per-provider refs alongside each task; the layers own
    // their handles now, so a legacy `refs` key is dropped on read.
    return tasks.map((t) => {
      const { refs: _refs, ...task } = t as Task & { refs?: unknown };
      return withDefaults(task);
    });
  }

  /** A file that cannot be parsed is set aside, not fatal: the layer continues empty and the next
   *  sync refills it from the layers below (absence is not a claim; GitHub is deeper and wins). */
  private quarantine(file: string): Task[] {
    fs.renameSync(file, `${file}.corrupt`);
    console.error(
      `tasks-mcp: corrupt task file quarantined to ${file}.corrupt — run sync to rebuild`,
    );
    return [];
  }

  private save(project: string, tasks: Task[]): void {
    const file = this.fileFor(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1));
    const body = stringify({ tasks: sorted });
    fs.writeFileSync(file, HEADER + (body.endsWith("\n") ? body : body + "\n"));
  }
}
