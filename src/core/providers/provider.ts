// The provider seam — the plug-and-play point. A provider is one LAYER in the stack: the file layer on
// top (the fast local store every read hits), remotes below it (GitHub today, Linear tomorrow), deepest
// layer most authoritative. Each layer owns its own bookkeeping — how a task maps to its issue, card, or
// row is the layer's private concern; nothing above the seam ever sees a provider-specific handle.
//
// Stack semantics (the rules the service enforces, settled 2026-08-17):
//   - DEEPEST WINS: on a sync disagreement, the deeper layer's version of a task is the truth.
//   - ABSENCE IS NOT A CLAIM: a task missing from a layer is pushed into it, never deleted from others —
//     an empty, newly added layer backfills instead of erasing the world.
//   - DELETIONS NEVER PROPAGATE: a task can close everywhere, but only vanishes by hand.

import type { ProjectContext, Task, TrailEntry } from "../types.ts";
import type { ServerOptions } from "../types.ts";
import { ConfigProvider } from "./config.ts";
import { FileProvider } from "./file.ts";
import { GitHubProvider } from "./github.ts";

/** What a layer reports for one task on `pull`. */
export interface ProviderState {
  /** The full task as this layer records it. */
  task: Task;
  /** The layer's own sides disagree (or an item needs adopting): push the merged task back to it. */
  reconcile?: boolean;
  /** More than one remote item claims this task id — the layer resolved to the OLDEST one and the
   *  newer duplicates are shadowed. Counted into SyncResult.conflicts; repair is a human call. */
  conflict?: boolean;
}

export interface Provider {
  readonly name: string;
  /**
   * Resolve everything the layer needs for this project — credentials, remote coordinates, any
   * container to sync into (for GitHub: the Projects v2 board, found or created), and its own
   * task-to-item index. Called by the service before operations that touch the layer; idempotent,
   * one real run per project.
   */
  init(ctx: ProjectContext): Promise<void>;
  /** Every task this layer holds, keyed by task id. */
  pull(ctx: ProjectContext): Promise<Map<string, ProviderState>>;
  /** Create-or-update one task; the layer resolves its own handles (issue number, card id, …). */
  upsert(ctx: ProjectContext, task: Task): Promise<void>;
  /** Optional batch form of `upsert` — a layer with cheap batching (one file write) implements it. */
  upsertMany?(ctx: ProjectContext, tasks: Task[]): Promise<void>;
  /**
   * A task's trail: its issue comment thread, every comment an entry. Optional — a layer that has no
   * comment surface (the file cache) omits both, and the service routes trails to the deepest layer
   * that backs them (GitHub). `getTrail` returns [] for a task with no issue yet.
   */
  getTrail?(ctx: ProjectContext, id: string): Promise<TrailEntry[]>;
  /** Append one entry (post a comment) and return the whole trail. Errors if the task has no issue. */
  appendTrail?(ctx: ProjectContext, id: string, entry: TrailEntry): Promise<TrailEntry[]>;
  /**
   * Permanently remove one task from this layer. Optional and distinct from sync's "absence is not a
   * claim": this is an EXPLICIT, intentional delete. Missing from the layer already → a no-op. The
   * service fans a delete DEEPEST-FIRST, so a remote that refuses (e.g. no delete-issue permission)
   * aborts before the local cache is touched.
   */
  delete?(ctx: ProjectContext, id: string): Promise<void>;
}

// Registered remote layers. Adding Linear is one entry here plus its class — nothing else moves.
const REMOTES: Record<string, (config: ConfigProvider) => Provider> = {
  github: (config) => new GitHubProvider(config),
};

/**
 * Build the stack for one remote, top-first: the file layer, then the named remote. Order is
 * authority order — the LAST layer is the source of truth. A pure builder: the caller (TaskStack)
 * owns memoization, and every remote layer shares the one ConfigProvider, so a preference set
 * centrally propagates to all of them.
 */
export function buildStack(
  remote: string,
  options: ServerOptions,
  config: ConfigProvider,
): Provider[] {
  const make = REMOTES[remote];
  if (!make)
    throw new Error(`unknown provider '${remote}' (known: ${Object.keys(REMOTES).join(", ")})`);
  return [new FileProvider(options), make(config)];
}
