// The console's screens as plain string lines — pure, no renderer, so every screen's content is tested
// directly. `paint` (view.ts) turns these into OpenTUI text; the app (app.ts) picks which builder to
// call for the current screen. Kept free of @opentui/core so the tests never load the native renderer.

import type { QueueRow } from "./queue.ts";
import type { Detail, EditFields } from "./actions.ts";
import type { TrailEntry } from "../core/types.ts";
import { PRIORITIES, QA_LEVELS } from "../core/types.ts";
import { tierOf, qaOf, priorityOf } from "../core/graph.ts";

const COL = { project: 22, task: 28, state: 12 } as const;

/** The editable fields the detail form walks, in order. */
export const EDIT_FIELDS = ["title", "priority", "tier", "qa", "deps"] as const;

/** The closed value sets for the cycled fields; a field absent here (title, deps) is free text. */
export const FIELD_OPTIONS: Partial<Record<(typeof EDIT_FIELDS)[number], readonly string[]>> = {
  priority: PRIORITIES,
  tier: ["1", "2", "3", "4"],
  qa: QA_LEVELS,
};

/** The queue screen: a header and one row per task, the selected row marked with `›`. */
export function queueLines(rows: QueueRow[], selected: number): string[] {
  const out = [`  ${cols("PROJECT", "TASK", "STATE", "AGE")}`];
  if (rows.length === 0) out.push("  (nothing in progress or ready)");
  rows.forEach((r, i) => {
    out.push(`${i === selected ? "›" : " "} ${cols(r.project, r.id, r.state, r.age)}`);
  });
  return out;
}

/** The detail screen: execution properties, target and deps with each dep's done-state, the brief, and
 *  the trail newest-first. */
export function detailLines(detail: Detail): string[] {
  const t = detail.task;
  return [
    `state ${t.status}   tier ${tierOf(t)}   qa ${qaOf(t)}   priority ${priorityOf(t)}`,
    `target ${t.target ?? "—"}   deps ${depsLabel(detail.deps)}`,
    " ",
    ...clip(t.brief ?? "(no brief)", 8),
    " ",
    `TRAIL (${detail.trail.length})`,
    ...detail.trail.slice(0, 8).map(trailLine),
  ];
}

/** The edit form: one line per field, the selected one marked, its current value shown. */
export function editLines(fields: EditFields, selected: number): string[] {
  const rows = EDIT_FIELDS.map(
    (f, i) => `${i === selected ? "›" : " "} ${f.padEnd(10)} ${fields[f]}`,
  );
  return ["edit — ↑↓ field · ←→ cycle · type to edit · ⏎ save · esc cancel", " ", ...rows];
}

/** A single-line text prompt (a comment, or a new idea's title). */
export function promptLines(label: string, buffer: string): string[] {
  return [label, " ", `› ${buffer}▏`];
}

/** deps as `id (done)`, or an em dash when there are none. */
function depsLabel(deps: Detail["deps"]): string {
  if (deps.length === 0) return "—";
  return deps.map((d) => `${d.id} (${d.done ? "done" : "open"})`).join(", ");
}

/** One trail line: `HH:MM  kind  first line of the note`, clipped to the box width. */
function trailLine(e: TrailEntry): string {
  const time = (e.at ?? "").slice(11, 16);
  return `${time}  ${(e.kind ?? "note").padEnd(8)}  ${clip(e.note, 1)[0] ?? ""}`.slice(0, 72);
}

function clip(text: string, n: number): string[] {
  return text.split("\n").slice(0, n);
}

function cols(a: string, b: string, c: string, d: string): string {
  return `${pad(a, COL.project)}${pad(b, COL.task)}${pad(c, COL.state)}${d}`;
}

function pad(value: string, width: number): string {
  const cut = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return cut.padEnd(width);
}
