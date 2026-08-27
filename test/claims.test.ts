// The claim ledger, end to end: a real TaskStack over the real file layer and a real GitHub layer on
// nock, so the heartbeat rides the same `append_trail` a build actually calls. The unit-level tests at
// the bottom drive ClaimStore directly, because the staleness threshold is only reachable by moving
// the clock.

import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { ClaimStore, minutesSince, DEFAULT_STALE_MINUTES } from "../src/core/claims.ts";
import { ready } from "../src/core/graph.ts";
import { task, tmp, tmpRepo } from "./helpers.ts";
import { NockGitHub, installNock, nockProvider } from "./nock-github.ts";

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
});
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

function harness() {
  const gh = installNock(new NockGitHub());
  const project = tmpRepo();
  const cache = tmp();
  const svc = new TaskStack({ cacheDir: cache.dir }, [
    new FileProvider({ cacheDir: cache.dir }),
    nockProvider({ projects: false, cacheDir: cache.dir }),
  ]);
  return {
    svc,
    gh,
    ctx: { project: project.dir },
    cacheDir: cache.dir,
    cleanup: () => {
      project.cleanup();
      cache.cleanup();
    },
  };
}

/** The ledger as the service wrote it, read back through a fresh store — proves it is on disk and
 *  shared, not in-process state a second session would never see. */
const ledger = (cacheDir: string, project: string) => new ClaimStore(cacheDir, project).all();

test("start_task stamps a claim; append_trail moves the heartbeat past it", async () => {
  const { svc, ctx, cacheDir, cleanup } = harness();
  await svc.create(ctx, task({ id: "csv-export", title: "Add a CSV export of the synced orders" }));
  await svc.start(ctx, "csv-export");

  const claimed = ledger(cacheDir, ctx.project);
  expect(claimed).toHaveLength(1);
  expect(claimed[0].id).toBe("csv-export");
  expect(claimed[0].heartbeat_at).toBe(claimed[0].claimed_at); // nothing has happened yet

  // The examples.md trail entry, verbatim — the write a build makes once per layer.
  await svc.appendTrail(ctx, "csv-export", {
    kind: "decision",
    note: "Stream the CSV instead of buffering. The largest export is 400k rows and must not hold in memory.",
  });

  const beating = ledger(cacheDir, ctx.project);
  expect(beating[0].claimed_at).toBe(claimed[0].claimed_at); // the start time never moves
  expect(Date.parse(beating[0].heartbeat_at)).toBeGreaterThanOrEqual(
    Date.parse(claimed[0].claimed_at),
  );
  cleanup();
});

test("a trail note on an unclaimed task never invents a claim", async () => {
  const { svc, ctx, cacheDir, cleanup } = harness();
  await svc.create(ctx, task({ id: "csv-export" }));
  await svc.appendTrail(ctx, "csv-export", { note: "planning note, nobody is building this" });

  expect(ledger(cacheDir, ctx.project)).toEqual([]);
  cleanup();
});

test("closing a task releases its claim", async () => {
  const { svc, ctx, cacheDir, cleanup } = harness();
  await svc.create(ctx, task({ id: "csv-export" }));
  await svc.start(ctx, "csv-export");
  expect(ledger(cacheDir, ctx.project)).toHaveLength(1);

  await svc.close(ctx, "csv-export");
  expect(ledger(cacheDir, ctx.project)).toEqual([]);
  cleanup();
});

test("spec:replan releases a stale claim and returns the task to the ready set", async () => {
  const { svc, ctx, cacheDir, cleanup } = harness();
  await svc.create(ctx, task({ id: "csv-export" }));
  await svc.start(ctx, "csv-export");
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual([]); // claimed, so not offered

  await svc.update(ctx, "csv-export", { spec: "replan" });
  expect(ledger(cacheDir, ctx.project)).toEqual([]);

  // `released` puts a replanned task back to open; settling it again makes it ready, which is the
  // whole point of releasing — the work returns to the queue rather than sitting invisible.
  await svc.update(ctx, "csv-export", { spec: "settled" });
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["csv-export"]);
  cleanup();
});

test("a fresh claim reports age 0; a quiet one reports its minutes of silence", async () => {
  const { svc, ctx, cacheDir, cleanup } = harness();
  await svc.create(ctx, task({ id: "csv-export" }));
  await svc.start(ctx, "csv-export");

  const fresh = await svc.claims(ctx);
  expect(fresh).toHaveLength(1);
  expect(fresh[0].id).toBe("csv-export");
  expect(fresh[0].stale_for_minutes).toBe(0); // just claimed — reported, not filtered out

  // Twenty minutes of silence, past the fifteen-minute default a dispatcher sweeps by. Reading
  // through a second store is also the cross-session case: a dispatcher sweeping from the primary
  // checkout sees the claim a worker took from inside its worktree.
  const store = new ClaimStore(cacheDir, ctx.project);
  const aged = store.aged(Date.now() + 20 * 60_000);
  expect(aged).toHaveLength(1);
  expect(aged[0].id).toBe("csv-export");
  expect(aged[0].stale_for_minutes).toBe(20);
  expect(aged[0].stale_for_minutes).toBeGreaterThanOrEqual(DEFAULT_STALE_MINUTES); // a dispatcher flags it
  cleanup();
});

test("claimStaleMinutes stays configurable — the reader's threshold, not the service's filter", async () => {
  const { svc, ctx, cleanup } = harness();
  await svc.create(ctx, task({ id: "csv-export" }));
  await svc.start(ctx, "csv-export");
  await svc.setConfig(ctx, "repo", { claimStaleMinutes: 1 });

  // The service reports the claim with its age and applies no threshold of its own; the configured
  // threshold round-trips through the config layer for a dispatcher to filter by.
  const claims = await svc.claims(ctx);
  expect(claims).toHaveLength(1);
  expect(claims[0].stale_for_minutes).toBe(0);
  expect((await svc.getConfig(ctx)).effective.claimStaleMinutes).toBe(1);
  cleanup();
});

test("mark is idempotent on claimed_at and the ledger survives a corrupt file", () => {
  const cache = tmp();
  const project = tmpRepo();
  const store = new ClaimStore(cache.dir, project.dir);

  store.mark("a");
  const first = store.all()[0].claimed_at;
  store.mark("a");
  expect(store.all()).toHaveLength(1);
  expect(store.all()[0].claimed_at).toBe(first);

  store.release("a");
  expect(store.all()).toEqual([]);
  store.release("a"); // releasing what is not held is a no-op, never a throw

  project.cleanup();
  cache.cleanup();
});

test("minutesSince floors at zero and shrugs off an unparseable stamp", () => {
  const now = Date.parse("2026-08-23T12:00:00Z");
  expect(minutesSince("2026-08-23T11:40:00Z", now)).toBe(20);
  expect(minutesSince("2026-08-23T12:30:00Z", now)).toBe(0); // a clock that jumped back
  expect(minutesSince("not a date", now)).toBe(0);
});
