// The console's screens as plain lines — pure, no renderer. The detail screen's content is contract
// case 1 (state/tier/qa/priority, deps with done-state, the brief, the trail newest-first).

import { test, expect } from "vitest";
import { detailLines, queueLines, editLines } from "../src/tui/format.ts";
import type { Detail } from "../src/tui/actions.ts";
import type { QueueRow } from "../src/tui/queue.ts";
import { task } from "./helpers.ts";

const DETAIL: Detail = {
  task: task({
    id: "t",
    title: "T",
    status: "in_progress",
    tier: 2,
    qa: "subagent",
    priority: "high",
    target: "tui-console",
    brief: "## Problem\nthe body",
    deps: ["a", "b"],
  }),
  deps: [
    { id: "a", done: true },
    { id: "b", done: false },
  ],
  trail: [
    { note: "newest decision", kind: "decision", at: "2026-08-26T19:49:00Z" },
    { note: "older note", at: "2026-08-26T19:43:00Z" },
  ],
};

test("detailLines shows the execution properties, deps with done-state, and the brief", () => {
  const text = detailLines(DETAIL).join("\n");
  expect(text).toContain("state in_progress");
  expect(text).toContain("tier 2");
  expect(text).toContain("qa subagent");
  expect(text).toContain("priority high");
  expect(text).toContain("target tui-console");
  expect(text).toContain("a (done)");
  expect(text).toContain("b (open)");
  expect(text).toContain("## Problem");
});

test("detailLines renders the trail newest-first under a count", () => {
  const lines = detailLines(DETAIL);
  expect(lines.join("\n")).toContain("TRAIL (2)");
  const newest = lines.findIndex((l) => l.includes("newest decision"));
  const older = lines.findIndex((l) => l.includes("older note"));
  expect(newest).toBeGreaterThan(-1);
  expect(newest).toBeLessThan(older); // newest-first
});

test("queueLines marks the selected row and keeps a header", () => {
  const rows: QueueRow[] = [
    { project: "p", id: "one", title: "", state: "in progress", age: "4m" },
    { project: "p", id: "two", title: "", state: "ready", age: "—" },
  ];
  const lines = queueLines(rows, 1);
  expect(lines[0]).toContain("PROJECT");
  expect(lines.find((l) => l.includes("one"))?.startsWith("  ")).toBe(true); // not selected
  expect(lines.find((l) => l.includes("two"))?.startsWith("›")).toBe(true); // selected
});

test("editLines lists the editable fields with the selected one marked", () => {
  const lines = editLines(
    { title: "T", priority: "high", tier: "2", qa: "subagent", deps: "a, b" },
    1,
  );
  expect(lines.some((l) => l.includes("title") && l.includes("T"))).toBe(true);
  expect(lines.find((l) => l.includes("priority"))?.startsWith("›")).toBe(true);
});
