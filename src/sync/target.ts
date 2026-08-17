// A sync target reflects the cache's tasks into an external system and reports back the fields that
// system owns. It never sees the dependency graph — deps live only in the committed cache, because a
// target like Issues cannot represent them. Each target does two things:
//
//   push  — make the target match one task (create/update), returning any refs to remember
//   pull  — read the target's representable fields (e.g. issue open/closed), keyed by task id
//
// The service owns the graph and the order; a target owns one external API.

import type { ProjectContext, Refs, Task } from "../types.ts";
import type { Env } from "../config.ts";

export interface SyncTarget {
  readonly name: string;
  /** Whether this target runs for the given project (e.g. Projects can be switched off). */
  enabled(env: Env): boolean;
  /** Reflect one task into the target. Returns refs to merge into the cache entry. */
  push(env: Env, ctx: ProjectContext, task: Task, refs: Refs): Promise<Refs>;
  /** The representable-field state coming FROM the target, keyed by task id. */
  pull(env: Env, ctx: ProjectContext): Promise<Map<string, Partial<Task>>>;
}
