// The file layer — the top of the provider stack: the fast local store every read hits. One YAML file
// per project under the OS cache dir (overridable with --cache-dir), NEVER in the repo. It is a true
// cache — a fresh or deleted file is rebuilt by `sync` from the layers below, because every task's full
// record (deps included) is mirrored into them.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import type { ProjectContext, Task } from "../types.ts";
import type { ServerOptions } from "../config.ts";
import { defaultCacheDir } from "../config.ts";
import { withDefaults } from "../graph.ts";
import type { Provider, ProviderState } from "./provider.ts";

const HEADER =
  "# tasks-mcp cache — rebuilt from the stack by `sync`. Safe to delete; not committed.\n";

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
    const tasks = this.load(ctx.project);
    const at = tasks.findIndex((t) => t.id === task.id);
    if (at === -1) tasks.push(task);
    else tasks[at] = task;
    this.save(ctx.project, tasks);
  }

  /** The file for a project: `<cacheDir>/<basename>-<hash>.yaml`, keyed by the project's path. */
  private fileFor(project: string): string {
    const base = path.basename(project) || "repo";
    const hash = createHash("sha256").update(project).digest("hex").slice(0, 8);
    return path.join(this.options.cacheDir ?? defaultCacheDir(), `${base}-${hash}.yaml`);
  }

  private load(project: string): Task[] {
    const file = this.fileFor(project);
    if (!fs.existsSync(file)) return [];
    const parsed = parse(fs.readFileSync(file, "utf8")) as { tasks?: Task[] } | null;
    // Files written before the stack carried per-provider refs alongside each task; the layers own
    // their handles now, so a legacy `refs` key is dropped on read.
    return (parsed?.tasks ?? []).map((t) => {
      const { refs: _refs, ...task } = t as Task & { refs?: unknown };
      return withDefaults(task);
    });
  }

  private save(project: string, tasks: Task[]): void {
    const file = this.fileFor(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1));
    const body = stringify({ tasks: sorted });
    fs.writeFileSync(file, HEADER + (body.endsWith("\n") ? body : body + "\n"));
  }
}
