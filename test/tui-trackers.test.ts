// Adding a tracker, and watching more than one at once. The probe connects as a real MCP client and
// calls list_projects (not /health); the add flow and the multi-tracker queue are driven headlessly
// through the Console, over real in-process trackers.

import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import { createHttpServer } from "../src/mcp/http.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import {
  connectTracker,
  probeTracker,
  classifyConnectError,
  type Tracker,
} from "../src/tui/tracker.ts";
import { readTrackers } from "../src/tui/config.ts";
import { Console } from "../src/tui/app.ts";
import { tmp, task } from "./helpers.ts";

const fileStack = (cacheDir: string) =>
  new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);

async function serve(svc: TaskStack): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createHttpServer(svc);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => closeServer(server) };
}

async function localTracker(
  svc: TaskStack,
): Promise<{ tracker: Tracker; close: () => Promise<void> }> {
  const { base, close } = await serve(svc);
  const client = await connectTracker(`${base}/mcp`);
  return {
    tracker: { id: base, url: base, client },
    close: async () => {
      await client.close();
      await close();
    },
  };
}

async function makeConsole(trackers: Tracker[], cacheDir: string, unreachable: string[] = []) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 24,
  });
  const app = new Console(renderer, trackers, cacheDir, () => {}, unreachable);
  return {
    app,
    renderOnce,
    frame: captureCharFrame,
    close: () => {
      app.stop(); // close the /events subscriptions before the renderer
      renderer.destroy();
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}

async function typeUrl(app: Console, text: string): Promise<void> {
  for (const ch of text) await app.onKey({ name: ch, sequence: ch });
}

test("probeTracker connects and returns the server info and projects, not /health", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "acme/one" }, task({ id: "t" }));
  const { base, close } = await serve(svc);
  const probed = await probeTracker(base);
  expect(probed.server.name).toBe("tasks-mcp");
  expect(probed.projects.map((p) => p.project)).toContain("acme/one");
  await close();
  cache.cleanup();
});

test("classifyConnectError distinguishes refused, timed out, and not-a-tracker", () => {
  expect(classifyConnectError({ code: "ECONNREFUSED" })).toBe("connection refused");
  expect(classifyConnectError({ code: "ETIMEDOUT" })).toBe("timed out");
  expect(classifyConnectError(new Error("bad handshake"))).toBe("not an MCP tracker");
});

test("probeTracker on a closed port reports a refused connection", async () => {
  const cache = tmp();
  const dead = await serve(fileStack(cache.dir));
  await dead.close(); // the port is now closed
  await expect(probeTracker(dead.base)).rejects.toThrow(/connection refused/);
  cache.cleanup();
});

test("probeTracker on a server that is not MCP reports it is not a tracker", async () => {
  const plain = http.createServer((_q, res) => {
    res.writeHead(200);
    res.end("hi");
  });
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", () => r()));
  const port = (plain.address() as AddressInfo).port;
  await expect(probeTracker(`http://127.0.0.1:${port}`)).rejects.toThrow(/not an MCP tracker/);
  await new Promise<void>((r) => plain.close(() => r()));
});

test("a adds a tracker: probe shows it, save writes console.yaml and its projects join the queue", async () => {
  const cache = tmp();
  await fileStack(cache.dir).create({ project: "local/p" }, task({ id: "lt" }));
  const remote = tmp();
  await fileStack(remote.dir).create({ project: "remote/p" }, task({ id: "rt" }));
  const rServe = await serve(fileStack(remote.dir));
  const local = await localTracker(fileStack(cache.dir));
  const { app, renderOnce, frame, close } = await makeConsole([local.tracker], cache.dir);
  await app.start();
  await app.onKey({ name: "a" });
  await typeUrl(app, rServe.base);
  await app.onKey({ name: "return" }); // probe
  await renderOnce();
  expect(frame()).toContain("✓ connected");
  await app.onKey({ name: "return" }); // save
  expect(readTrackers(cache.dir).map((t) => t.url)).toContain(rServe.base);
  await renderOnce();
  expect(frame()).toContain("remote/p"); // merged into the queue
  await close();
  await local.close();
  await rServe.close();
  cache.cleanup();
  remote.cleanup();
});

test("a bad url shows an error and saves nothing", async () => {
  const cache = tmp();
  const local = await localTracker(fileStack(cache.dir));
  const { app, renderOnce, frame, close } = await makeConsole([local.tracker], cache.dir);
  await app.start();
  await app.onKey({ name: "a" });
  await typeUrl(app, "http://127.0.0.1:1");
  await app.onKey({ name: "return" }); // probe fails
  await renderOnce();
  expect(frame()).toContain("✗");
  expect(readTrackers(cache.dir)).toEqual([]);
  await close();
  await local.close();
  cache.cleanup();
});

/** A tracker holding one task under the project id `shared/p`, so two of them collide by design. */
async function sharedTracker(
  taskId: string,
): Promise<{ svc: TaskStack; tracker: Tracker; cleanup: () => Promise<void> }> {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "shared/p" }, task({ id: taskId, priority: "normal" }));
  const { tracker, close } = await localTracker(svc);
  return {
    svc,
    tracker,
    cleanup: async () => {
      await close();
      cache.cleanup();
    },
  };
}

test("two trackers can share a project id; a write goes to the tracker the row came from", async () => {
  const A = await sharedTracker("task-a");
  const B = await sharedTracker("task-b");
  const { app, close } = await makeConsole([A.tracker, B.tracker], A.tracker.url);
  await app.start();
  await app.onKey({ name: "down" }); // rows sorted by id: task-a (A), task-b (B) → select task-b
  await app.onKey({ name: "return" }); // open task-b on tracker B
  await app.onKey({ name: "e" });
  await app.onKey({ name: "down" }); // → priority
  await app.onKey({ name: "right" }); // normal → low
  await app.onKey({ name: "return" }); // save to B
  expect((await B.svc.get({ project: "shared/p" }, "task-b"))?.priority).toBe("low");
  expect((await A.svc.get({ project: "shared/p" }, "task-a"))?.priority).toBe("normal"); // untouched
  await close();
  await A.cleanup();
  await B.cleanup();
});

test("a tracker unreachable at startup is shown, and the console still runs", async () => {
  const cache = tmp();
  const local = await localTracker(fileStack(cache.dir));
  const { app, renderOnce, frame, close } = await makeConsole([local.tracker], cache.dir, [
    "http://dead.invalid:9999",
  ]);
  await app.start();
  await renderOnce();
  expect(frame()).toContain("unreachable: http://dead.invalid:9999");
  expect(frame()).toContain("PROJECT"); // the queue still renders
  await close();
  await local.close();
  cache.cleanup();
});
