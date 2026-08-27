// The queue view MODEL — pure, no renderer and no client, so it is tested directly. It turns one
// snapshot per tracker (what the console reads over MCP) into the flat cross-project row list the view
// draws. Kept free of @opentui/core on purpose: the renderer loads a native FFI binary, and nothing
// here needs it, so this is the half the tests exercise without a terminal.

import type { Task } from "../core/types.ts";

/** One line in the console's flat queue: which tracker/project it belongs to, the task, its state, and
 *  an age for in_progress work. `age` is `—` when unknown (a ready task, or an in_progress task with no
 *  claim row — a ledger the tracker lost). */
export interface QueueRow {
  project: string;
  id: string;
  title: string;
  state: "in progress" | "ready";
  age: string;
  /** The id of the tracker this row came from — two trackers can hold the same project id, so a write
   *  routes by this, not by project. Absent for a single-tracker console. */
  tracker?: string;
}

/** One tracker's snapshot, assembled from three MCP reads: every task (`list_tasks`, so in_progress is
 *  included), the ids the tracker itself calls ready (`list_ready`), and the claim start times it
 *  exposes (`list_ready`'s `claims`). The console never reaches past this tool surface. */
export interface ProjectQueue {
  project: string;
  tasks: Task[];
  readyIds: string[];
  claimedAt: Record<string, string>;
  /** The tracker this snapshot came from, carried onto each row it produces. */
  tracker?: string;
}

/**
 * The flat cross-project queue: every tracker's in_progress-or-ready work as one list, project as a
 * column. NOT `list_ready` alone — that excludes in_progress, the very builds the console exists to
 * watch — so the row set is `list_tasks` filtered to (in_progress) OR (ready, by the tracker's own
 * `list_ready`). Sorted by project, then in_progress before ready, then id, so the view never reorders
 * itself between reads.
 *
 * `queueRows([{ project: "p", tasks: [inProgressTask], readyIds: [], claimedAt: {} }])` → one row.
 */
export function queueRows(queues: ProjectQueue[], now: number = Date.now()): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const q of queues) {
    const ready = new Set(q.readyIds);
    for (const task of q.tasks) {
      const state = rowState(task, ready);
      if (!state) continue;
      const age = state === "in progress" ? ageOf(q.claimedAt[task.id], now) : "—";
      rows.push({
        project: q.project,
        tracker: q.tracker,
        id: task.id,
        title: task.title,
        state,
        age,
      });
    }
  }
  return rows.sort(byProjectThenState);
}

/** "in progress" for a claimed task, "ready" for one the tracker lists as ready, else null — a hidden
 *  row (done, a target, unsettled, or blocked by an open dep). */
function rowState(task: Task, ready: Set<string>): QueueRow["state"] | null {
  if (task.status === "in_progress") return "in progress";
  if (ready.has(task.id)) return "ready";
  return null;
}

/** Minutes (then hours) since a claim, or `—` when the start time is absent or in the future. */
function ageOf(claimedAt: string | undefined, now: number): string {
  if (!claimedAt) return "—";
  const ms = now - Date.parse(claimedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

const STATE_RANK = { "in progress": 0, ready: 1 } as const;

function byProjectThenState(a: QueueRow, b: QueueRow): number {
  if (a.project !== b.project) return a.project < b.project ? -1 : 1;
  if (a.state !== b.state) return STATE_RANK[a.state] - STATE_RANK[b.state];
  return a.id < b.id ? -1 : 1;
}
