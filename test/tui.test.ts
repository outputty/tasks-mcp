// The console's single-project read path: a real in-process TaskService (file-only), no MCP client and
// no renderer. It proves the queue is the project's in-progress-or-ready work — the same read
// `Console.refresh` performs — built from `list` + graph `ready` + `claims`.

import { test, expect } from "vitest";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { ready } from "../src/core/graph.ts";
import { queueRows, type ProjectQueue } from "../src/tui/queue.ts";
import { tmp, task } from "./helpers.ts";

const fileStack = (cacheDir: string) =>
  new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);

/** Build one project's queue the way `Console.refresh` does: its tasks, the graph's ready ids, and the
 *  claim start times, keyed by task id. */
async function queueOf(svc: TaskStack, project: string): Promise<ProjectQueue> {
  const ctx = { project };
  const tasks = await svc.list(ctx);
  const claimedAt: Record<string, string> = {};
  for (const c of await svc.claims(ctx)) claimedAt[c.id] = c.claimed_at;
  return { project, tasks, readyIds: ready(tasks).map((t) => t.id), claimedAt };
}

test("the console's rows are the project's in-progress-or-ready work, NOT ready alone", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  const ctx = { project: "acme/one" };
  await svc.create(ctx, task({ id: "shipped" }));
  await svc.close(ctx, "shipped"); // done — must not appear
  await svc.create(ctx, task({ id: "building" }));
  await svc.start(ctx, "building"); // in_progress — ready() EXCLUDES this
  await svc.create(ctx, task({ id: "ready-now" }));
  await svc.create(ctx, task({ id: "blocked", deps: ["ready-now"] }));

  const rows = queueRows([await queueOf(svc, "acme/one")]);
  expect(rows.map((r) => r.id).sort()).toEqual(["building", "ready-now"]);
  expect(rows.find((r) => r.id === "shipped")).toBeUndefined(); // done is hidden
  expect(rows.find((r) => r.id === "blocked")).toBeUndefined(); // an open-but-blocked task is hidden
  expect(rows.find((r) => r.id === "building")?.state).toBe("in progress");
  // a claimed build shows a real, growing age from the claim ledger, not the ready em dash
  expect(rows.find((r) => r.id === "building")?.age).toMatch(/m$/);
  // NOT ready alone: it excludes the very in_progress build being watched.
  expect(ready(await svc.list(ctx)).map((t) => t.id)).not.toContain("building");
  cache.cleanup();
});
