// The task service — the stack orchestrator. It sequences the provider layers and knows nothing of
// their implementations: reads hit only the top (file) layer, writes fan down through every layer in
// order, and `sync` pulls every layer, merges with the DEEPEST LAYER WINNING, then pushes the merged
// truth back into each layer that lacks it or disagrees. Absence is never a claim (a missing task is
// pushed, not deleted) and deletions never propagate — a task closes everywhere but only vanishes by
// hand. Layer errors bubble; there is no fallback to decide at this altitude.

import { isDeepStrictEqual } from "node:util";
import type { ProjectConfig, ProjectContext, Task, TaskPatch, TrailEntry } from "./types.ts";
import type { Provider, ProviderState } from "./providers/provider.ts";
import type { ServerOptions } from "./types.ts";
import { ConfigProvider, defaultCacheDir, type ConfigSources } from "./providers/config.ts";
import { buildStack, resolveRemotes } from "./providers/provider.ts";
import {
  assertTargetFields,
  assertTargetWhy,
  idList,
  isTarget,
  specSettled,
  tasksOf,
  touchesTargetShape,
  withDefaults,
} from "./graph.ts";
import { ClaimStore, DEFAULT_STALE_MINUTES, type StaleClaim } from "./claims.ts";
import { ChangeBus } from "./changes.ts";
import { readProjectSummaries, type ProjectSummary } from "./projects.ts";

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
  /** Change a task. Only the fields the patch carries move; a field set to `null` is REMOVED. */
  update(ctx: ProjectContext, id: string, patch: TaskPatch): Promise<Task>;
  close(ctx: ProjectContext, id: string): Promise<void>;
  /** Mark a task in progress — a worker picking it up. It leaves `ready`, so nothing dispatches it
   *  twice; closing or replanning clears it again. */
  start(ctx: ProjectContext, id: string): Promise<Task>;
  /** Permanently remove a task from every layer (deepest-first). Explicit — not sync's absence rule. */
  delete(ctx: ProjectContext, id: string): Promise<void>;
  sync(ctx: ProjectContext): Promise<SyncResult>;
  /** Reconcile every project this service has served so far, one at a time; a project's own failure
   *  is logged and skipped, never thrown. This is what the background loop drives. */
  syncSeen(): Promise<Map<string, SyncResult>>;
  /** The claims nobody has refreshed inside the threshold — a crashed worker still holding work.
   *  Reported, never released: a claim released under a worker that is merely slow lets a second
   *  worker take the same task. */
  staleClaims(ctx: ProjectContext): Promise<StaleClaim[]>;
  /** A task's trail: the append-only journal of decisions and actions behind it. */
  getTrail(ctx: ProjectContext, id: string): Promise<TrailEntry[]>;
  /** Append one entry to a task's trail; returns the whole trail. Refuses an unknown task. */
  appendTrail(ctx: ProjectContext, id: string, entry: TrailEntry): Promise<TrailEntry[]>;
  /** Every layer of the configuration for this project, plus the effective result. */
  getConfig(ctx: ProjectContext): Promise<ConfigSources>;
  /** Every project the file layer's cache directory holds, with task counts by status — the one read
   *  that answers about the server itself, not one project. Local only: no provider, no network. */
  listProjects(): Promise<ProjectSummary[]>;
  /** The in-process change bus a long-running transport subscribes to, so an idle reader learns a
   *  project moved. The service emits on it for its own writes; other processes' writes reach it
   *  through the transport's file watcher. */
  changes(): ChangeBus;
  /** Where the file layer keeps its task caches — what a transport watches for other processes'
   *  writes, and what `listProjects` walks. */
  cacheDir(): string;
  /** Release any per-project resources. Nothing holds the process open today, so this is a no-op an
   *  embedder may still call; it stays on the interface so a future layer that does hold one has a
   *  place to release it. */
  stop(): void;
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
  // One stack per resolved provider LIST (keyed by the ordered names) — layers cache their per-project
  // init (repo, board, index), so handing out fresh instances would redo that remote work on every
  // call, and keying by the whole list keeps two projects with different provider sets apart.
  private readonly stacks = new Map<string, Provider[]>();
  // Every project this service has been asked about — the set the background loop reconciles. The
  // server has no cwd of its own, so a project is only knowable once a tool call names it.
  private readonly seen = new Set<string>();
  // One claim ledger per project served, keyed on the project id like every other store — worktrees
  // sharing one supplied id write one ledger, with no git resolution behind it.
  private readonly claimStores = new Map<string, ClaimStore>();
  // The change bus for this service's own writes. Emitting on a bus with no subscribers is a no-op,
  // so a stdio server (no /events reader) carries it for free.
  private readonly bus = new ChangeBus();

  constructor(
    private readonly options: ServerOptions = {},
    private readonly providers?: Provider[],
    private readonly config: ConfigProvider = new ConfigProvider(options),
  ) {}

  cacheDir(): string {
    return this.options.cacheDir ?? defaultCacheDir();
  }

  changes(): ChangeBus {
    return this.bus;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return readProjectSummaries(this.cacheDir());
  }

  private layers(ctx: ProjectContext): Provider[] {
    this.seen.add(ctx.project);
    if (this.providers) return this.providers;
    const remotes = resolveRemotes(this.config.get(ctx.project));
    const key = remotes.join(" ");
    let stack = this.stacks.get(key);
    if (!stack) {
      stack = buildStack(remotes, this.options, this.config);
      this.stacks.set(key, stack);
    }
    return stack;
  }

  stop(): void {}

  /** This project's claim ledger, made once and reused — one store per id, keyed like every other
   *  store, so worktrees sharing an id share the ledger. */
  private claims(project: string): ClaimStore {
    let store = this.claimStores.get(project);
    if (!store) {
      store = new ClaimStore(this.cacheDir(), project);
      this.claimStores.set(project, store);
    }
    return store;
  }

  async staleClaims(ctx: ProjectContext): Promise<StaleClaim[]> {
    const minutes = this.config.get(ctx.project).claimStaleMinutes ?? DEFAULT_STALE_MINUTES;
    return this.claims(ctx.project).stale(minutes);
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
    const known = await (await this.top(ctx)).pull(ctx);
    if (known.has(task.id)) throw new DuplicateTaskError(task.id);
    assertTarget(known, task);
    assertDepsInTarget(known, task);
    assertTargetFields(task);
    assertTargetWhy(task); // a target exists only once someone has written down why
    await this.fanDown(ctx, task);
    this.bus.emit(ctx.project); // the local cache changed — wake any idle reader
    return task;
  }

  async update(ctx: ProjectContext, id: string, patch: TaskPatch): Promise<Task> {
    const known = await (await this.top(ctx)).pull(ctx);
    const current = known.get(id)?.task;
    if (!current) throw new Error(`no task ${id}`);
    const merged = released(current, withDefaults(applyPatch(current, patch)));
    assertEdit(known, merged, patch);
    await this.fanDown(ctx, merged);
    this.trackClaim(ctx, merged);
    this.bus.emit(ctx.project); // the local cache changed — wake any idle reader
    return merged;
  }

  /**
   * Keep the claim ledger in step with the task's status. Every path that starts, closes, replans or
   * reopens a task runs through `update`, so this one call covers all of them: a task in progress is
   * claimed (or its heartbeat moved), and a task in any other state holds no claim.
   */
  private trackClaim(ctx: ProjectContext, task: Task): void {
    const claims = this.claims(ctx.project);
    if (task.status === "in_progress") claims.mark(task.id);
    else claims.release(task.id);
  }

  async close(ctx: ProjectContext, id: string): Promise<void> {
    await this.update(ctx, id, { status: "done" });
  }

  async start(ctx: ProjectContext, id: string): Promise<Task> {
    return this.update(ctx, id, { status: "in_progress" });
  }

  /** Delete a task everywhere. Deepest-first, so a remote that refuses (e.g. no delete-issue
   *  permission) throws before the local cache is touched — no half-deleted state to sync back. */
  async delete(ctx: ProjectContext, id: string): Promise<void> {
    const held = tasksOf(await this.list(ctx), id);
    if (held.length > 0) {
      throw new Error(`target ${id} still holds ${idList(held)} — retarget or delete those first`);
    }
    const layers = await this.all(ctx);
    for (const layer of [...layers].reverse()) {
      if (layer.delete) await layer.delete(ctx, id);
    }
    this.bus.emit(ctx.project); // the local cache changed — wake any idle reader
  }

  async getTrail(ctx: ProjectContext, id: string): Promise<TrailEntry[]> {
    return (await this.trailLayer(ctx)).getTrail!(ctx, id);
  }

  /** Append to the trail, and take the write as a heartbeat. A build writes one note per layer, so
   *  the liveness signal costs nothing extra and cannot be forgotten by a worker that is working. */
  async appendTrail(ctx: ProjectContext, id: string, entry: TrailEntry): Promise<TrailEntry[]> {
    const trail = await (await this.trailLayer(ctx)).appendTrail!(ctx, id, entry);
    this.claims(ctx.project).touch(id);
    return trail;
  }

  /** The DEEPEST layer that backs trails, chosen explicitly by walking the stack bottom-up: with
   *  several remotes the deepest implementing one owns the thread (GitHub backs comments; the file
   *  cache does not). */
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
    // Emit only when the sync changed the LOCAL cache (a pull brought in or corrected a task) — a
    // console reads the top layer, so a push to a deeper layer alone is nothing for it to re-read.
    if (topChanged(pulls[0][1], merged)) this.bus.emit(ctx.project);
    return { pulled: merged.size, pushed, conflicts: conflictCount(pulls) };
  }

  async syncSeen(): Promise<Map<string, SyncResult>> {
    const out = new Map<string, SyncResult>();
    for (const project of this.seen) {
      out.set(project, await this.syncQuietly(project));
    }
    return out;
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
      const need = [...merged.values()]
        .filter((task) => needsPush(states.get(task.id), task))
        .sort(targetsFirst);
      if (need.length === 0) continue;
      await pushAll(layer, ctx, need);
      if (layer !== top) pushed += need.length;
    }
    return pushed;
  }
}

/**
 * Targets ahead of the tasks that name them. A layer that stores membership as a parent link — the
 * GitHub sub-issue edge — needs the target's own issue to exist before a child can point at it, so a
 * first sync that pushes both must push the targets first. Sort is stable, so nothing else moves.
 */
const targetsFirst = (a: Task, b: Task): number => Number(isTarget(b)) - Number(isTarget(a));

/**
 * A task may only name a target the stack actually holds. A typo would file work under a roadmap row
 * nobody can find and the sub-issue edge would silently never land. This guards the AUTHORING surface
 * (add_task / edit_task) only — `sync` stays tolerant, because it records what GitHub already says.
 */
function assertTarget(known: Map<string, ProviderState>, task: Task): void {
  if (!task.target) return;
  if (task.target === task.id) throw new Error(`task ${task.id} cannot target itself`);
  const target = known.get(task.target)?.task;
  if (!target) throw new Error(`no target ${task.target}`);
  if (!isTarget(target)) throw new Error(`${task.target} is a task, not a target`);
}

/**
 * A target is self-contained: its tasks depend on each other and on nothing outside it. That is what
 * lets a dispatcher take one target and ship its whole set as a single stack — a dep reaching out
 * would stall the stack on work no one in it can do. Sequencing BETWEEN targets is the target's own
 * `deps`, one altitude up.
 *
 * Like `assertTarget`, this guards the AUTHORING surface only. `sync` stays tolerant, because it
 * records what GitHub already says, and a dep whose task this stack has never seen is left alone:
 * nothing here can tell which target it belongs to.
 */
function assertDepsInTarget(known: Map<string, ProviderState>, task: Task): void {
  if (!task.target || isTarget(task)) return;
  const stray = strayDep(known, task);
  if (stray) throw new Error(`task ${task.id} (target ${task.target}) ${stray}`);
}

/** The first dep that leaves this task's target, worded as the rest of the error. */
function strayDep(known: Map<string, ProviderState>, task: Task): string | null {
  for (const dep of task.deps) {
    const other = known.get(dep)?.task;
    if (!other) continue;
    if (isTarget(other)) {
      return `depends on target ${dep} — put that sequencing in the target's own deps`;
    }
    if (other.target !== task.target) {
      return (
        `depends on ${dep} (target ${other.target ?? "none"}) — a target is self-contained, ` +
        `so split the target or move the task`
      );
    }
  }
  return null;
}

/**
 * The authoring guards an EDIT runs. Each fires only when the patch touches what it guards, because
 * re-validating an untouched graph would refuse honest edits: closing a task whose roadmap row
 * someone deleted, or one whose cross-target dep predates the self-contained rule.
 */
function assertEdit(known: Map<string, ProviderState>, merged: Task, patch: TaskPatch): void {
  if (patch.target) assertTarget(known, merged);
  if (patch.deps || patch.target) assertDepsInTarget(known, merged);
  if (touchesTargetShape(patch)) assertTargetFields(merged);
  // The WHY is asked of a target when it is CREATED or PROMOTED, never on a later edit — a row
  // filed before the rule existed still has to be closeable.
  if (patch.type === "target") assertTargetWhy(merged);
}

/**
 * Apply a patch to a task. An absent key leaves the field alone; a key set to `null` DELETES it, which
 * is the only way a `field:value` label comes off an issue — the merge that a plain spread does can
 * add and overwrite, never remove. `id` is the stable key and never moves.
 */
function applyPatch(current: Task, patch: TaskPatch): Task {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return { ...next, id: current.id } as Task;
}

/**
 * The two edits that hand a claimed item back.
 *
 * A task sent back for replanning is not being worked any more. And a planning session claims the item
 * it is specifying, so SETTLING that item hands it on to whoever builds it. Without either release the
 * item stays marked in progress and reaches no queue at all: `ready` wants an open task, `planning`
 * wants an unsettled one, and it waits for a human to notice.
 *
 * ⚠ The settle release keys off the TRANSITION, never the state. A build's own task is settled AND in
 * progress for its whole run, so releasing on that state would put a second worker on live work.
 */
function released(current: Task, next: Task): Task {
  if (next.status !== "in_progress") return next;
  if (next.spec === "replan") return { ...next, status: "open" };
  if (specSettled(next) && !specSettled(current)) return { ...next, status: "open" };
  return next;
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

/** Whether the sync changed the top (cache) layer — any merged task the top layer lacked or disagreed
 *  with. This is what a local reader would see change, so it is what wakes an idle console. */
function topChanged(top: Map<string, ProviderState>, merged: Map<string, Task>): boolean {
  for (const task of merged.values()) {
    if (needsPush(top.get(task.id), task)) return true;
  }
  return false;
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

/** The production service: the file layer on top, the project's configured remotes beneath it, deepest
 *  last. */
export function makeService(options: ServerOptions = {}): TaskService {
  return new TaskStack(options);
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
