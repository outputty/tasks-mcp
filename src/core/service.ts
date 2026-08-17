// The task service — the stack orchestrator. It sequences the provider layers and knows nothing of
// their implementations: reads hit only the top (file) layer, writes fan down through every layer in
// order, and `sync` pulls every layer, merges with the DEEPEST LAYER WINNING, then pushes the merged
// truth back into each layer that lacks it or disagrees. Absence is never a claim (a missing task is
// pushed, not deleted) and deletions never propagate — a task closes everywhere but only vanishes by
// hand. Layer errors bubble; there is no fallback to decide at this altitude.

import type { ProjectConfig, ProjectContext, Task } from "./types.ts";
import type { Provider, ProviderState } from "./providers/provider.ts";
import { ConfigProvider, type ConfigSources, type ServerOptions } from "./config.ts";
import { stackFor } from "./providers/provider.ts";
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
  constructor(
    private readonly options: ServerOptions = {},
    private readonly providers?: Provider[],
    private readonly config: ConfigProvider = new ConfigProvider(options),
  ) {}

  private layers(ctx: ProjectContext): Provider[] {
    return this.providers ?? stackFor(ctx.project, this.options, this.config);
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
    const pulls: Array<[Provider, Map<string, ProviderState>]> = [];
    for (const layer of layers) pulls.push([layer, await layer.pull(ctx)]);
    const merged = mergeStack(pulls);
    const pushed = await this.reconcile(ctx, layers[0], pulls, merged);
    return { pulled: merged.size, pushed, conflicts: 0 };
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
      for (const [id, task] of merged) {
        if (!needsPush(states.get(id), task)) continue;
        await layer.upsert(ctx, task);
        if (layer !== top) pushed++;
      }
    }
    return pushed;
  }
}

/** Deepest wins: apply every layer's pull in stack order, so the last layer's version of a task lands
 *  on top. Absence is not a claim — an id a layer lacks simply doesn't overwrite anything. */
function mergeStack(pulls: Array<[Provider, Map<string, ProviderState>]>): Map<string, Task> {
  const merged = new Map<string, Task>();
  for (const [, states] of pulls) {
    for (const [id, state] of states) merged.set(id, withDefaults({ ...state.task }));
  }
  return merged;
}

/** A layer needs the merged task pushed when it lacks it, flagged it reconcile, or disagrees. */
function needsPush(state: ProviderState | undefined, merged: Task): boolean {
  if (!state) return true;
  if (state.reconcile) return true;
  return !sameTask(state.task, merged);
}

/** Structural equality over normalized tasks, key order ignored. */
function sameTask(a: Task, b: Task): boolean {
  return canonical(withDefaults(a)) === canonical(withDefaults(b));
}

const canonical = (value: unknown): string => JSON.stringify(sortKeys(value));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => [k, sortKeys(v)]);
  return Object.fromEntries(entries);
}

/** The production service: the file layer on top, the project's configured remote beneath it. */
export function makeService(options: ServerOptions = {}): TaskService {
  return new TaskStack(options);
}
