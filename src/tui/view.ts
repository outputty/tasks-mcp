// The queue VIEW — the one module that touches @opentui/core, so importing it loads the renderer's
// native FFI. It is reached only through src/tui/index.ts, which the CLI imports only under --tui, so a
// plain MCP server spawn never loads any of this. Given the rows (from the pure queue model) it draws a
// bordered box and binds `q` to quit; one-shot for the prototype — live refresh and the detail view are
// later layers.

import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { QueueRow } from "./queue.ts";

const COL = { project: 22, task: 28, state: 12 } as const;

/**
 * Draw the queue into `renderer.root` and bind `q` (and Ctrl-C, via the renderer's own handler) to
 * `onQuit`. `renderer` is a real CliRenderer or the headless test renderer — the same type — so a test
 * drives this without a terminal.
 *
 * A row renders as `outputty/tasks-mcp        tui-detail                  in progress   41m`.
 */
export function renderQueue(renderer: CliRenderer, rows: QueueRow[], onQuit: () => void): void {
  const box = new BoxRenderable(renderer, {
    title: `tasks-mcp — ${count(rows.length)}`,
    bottomTitle: "↑↓ move · ⏎ open · q quit",
    border: true,
    borderStyle: "single",
    flexDirection: "column",
    flexGrow: 1,
  });
  renderer.root.add(box);
  box.add(new TextRenderable(renderer, { content: row("PROJECT", "TASK", "STATE", "AGE") }));
  for (const r of rows) box.add(new TextRenderable(renderer, { content: line(r) }));
  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q") onQuit();
  });
}

/** One padded row across the four columns. */
function row(project: string, task: string, state: string, age: string): string {
  return `${pad(project, COL.project)}${pad(task, COL.task)}${pad(state, COL.state)}${age}`;
}

function line(r: QueueRow): string {
  return row(r.project, r.id, r.state, r.age);
}

/** Left-justify to `width`, truncating with an ellipsis when a value overruns its column. */
function pad(value: string, width: number): string {
  const cut = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return cut.padEnd(width);
}

function count(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}
