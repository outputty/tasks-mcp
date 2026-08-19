// The task service — the stack orchestrator. It sequences the provider layers and knows nothing of
// their implementations: reads hit only the top (file) layer, writes fan down through every layer in
// order, and `sync` pulls every layer, merges with the DEEPEST LAYER WINNING, then pushes the merged
// truth back into each layer that lacks it or disagrees. Absence is never a claim (a missing task is
// pushed, not deleted) and deletions never propagate — a task closes everywhere but only vanishes by
// hand. Layer errors bubble; there is no fallback to decide at this altitude.

import { isDeepStrictEqual } from "node:util";
import type { ProjectConfig, ProjectContext, Task, TrailEntry } from "./types.ts";
import type { Provider, ProviderState } from "./providers/provider.ts";
import type { ServerOptions } from "./types.ts";
import { ConfigProvider, defaultCacheDir, type ConfigSources } from "./providers/config.ts";
import { buildStack } from "./providers/provider.ts";
import { eligible, withDefaults } from "./graph.ts";
import { Doorbell, drainEvents, postEvent } from "./channel.ts";

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
}

/** Creating a task whose id the stack already holds. Typed so tests assert the type, not a message. */
export class DuplicateTaskError extends Error {
  constructor(id: string) {
    super(`task ${id} already exists`);
    this.name = "DuplicateTaskError";
  }
}

export interface TaskService {
  list(ctx: ProjectContext): Promise<Task[]>;
  get(ctx: ProjectContext, id: string): Promise<Task | null>;
  create(ctx: ProjectContext, task: Task): Promise<Task>;
  update(ctx: ProjectContext, id: string, patch: Partial<Task>): Promise<Task>;
  close(ctx: ProjectContext, id: string): Promise<void>;
  /** Permanently remove a task from every layer (deepest-first). Explicit — not sync's absence rule. */
  delete(ctx: ProjectContext, id: string): Promise<void>;
  sync(ctx: ProjectContext): Promise<SyncResult>;
  /** Reconcile every project this service has served so far, one at a time; a project's own failure
   *  is logged and skipped, never thrown. This is what the background loop drives. */
  syncSeen(): Promise<Map<string, SyncResult>>;
  /** A task's trail: the append-only journal of decisions and actions behind it. */
  getTrail(ctx: ProjectContext, id: string): Promise<TrailEntry[]>;
  /** Append one entry to a task's trail; returns the whole trail. Refuses an unknown task. */
  appendTrail(ctx: ProjectContext, id: string, entry: TrailEntry): Promise<TrailEntry[]>;
  /** Every layer of the configuration for this project, plus the effective result. */
  getConfig(ctx: ProjectContext): Promise<ConfigSources>;
  /** Ring the doorbell from anywhere, with a one-line reason. */
  notify(ctx: ProjectContext, note: string): Promise<void>;
  /** Write preferences centrally: into the global spec, or one repo's override. */
  setConfig(
    ctx: ProjectContext,
    scope: "global" | "repo",
    patch: ProjectConfig,
  ): Promise<ProjectConfig>;
}

export class TaskStack implements TaskService {
  // `options` carries the CLI-set knobs (cacheDir, provider, board…). A whole stack may be injected
  // for tests — ordered top-first, deepest layer last and most authoritative.
  // One stack per remote name — layers cache their per-project init (repo, board, index), so handing
  // out fresh instances would redo that remote work on every call.
  private readonly stacks = new Map<string, Provider[]>();
  // Every project this service has been asked about — the set the background loop reconciles. The
  // server has no cwd of its own, so a project is only knowable once a tool call names it.
  private readonly seen = new Set<string>();
  // The ids that could be started, as of the last poll — the only state the doorbell needs to tell a
  // real change from a sync pass that moved nothing.
  private readonly lastEligible = new Map<string, string>();

  constructor(
    private readonly options: ServerOptions = {},
    private readonly providers?: Provider[],
    private readonly config: ConfigProvider = new ConfigProvider(options),
    private readonly doorbell: Doorbell = new Doorbell(),
  ) {}

  private cacheDir(): string {
    return this.options.cacheDir ?? defaultCacheDir();
  }

  private layers(ctx: ProjectContext): Provider[] {
    this.seen.add(ctx.project);
    if (this.providers) return this.providers;
    const remote = this.config.get(ctx.project).provider ?? "github";
    let stack = this.stacks.get(remote);
    if (!stack) {
      stack = buildStack(remote, this.options, this.config);
      this.stacks.set(remote, stack);
    }
    return stack;
  }

  async getConfig(ctx: ProjectContext): Promise<ConfigSources> {
    return this.config.sources(ctx.project);
  }

  async setConfig(
    ctx: ProjectContext,
    scope: "global" | "repo",
    patch: ProjectConfig,
  ): Promise<ProjectConfig> {
    return this.config.set(ctx.project, scope, patch);
  }

  /** The top layer alone, initialised — reads stay local and never touch a remote. */
  private async top(ctx: ProjectContext): Promise<Provider> {
    const top = this.layers(ctx)[0];
    await top.init(ctx);
    return top;
  }

  /** Every layer, initialised, top-first. */
  private async all(ctx: ProjectContext): Promise<Provider[]> {
    const layers = this.layers(ctx);
    for (const layer of layers) await layer.init(ctx);
    return layers;
  }

  async list(ctx: ProjectContext): Promise<Task[]> {
    const states = await (await this.top(ctx)).pull(ctx);
    return [...states.values()].map((s) => s.task);
  }

  async get(ctx: ProjectContext, id: string): Promise<Task | null> {
    const states = await (await this.top(ctx)).pull(ctx);
    return states.get(id)?.task ?? null;
  }

  async create(ctx: ProjectContext, task: Task): Promise<Task> {
    const top = await this.top(ctx);
    if ((await top.pull(ctx)).has(task.id)) throw new DuplicateTaskError(task.id);
    await this.fanDown(ctx, task);
    return task;
  }

  async update(ctx: ProjectContext, id: string, patch: Partial<Task>): Promise<Task> {
    const current = await this.get(ctx, id);
    if (!current) throw new Error(`no task ${id}`);
    const merged = withDefaults({ ...current, ...patch, id });
    await this.fanDown(ctx, merged);
    return merged;
  }

  async close(ctx: ProjectContext, id: string): Promise<void> {
    await this.update(ctx, id, { status: "done" });
  }

  /** Delete a task everywhere. Deepest-first, so a remote that refuses (e.g. no delete-issue
   *  permission) throws before the local cache is touched — no half-deleted state to sync back. */
  async delete(ctx: ProjectContext, id: string): Promise<void> {
    const layers = await this.all(ctx);
    for (const layer of [...layers].reverse()) {
      if (layer.delete) await layer.delete(ctx, id);
    }
  }

  /** Ring here AND post for every OTHER process watching this repo — a worker session and the
   *  orchestrator never share one, so a note raised in either has to travel to the other. */
  async notify(ctx: ProjectContext, note: string): Promise<void> {
    this.doorbell.ring(note);
    postEvent(this.cacheDir(), ctx.project, note);
  }

  async getTrail(ctx: ProjectContext, id: string): Promise<TrailEntry[]> {
    return (await this.trailLayer(ctx)).getTrail!(ctx, id);
  }

  async appendTrail(ctx: ProjectContext, id: string, entry: TrailEntry): Promise<TrailEntry[]> {
    return (await this.trailLayer(ctx)).appendTrail!(ctx, id, entry);
  }

  /** The deepest layer that backs trails (GitHub owns the issue comments; the file cache has none). */
  private async trailLayer(ctx: ProjectContext): Promise<Provider> {
    const layers = this.layers(ctx);
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.getTrail && layer.appendTrail) {
        await layer.init(ctx);
        return layer;
      }
    }
    throw new Error("trails need a GitHub-backed project — no provider here backs them");
  }

  async sync(ctx: ProjectContext): Promise<SyncResult> {
    const layers = await this.all(ctx);
    // Layers only read their own store on pull, so the pulls run concurrently; array order (and with
    // it deepest-wins precedence) is preserved by Promise.all.
    const pulls = await Promise.all(
      layers.map(
        async (layer) => [layer, await layer.pull(ctx)] as [Provider, Map<string, ProviderState>],
      ),
    );
    const merged = mergeStack(pulls);
    const pushed = await this.reconcile(ctx, layers[0], pulls, merged);
    return { pulled: merged.size, pushed, conflicts: conflictCount(pulls) };
  }

  async syncSeen(): Promise<Map<string, SyncResult>> {
    const out = new Map<string, SyncResult>();
    for (const project of this.seen) {
      out.set(project, await this.syncQuietly(project));
      await this.poll(project);
    }
    return out;
  }

  /**
   * After one project's sync: deliver anything another process spooled, then ring if the set of
   * startable tasks actually moved. A sync that changed nothing must not wake the session.
   */
  private async poll(project: string): Promise<void> {
    for (const note of drainEvents(this.cacheDir(), project)) this.doorbell.ring(note);
    const signature = eligible(await this.list({ project }))
      .map((e) => e.task.id)
      .join(",");
    const previous = this.lastEligible.get(project);
    this.lastEligible.set(project, signature);
    if (previous === signature) return;
    if (previous === undefined && signature === "") return; // nothing to wake about at startup
    this.doorbell.ring();
  }

  /** One project's sync for the background loop: an error is logged to stderr and swallowed, so one
   *  project's failure never stops the sweep or kills the loop. Best-effort, like the board sync. */
  private async syncQuietly(project: string): Promise<SyncResult> {
    try {
      return await this.sync({ project });
    } catch (err) {
      console.error(`[tasks-mcp] background sync failed for ${project}:`, err);
      return { pulled: 0, pushed: 0, conflicts: 0 };
    }
  }

  /** Write one task through every layer, top to bottom. */
  private async fanDown(ctx: ProjectContext, task: Task): Promise<void> {
    for (const layer of await this.all(ctx)) await layer.upsert(ctx, task);
  }

  /** Push the merged truth into each layer that lacks a task, flagged it, or disagrees with it. */
  private async reconcile(
    ctx: ProjectContext,
    top: Provider,
    pulls: Array<[Provider, Map<string, ProviderState>]>,
    merged: Map<string, Task>,
  ): Promise<number> {
    let pushed = 0;
    for (const [layer, states] of pulls) {
      const need = [...merged.values()].filter((task) => needsPush(states.get(task.id), task));
      if (need.length === 0) continue;
      await pushAll(layer, ctx, need);
      if (layer !== top) pushed += need.length;
    }
    return pushed;
  }
}

/** One layer's batch of pushes: the batch method when the layer has one, else task by task. */
async function pushAll(layer: Provider, ctx: ProjectContext, tasks: Task[]): Promise<void> {
  if (layer.upsertMany) return layer.upsertMany(ctx, tasks);
  for (const task of tasks) await layer.upsert(ctx, task);
}

/** Deepest wins: apply every layer's pull in stack order, so the last layer's version of a task lands
 *  on top. Absence is not a claim — an id a layer lacks simply doesn't overwrite anything. */
function mergeStack(pulls: Array<[Provider, Map<string, ProviderState>]>): Map<string, Task> {
  const merged = new Map<string, Task>();
  for (const [, states] of pulls) {
    for (const [id, state] of states) merged.set(id, withDefaults(state.task));
  }
  return merged;
}

/** Task ids any layer flagged as conflicted (duplicate remote items claiming one id). */
function conflictCount(pulls: Array<[Provider, Map<string, ProviderState>]>): number {
  const ids = new Set<string>();
  for (const [, states] of pulls) {
    for (const [id, state] of states) if (state.conflict) ids.add(id);
  }
  return ids.size;
}

/** A layer needs the merged task pushed when it lacks it, flagged it reconcile, or disagrees. */
function needsPush(state: ProviderState | undefined, merged: Task): boolean {
  if (!state) return true;
  if (state.reconcile) return true;
  return !sameTask(state.task, merged);
}

/** Structural equality over normalized tasks, key order ignored (node:util; Bun implements it). */
function sameTask(a: Task, b: Task): boolean {
  return isDeepStrictEqual(withDefaults(a), withDefaults(b));
}

/** The production service: the file layer on top, the project's configured remote beneath it. The
 *  doorbell is passed in by whatever can deliver a ring — the stdio entry wires it to the channel. */
export function makeService(options: ServerOptions = {}, doorbell?: Doorbell): TaskService {
  return new TaskStack(options, undefined, undefined, doorbell);
}

/**
 * Start the background sync loop: every `seconds`, reconcile every project the server has served.
 * It re-arms only after each pass completes, so a slow sync never overlaps the next, and the timer is
 * unref'd so it never keeps the process alive on its own. Returns a stop function. `seconds` must be
 * > 0 — the caller gates on the flag. E.g. `startBackgroundSync(svc, 60)` syncs every minute.
 */
export function startBackgroundSync(service: TaskService, seconds: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = (): void => {
    timer = setTimeout(() => {
      void service.syncSeen().finally(() => {
        if (!stopped) loop();
      });
    }, seconds * 1000);
    timer.unref?.();
  };
  loop();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
