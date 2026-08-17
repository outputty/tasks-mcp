// The task service: the committed cache is the authority, the provider is the mirror. Reads come straight
// from the cache (fast, and the only place with the dependency graph). Writes update the cache first,
// then reflect the representable fields into the provider. `sync` reconciles both ways — provider status
// wins for the fields it owns, deps stay the cache's alone.

import type { CacheEntry, ProjectContext, Task } from "./types.ts";
import type { Provider } from "./providers/provider.ts";
import { Cache } from "./cache.ts";
import { withDefaults } from "./graph.ts";
import { providerFor } from "./providers/provider.ts";

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
}

export interface TaskService {
  list(ctx: ProjectContext): Promise<Task[]>;
  get(ctx: ProjectContext, id: string): Promise<Task | null>;
  create(ctx: ProjectContext, task: Task): Promise<Task>;
  update(ctx: ProjectContext, id: string, patch: Partial<Task>): Promise<Task>;
  close(ctx: ProjectContext, id: string): Promise<void>;
  sync(ctx: ProjectContext): Promise<SyncResult>;
}

export class CachedTaskService implements TaskService {
  // The provider is resolved per project (config picks it), unless one is injected for tests.
  constructor(private readonly provider?: Provider) {}

  private providerFor(ctx: ProjectContext): Provider {
    return this.provider ?? providerFor(ctx.project);
  }

  async list(ctx: ProjectContext): Promise<Task[]> {
    return Cache.forProject(ctx.project).load();
  }

  async get(ctx: ProjectContext, id: string): Promise<Task | null> {
    return (
      Cache.forProject(ctx.project)
        .load()
        .find((t) => t.id === id) ?? null
    );
  }

  async create(ctx: ProjectContext, task: Task): Promise<Task> {
    const cache = Cache.forProject(ctx.project);
    const entries = cache.load();
    if (entries.some((e) => e.id === task.id))
      throw new Error(`task ${task.id} already exists`);
    const refs = await this.providerFor(ctx).create(ctx, task);
    entries.push({ ...task, refs });
    cache.save(entries);
    return task;
  }

  async update(
    ctx: ProjectContext,
    id: string,
    patch: Partial<Task>,
  ): Promise<Task> {
    const cache = Cache.forProject(ctx.project);
    const entries = cache.load();
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error(`no task ${id}`);
    const merged: CacheEntry = { ...entry, ...patch, id };
    merged.refs = await this.providerFor(ctx).update(
      ctx,
      stripRefs(merged),
      entry.refs ?? {},
    );
    entries[entries.indexOf(entry)] = merged;
    cache.save(entries);
    return stripRefs(merged);
  }

  async close(ctx: ProjectContext, id: string): Promise<void> {
    await this.update(ctx, id, { status: "done" });
  }

  async sync(ctx: ProjectContext): Promise<SyncResult> {
    const cache = Cache.forProject(ctx.project);
    const entries = cache.load();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const provider = this.providerFor(ctx);

    // Pull the fields the provider owns (title, status) back into the cache, learning each task's ref.
    const remote = await provider.pull(ctx);
    let pulled = 0;
    for (const [id, state] of remote) {
      const entry = byId.get(id);
      if (entry) {
        Object.assign(entry, state.patch, {
          refs: { ...entry.refs, ...state.refs },
        });
      } else {
        const created: CacheEntry = {
          ...withDefaults({ id, ...state.patch }),
          refs: state.refs,
        };
        byId.set(id, created);
        entries.push(created);
      }
      pulled++;
    }

    // Push cache tasks the provider has never seen (created offline), so the mirror catches up.
    let pushed = 0;
    for (const entry of entries) {
      if (remote.has(entry.id)) continue;
      entry.refs = await provider.create(ctx, stripRefs(entry));
      pushed++;
    }

    cache.save(entries);
    return { pulled, pushed, conflicts: 0 };
  }
}

const stripRefs = (entry: CacheEntry): Task => {
  const { refs: _refs, ...task } = entry;
  return task;
};

/** The production service: committed cache plus the project's configured provider (GitHub by default). */
export function makeService(): TaskService {
  return new CachedTaskService();
}
