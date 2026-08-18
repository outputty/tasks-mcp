// The deepest layer in the stack tests: an in-memory Provider with seedable state, so tests can put a
// disagreement (or an absence) at the bottom of the stack and watch it win (or backfill). The GitHub
// layer keeps its own nock-backed e2e coverage — this mock exists to exercise STACK semantics, which
// need a third, fully controllable layer.

import type { Provider, ProviderState } from "../src/core/providers/provider.ts";
import type { ProjectContext, Task } from "../src/core/types.ts";

export class MockProvider implements Provider {
  readonly name = "mock";
  /** The layer's "remote": what it reports on pull, keyed by task id. */
  remote = new Map<string, { task: Task; reconcile?: boolean }>();
  /** Every upsert the service pushed into this layer, in order. */
  upserts: string[] = [];

  async init(_ctx: ProjectContext): Promise<void> {}

  async pull(_ctx: ProjectContext): Promise<Map<string, ProviderState>> {
    const out = new Map<string, ProviderState>();
    for (const [id, state] of this.remote)
      out.set(id, { task: { ...state.task }, reconcile: state.reconcile });
    return out;
  }

  async upsert(_ctx: ProjectContext, task: Task): Promise<void> {
    this.remote.set(task.id, { task: { ...task } });
    this.upserts.push(task.id);
  }

  async delete(_ctx: ProjectContext, id: string): Promise<void> {
    this.remote.delete(id);
  }
}
