// The change bus — the in-process signal a long-running server publishes so an IDLE reader (the
// console's /events stream) learns a project's graph moved. It carries only WHICH project changed,
// never what: the reader then re-reads the local graph, so nothing in the signal can go stale between
// being written and being read. One bus per service; the HTTP transport subscribes one listener per
// open /events connection.

import { EventEmitter } from "node:events";

export class ChangeBus {
  // One listener per open /events connection, so the fixed default ceiling of 10 would warn on a
  // handful of concurrent readers. There is no natural cap, so the ceiling is removed.
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  /** Signal that `project`'s graph changed, waking every current subscriber. `bus.emit("acme/widgets")`. */
  emit(project: string): void {
    this.emitter.emit("changed", project);
  }

  /**
   * Run `listener` on every change until the returned function is called. The caller OWNS that
   * function and must call it when its reader disconnects, or the listener leaks for the life of the
   * server.
   *
   * `const off = bus.subscribe(p => …); off();` → the listener is gone.
   */
  subscribe(listener: (project: string) => void): () => void {
    this.emitter.on("changed", listener);
    return () => {
      this.emitter.off("changed", listener);
    };
  }

  /** How many subscribers are currently attached — what a disconnect test reads to prove no leak. */
  listenerCount(): number {
    return this.emitter.listenerCount("changed");
  }
}
