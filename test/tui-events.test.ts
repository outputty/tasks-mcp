// The console follows /events: a change on a watched tracker redraws the queue with no keypress. Each
// tracker is a real in-process HTTP server streaming /events; the cross-process leg is a real second OS
// process writing the cache (the two-real-processes rule), and the headless test renderer captures the
// frames. No nock — every socket here is a real loopback socket.

import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import { createHttpServer } from "../src/mcp/http.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { connectTracker, type Tracker } from "../src/tui/tracker.ts";
import { Console } from "../src/tui/app.ts";
import { tmp, task } from "./helpers.ts";

const fileStack = (cacheDir: string) =>
  new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);

async function serve(svc: TaskStack): Promise<{ base: string; server: Server }> {
  const server = createHttpServer(svc);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function trackerOn(
  svc: TaskStack,
): Promise<{ tracker: Tracker; server: Server; close: () => Promise<void> }> {
  const { base, server } = await serve(svc);
  const client = await connectTracker(`${base}/mcp`);
  return {
    tracker: { id: base, url: base, client },
    server,
    close: async () => {
      await client.close().catch(() => {}); // the server may already be gone
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}

async function makeConsole(trackers: Tracker[], cacheDir: string) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 24,
  });
  const app = new Console(renderer, trackers, cacheDir, () => {});
  return { app, renderOnce, frame: captureCharFrame, close: () => renderer.destroy() };
}

/** Poll renderOnce + frame until the frame contains `text`, or throw after `timeoutMs`. */
async function waitForFrame(
  renderOnce: () => Promise<void>,
  frame: () => string,
  text: string,
  timeoutMs = 6000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await renderOnce();
    if (frame().includes(text)) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`frame never contained ${JSON.stringify(text)}; last frame:\n${frame()}`);
}

/** Poll a condition until true, or throw after `timeoutMs`. */
async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met in time");
}

/** Wait until a tracker's server has its /events subscriber(s) attached — the console's stream(s) are
 *  connected, so a change from now on will be delivered rather than raised before anyone is listening. */
async function connected(svc: TaskStack, count = 1): Promise<void> {
  await waitUntil(() => svc.changes().listenerCount() === count);
}

/** A real second OS process writes a ready task under `project` into `cacheDir` — a cross-process
 *  change the watching server turns into a /events signal. The file nests at the path the id maps to
 *  (`a/new` → `<cacheDir>/a/new.yaml`), so the file layer reads the task back, not just the id. */
function writeFromAnotherProcess(cacheDir: string, project: string): void {
  const full = path.join(cacheDir, ...project.split("/")) + ".yaml";
  const script =
    `const fs=require('fs'),path=require('path');const f=process.argv[1];` +
    `fs.mkdirSync(path.dirname(f),{recursive:true});` +
    `fs.writeFileSync(f,'project: ${project}\\ntasks:\\n  - id: a\\n    title: A\\n    status: open\\n')`;
  const child = spawnSync(process.execPath, ["-e", script, full]);
  expect(child.status).toBe(0);
}

/** A started single-tracker console over a fresh file stack seeded with one ready task, its /events
 *  stream already connected. `teardown` stops the console and cleans up. */
async function oneTrackerConsole(seedProject: string) {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: seedProject }, task({ id: "seed", title: "Seed" }));
  const t = await trackerOn(svc);
  const c = await makeConsole([t.tracker], cache.dir);
  await c.app.start();
  await c.renderOnce();
  await connected(svc);
  const teardown = async () => {
    c.app.stop();
    c.close();
    await t.close();
    cache.cleanup();
  };
  return { svc, cache, ...c, teardown };
}

/** A started two-tracker console: tracker A over cacheA (`a/p`), tracker B over cacheB (`b/p`), both
 *  streams connected. `teardown` stops the console and cleans up, tolerating a server closed mid-test. */
async function twoTrackerConsole() {
  const cacheA = tmp();
  const cacheB = tmp();
  const svcA = fileStack(cacheA.dir);
  const svcB = fileStack(cacheB.dir);
  await svcA.create({ project: "a/p" }, task({ id: "a-seed" }));
  await svcB.create({ project: "b/p" }, task({ id: "b-seed" }));
  const A = await trackerOn(svcA);
  const B = await trackerOn(svcB);
  const c = await makeConsole([A.tracker, B.tracker], cacheA.dir);
  await c.app.start();
  await c.renderOnce();
  await connected(svcA);
  await connected(svcB);
  const teardown = async () => {
    c.app.stop();
    c.close();
    await A.close();
    await B.close();
    cacheA.cleanup();
    cacheB.cleanup();
  };
  return { svcA, svcB, cacheA, cacheB, A, B, ...c, teardown };
}

test("a change by a different process redraws the console queue with no keypress", async () => {
  const { cache, frame, renderOnce, teardown } = await oneTrackerConsole("acme/seed");
  expect(frame()).toContain("acme/seed"); // the seed is there before the change

  writeFromAnotherProcess(cache.dir, "other/proj");
  await waitForFrame(renderOnce, frame, "other/proj"); // the queue redrew itself, no keypress

  await teardown();
}, 20000);

test("two trackers each get one stream; a change on one refreshes only that one's rows", async () => {
  const { svcA, svcB, cacheA, frame, renderOnce, teardown } = await twoTrackerConsole();
  expect(frame()).toContain("a/p");
  expect(frame()).toContain("b/p");
  expect(svcA.changes().listenerCount()).toBe(1); // exactly one /events subscriber per tracker
  expect(svcB.changes().listenerCount()).toBe(1);

  writeFromAnotherProcess(cacheA.dir, "a/new");
  await waitForFrame(renderOnce, frame, "a/new");
  expect(frame()).toContain("b/p"); // B's rows still there, untouched
  expect(frame()).not.toContain("b/new"); // nothing invented for the tracker that did not move

  await teardown();
}, 20000);

test("quit closes every stream: no held connection, and no redraw after", async () => {
  const { svc, cache, app, frame, renderOnce, teardown } = await oneTrackerConsole("acme/seed");
  expect(svc.changes().listenerCount()).toBe(1); // the stream is live
  writeFromAnotherProcess(cache.dir, "live/one");
  await waitForFrame(renderOnce, frame, "live/one"); // proven live: it redraws

  app.stop();
  await waitUntil(() => svc.changes().listenerCount() === 0);
  expect(svc.changes().listenerCount()).toBe(0); // the /events connection is closed

  const before = app.readCount();
  writeFromAnotherProcess(cache.dir, "after/stop");
  await new Promise((r) => setTimeout(r, 500)); // longer than the debounce window
  await renderOnce();
  expect(frame()).not.toContain("after/stop"); // no subscription, no timer, no redraw
  expect(app.readCount()).toBe(before);

  await teardown();
}, 20000);

test("a burst of changes coalesces to one re-read, and the : connected frame triggers none", async () => {
  const { svc, app, teardown } = await oneTrackerConsole("acme/seed");
  expect(app.readCount()).toBe(0); // the : connected comment frame is not an event, so no re-read

  for (let i = 0; i < 5; i++) svc.changes().emit("acme/seed"); // five frames inside one window
  await waitUntil(() => app.readCount() >= 1);
  await new Promise((r) => setTimeout(r, 250)); // let any second timer fire
  expect(app.readCount()).toBe(1); // coalesced to a single re-read

  await teardown();
}, 20000);

test("a dropped stream is shown, its rows persist, and the other tracker keeps redrawing", async () => {
  const { cacheA, B, frame, renderOnce, teardown } = await twoTrackerConsole();
  expect(frame()).toContain("a/p");
  expect(frame()).toContain("b/p");

  await closeServer(B.server); // drop B's stream
  await waitForFrame(renderOnce, frame, "stream lost"); // the failure is visible
  expect(frame()).toContain("b/p"); // B's rows persist — last known state

  writeFromAnotherProcess(cacheA.dir, "a/new");
  await waitForFrame(renderOnce, frame, "a/new"); // A keeps redrawing

  await teardown();
}, 20000);
