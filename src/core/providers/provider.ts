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

import type { ProjectContext, Task } from "../types.ts";
import { ConfigProvider, type ServerOptions } from "../config.ts";
import { FileProvider } from "./file.ts";
import { GitHubProvider } from "./github.ts";

/** What a layer reports for one task on `pull`. */
export interface ProviderState {
  /** The full task as this layer records it. */
  task: Task;
  /** The layer's own sides disagree (or an item needs adopting): push the merged task back to it. */
  reconcile?: boolean;
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
}

// Registered remote layers. Adding Linear is one entry here plus its class — nothing else moves.
const REMOTES: Record<string, (config: ConfigProvider) => Provider> = {
  github: (config) => new GitHubProvider(config),
};

// One stack per remote name — layers cache their per-project init (repo, board, index), so handing out
// fresh instances would redo that remote work on every service call.
const stacks = new Map<string, Provider[]>();

/**
 * The project's provider stack, top-first: the file layer, then the configured remote (default
 * "github"). Order is authority order — the LAST layer is the source of truth. Every remote layer
 * shares the one ConfigProvider, so a preference set centrally propagates to all of them.
 */
export function stackFor(
  project: string,
  options: ServerOptions = {},
  config: ConfigProvider = new ConfigProvider(options),
): Provider[] {
  const name = config.get(project).provider ?? "github";
  const make = REMOTES[name];
  if (!make)
    throw new Error(`unknown provider '${name}' (known: ${Object.keys(REMOTES).join(", ")})`);
  let stack = stacks.get(name);
  if (!stack) {
    stack = [new FileProvider(options), make(config)];
    stacks.set(name, stack);
  }
  return stack;
}
