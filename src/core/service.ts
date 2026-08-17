// The task service: the local cache is the working store, the provider is the mirror. Reads come straight
// from the cache (fast). Writes update the cache first, then reflect the representable fields into the
// provider. `sync` reconciles both ways and can rebuild a fresh cache entirely from the provider, since
// each task's full record (deps included) is mirrored into its issue body.

import type { CacheEntry, ProjectContext, Task } from "./types.ts";
import type { Provider } from "./providers/provider.ts";
import type { ServerOptions } from "./config.ts";
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
  // `options` carries the CLI-set knobs (cacheDir, provider, board…). A provider may be injected for tests.
  constructor(
    private readonly options: ServerOptions = {},
    private readonly provider?: Provider,
  ) {}

  private cache(project: string): Cache {
    return Cache.forProject(project, this.options.cacheDir);
  }

  /** The project's provider, initialised — repo, credentials, and board are resolved before any op. */
  private async providerFor(ctx: ProjectContext): Promise<Provider> {
    const provider = this.provider ?? providerFor(ctx.project, this.options);
    await provider.init(ctx);
    return provider;
  }

  async list(ctx: ProjectContext): Promise<Task[]> {
    return this.cache(ctx.project).load();
  }

  async get(ctx: ProjectContext, id: string): Promise<Task | null> {
    return (
      this.cache(ctx.project)
        .load()
        .find((t) => t.id === id) ?? null
    );
  }

  async create(ctx: ProjectContext, task: Task): Promise<Task> {
    const cache = this.cache(ctx.project);
    const entries = cache.load();
    if (entries.some((e) => e.id === task.id))
      throw new Error(`task ${task.id} already exists`);
    const refs = await (await this.providerFor(ctx)).create(ctx, task);
    entries.push({ ...task, refs });
    cache.save(entries);
    return task;
  }

  async update(
    ctx: ProjectContext,
    id: string,
    patch: Partial<Task>,
  ): Promise<Task> {
    const cache = this.cache(ctx.project);
    const entries = cache.load();
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error(`no task ${id}`);
    const merged: CacheEntry = { ...entry, ...patch, id };
    merged.refs = await (
      await this.providerFor(ctx)
    ).update(ctx, stripRefs(merged), entry.refs ?? {});
    entries[entries.indexOf(entry)] = merged;
    cache.save(entries);
    return stripRefs(merged);
  }

  async close(ctx: ProjectContext, id: string): Promise<void> {
    await this.update(ctx, id, { status: "done" });
  }

  async sync(ctx: ProjectContext): Promise<SyncResult> {
    const cache = this.cache(ctx.project);
    const entries = cache.load();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const provider = await this.providerFor(ctx);

    // Pull the fields the provider owns (title, status) back into the cache, adopting any issue it
    // surfaces that the cache did not know (a hand-opened one), and learning each task's refs.
    const remote = await provider.pull(ctx);
    const reconcile: CacheEntry[] = [];
    let pulled = 0;
    for (const [id, state] of remote) {
      let entry = byId.get(id);
      if (!entry) {
        entry = withDefaults({ id, ...state.patch });
        byId.set(id, entry);
        entries.push(entry);
      } else {
        Object.assign(entry, state.patch);
      }
      entry.refs = { ...entry.refs, ...state.refs };
      if (state.reconcile) reconcile.push(entry);
      pulled++;
    }

    let pushed = 0;
    // Push cache tasks the provider has never seen (created offline), so the mirror catches up.
    for (const entry of entries) {
      if (remote.has(entry.id)) continue;
      entry.refs = await provider.create(ctx, stripRefs(entry));
      pushed++;
    }
    // Push back the disagreeing ones: close/reopen the issue to match, stamp an adopted issue's body
    // block, and set its board card — so issue, cache, and board converge.
    for (const entry of reconcile) {
      entry.refs = await provider.update(
        ctx,
        stripRefs(entry),
        entry.refs ?? {},
      );
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

/** The production service: local cache plus the project's configured provider (GitHub by default). */
export function makeService(options: ServerOptions = {}): TaskService {
  return new CachedTaskService(options);
}
