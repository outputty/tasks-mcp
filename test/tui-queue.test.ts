// The queue view model — a pure function over the MCP reads, so it is tested directly with no renderer
// and no client. The e2e path (a real tracker over an MCP client, and the headless renderer) lives in
// tui.test.ts.

import { test, expect } from "vitest";
import type { Task } from "../src/core/types.ts";
import { queueRows, type ProjectQueue } from "../src/tui/queue.ts";
import { task } from "./helpers.ts";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

const pq = (
  project: string,
  tasks: Task[],
  readyIds: string[],
  claimedAt: Record<string, string> = {},
): ProjectQueue => ({ project, tasks, readyIds, claimedAt });

test("queueRows shows in_progress and ready work, and hides done, targets and blocked rows", () => {
  const q: ProjectQueue = {
    project: "acme/widgets",
    tasks: [
      task({ id: "building", title: "Building", status: "in_progress" }),
      task({ id: "up-next", title: "Up next", status: "open" }),
      task({ id: "blocked", title: "Blocked", status: "open" }),
      task({ id: "shipped", title: "Shipped", status: "done" }),
      task({ id: "a-target", title: "A target", status: "open", type: "target" }),
    ],
    readyIds: ["up-next"], // the tracker lists only `up-next` as ready; `blocked` and the target are not
    claimedAt: {},
  };
  const rows = queueRows([q], NOW);
  expect(rows.map((r) => r.id)).toEqual(["building", "up-next"]);
  expect(rows.map((r) => r.state)).toEqual(["in progress", "ready"]);
});

test("an in_progress task appears even though list_ready excludes it — the console is NOT list_ready alone", () => {
  const q: ProjectQueue = {
    project: "p",
    tasks: [task({ id: "in-flight", title: "In flight", status: "in_progress" })],
    readyIds: [], // list_ready excludes in_progress, so `in-flight` is absent from it by design
    claimedAt: {},
  };
  const rows = queueRows([q], NOW);
  expect(rows.map((r) => r.id)).toEqual(["in-flight"]); // still shown — this is the whole point
  expect(rows[0].state).toBe("in progress");
});

test("rows from several projects land in one flat list, project as a column, sorted", () => {
  const queues = [
    pq("outputty/laygo", [task({ id: "r", status: "open" })], ["r"]),
    pq(
      "outputty/tasks-mcp",
      [task({ id: "detail", status: "in_progress" }), task({ id: "trackers", status: "open" })],
      ["trackers"],
    ),
  ];
  const rows = queueRows(queues, NOW);
  // sorted by project, then in_progress before ready, then id
  expect(rows.map((r) => `${r.project}/${r.id}`)).toEqual([
    "outputty/laygo/r",
    "outputty/tasks-mcp/detail",
    "outputty/tasks-mcp/trackers",
  ]);
});

test("age is minutes since the claim for an in_progress task with a known start, else an em dash", () => {
  const claimed = new Date(NOW - 41 * 60_000).toISOString();
  const q: ProjectQueue = {
    project: "p",
    tasks: [
      task({ id: "timed", status: "in_progress" }),
      task({ id: "untimed", status: "in_progress" }),
      task({ id: "waiting", status: "open" }),
    ],
    readyIds: ["waiting"],
    claimedAt: { timed: claimed }, // only `timed` has an exposed claim start
  };
  const byId = Object.fromEntries(queueRows([q], NOW).map((r) => [r.id, r.age]));
  expect(byId.timed).toBe("41m");
  expect(byId.untimed).toBe("—"); // in_progress but no exposed start time
  expect(byId.waiting).toBe("—"); // a ready task has no age
});
