// The task service — the stack orchestrator. It sequences the provider layers and knows nothing of
// their implementations: reads hit only the top (file) layer, writes fan down through every layer in
// order, and `sync` pulls every layer, merges with the DEEPEST LAYER WINNING, then pushes the merged
// truth back into each layer that lacks it or disagrees. Absence is never a claim (a missing task is
// pushed, not deleted) and deletions never propagate — a task closes everywhere but only vanishes by
// hand. Layer errors bubble; there is no fallback to decide at this altitude.

import { isDeepStrictEqual } from "node:util";
import type { ProjectConfig, ProjectContext, Task } from "./types.ts";
import type { Provider, ProviderState } from "./providers/provider.ts";
import type { ServerOptions } from "./types.ts";
import { ConfigProvider, type ConfigSources } from "./providers/config.ts";
import { buildStack } from "./providers/provider.ts";
import { withDefaults } from "./graph.ts";

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
  sync(ctx: ProjectContext): Promise<SyncResult>;
  /** Every layer of the configuration for this project, plus the effective result. */
  getConfig(ctx: ProjectContext): Promise<ConfigSources>;
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

  constructor(
    private readonly options: ServerOptions = {},
    private readonly providers?: Provider[],
    private readonly config: ConfigProvider = new ConfigProvider(options),
  ) {}

  private layers(ctx: ProjectContext): Provider[] {
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

/** The production service: the file layer on top, the project's configured remote beneath it. */
export function makeService(options: ServerOptions = {}): TaskService {
  return new TaskStack(options);
}
