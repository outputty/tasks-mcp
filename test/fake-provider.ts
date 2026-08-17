// An in-memory Provider for the service and MCP protocol tests — no HTTP, no GitHub. It records what the
// service pushed and lets a test seed "remote" state (to simulate adoption, a status change, or a
// reconcile). The real GitHub HTTP path is covered separately by the nock tests.

import type { Provider, RemoteState } from "../src/core/providers/provider.ts";
import type { ProjectContext, Refs, Task } from "../src/core/types.ts";

export class FakeProvider implements Provider {
  readonly name = "fake";
  /** The provider's "remote": what it would report on pull, keyed by task id. */
  remote = new Map<string, { task: Task; refs: Refs; reconcile?: boolean }>();
  created: Task[] = [];
  updated: Task[] = [];
  private seq = 1;

  async create(_ctx: ProjectContext, task: Task): Promise<Refs> {
    const refs = { issueId: `I_${this.seq++}` };
    this.remote.set(task.id, { task: { ...task }, refs });
    this.created.push(task);
    return refs;
  }

  async update(_ctx: ProjectContext, task: Task, refs: Refs): Promise<Refs> {
    this.remote.set(task.id, { task: { ...task }, refs });
    this.updated.push(task);
    return refs;
  }

  async pull(_ctx: ProjectContext): Promise<Map<string, RemoteState>> {
    const out = new Map<string, RemoteState>();
    for (const [id, e] of this.remote)
      out.set(id, {
        patch: { ...e.task },
        refs: e.refs,
        reconcile: e.reconcile,
      });
    return out;
  }
}
