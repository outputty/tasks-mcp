// The change stream and the bind default, end to end: a real node:http server, a real SSE client over
// a real socket, and — for the cross-process leg — a real second OS process writing the cache. The
// stack is file-only, so nothing here touches the network and no nock is needed. The two-real-processes
// rule (lessons.md, the false-positive channel probe) is why the cross-process test spawns `node`.

import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";
import { createHttpServer, startHttpServer } from "../src/mcp/http.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { tmp, task } from "./helpers.ts";

/** A file-only stack: the file layer alone, no remote, so create/update never reach the network. */
function fileStack(cacheDir: string): TaskStack {
  return new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);
}

/** Listen on an ephemeral loopback port and return the base URL. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

/** Close a server without hanging on the open SSE socket the client did not tear down itself. */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}

type Change = { project: string; at: string };

/** Consume every complete SSE frame in `buf`, pushing each `changed` event's data; returns the leftover. */
function pushFrames(buf: string, changes: Change[]): string {
  let i: number;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    if (!frame.startsWith("event: changed")) continue;
    const data = frame.split("\n").find((l) => l.startsWith("data: "));
    if (data) changes.push(JSON.parse(data.slice("data: ".length)));
  }
  return buf;
}

/** Resolve when a `changed` event for `project` has been seen, or throw after `timeoutMs`. */
async function waitForProject(
  changes: Change[],
  project: string,
  timeoutMs = 3000,
): Promise<Change> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = changes.find((c) => c.project === project);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `no changed event for ${project} in ${timeoutMs}ms (saw ${JSON.stringify(changes)})`,
  );
}

/** One SSE client: collects `changed` events, and `waitFor` resolves when the named project appears. */
function connectEvents(base: string) {
  const req = http.get(`${base}/events`);
  const changes: Change[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk: string) => {
        buf = pushFrames(buf + chunk, changes);
      });
      resolve();
    });
  });
  return {
    ready,
    changes,
    waitFor: (project: string, timeoutMs?: number) => waitForProject(changes, project, timeoutMs),
    close: () => req.destroy(),
  };
}

/** The machine's first non-loopback IPv4, or undefined — the address a loopback bind must refuse. */
function lanIPv4(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

/** Start the server through the CLI's own listen helper and wait until it is bound, returning the
 *  server and the address it ACTUALLY bound (what the startup log would print). */
async function startBound(
  service: TaskStack,
  host?: string,
): Promise<{ server: Server; addr: AddressInfo }> {
  let addr: AddressInfo | undefined;
  const server = startHttpServer(service, { port: 0, host, onListening: (a) => (addr = a) });
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return { server, addr: addr as AddressInfo };
}

test("a write by the serving process reaches a connected /events client, without waiting for fs.watch", async () => {
  const cache = tmp();
  const service = fileStack(cache.dir);
  const server = createHttpServer(service);
  const base = await listen(server);
  const client = connectEvents(base);
  await client.ready;

  await service.create({ project: "acme/widgets" }, task({ id: "x", title: "X" }));
  const evt = await client.waitFor("acme/widgets");
  expect(evt.project).toBe("acme/widgets");
  expect(evt.at).toBeTypeOf("string");

  client.close();
  await closeServer(server);
  cache.cleanup();
});

test("a write by a DIFFERENT process reaches a connected /events client", async () => {
  const cache = tmp();
  const service = fileStack(cache.dir);
  const server = createHttpServer(service);
  const base = await listen(server);
  const client = connectEvents(base);
  await client.ready;

  // A real second process writes a cache file — the same fs.writeFileSync the file layer performs.
  const file = path.join(cache.dir, "other-proj.yaml");
  const script = `require('fs').writeFileSync(process.argv[1], 'tasks:\\n  - id: a\\n    title: A\\n    status: open\\n')`;
  const child = spawnSync(process.execPath, ["-e", script, file]);
  expect(child.status).toBe(0);

  const evt = await client.waitFor("other-proj");
  expect(evt.project).toBe("other-proj");

  client.close();
  await closeServer(server);
  cache.cleanup();
});

test("a DIFFERENT process creating a brand-new NESTED owner/repo project reaches the client", async () => {
  const cache = tmp();
  const service = fileStack(cache.dir);
  const server = createHttpServer(service);
  const base = await listen(server);
  const client = connectEvents(base);
  await client.ready;

  // The owner folder does not exist yet: its watcher can only attach after it appears, so the file
  // written inside it beats the watcher — the fix is to scan a newly-adopted folder for such files.
  const file = path.join(cache.dir, "acme", "gadget.yaml");
  const script =
    `const fs=require('fs'),path=require('path');const f=process.argv[1];` +
    `fs.mkdirSync(path.dirname(f),{recursive:true});` +
    `fs.writeFileSync(f,'tasks:\\n  - id: a\\n    title: A\\n    status: open\\n')`;
  const child = spawnSync(process.execPath, ["-e", script, file]);
  expect(child.status).toBe(0);

  const evt = await client.waitFor("acme/gadget");
  expect(evt.project).toBe("acme/gadget");

  client.close();
  await closeServer(server);
  cache.cleanup();
});

test("GET /mcp still answers 405 with an allow: POST header — /events did not reintroduce a held GET", async () => {
  const cache = tmp();
  const server = createHttpServer(fileStack(cache.dir));
  const base = await listen(server);
  const res = await fetch(`${base}/mcp`);
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
  await res.body?.cancel();
  await closeServer(server);
  cache.cleanup();
});

test("--http binds loopback by default, reports the bound address, and the LAN address refuses", async () => {
  const cache = tmp();
  const { server, addr } = await startBound(fileStack(cache.dir));
  expect(addr.address).toBe("127.0.0.1");

  const lan = lanIPv4();
  if (lan) await expect(fetch(`http://${lan}:${addr.port}/health`)).rejects.toThrow();

  await closeServer(server);
  cache.cleanup();
});

test("--host 0.0.0.0 exposes the server on every interface", async () => {
  const cache = tmp();
  const { server, addr } = await startBound(fileStack(cache.dir), "0.0.0.0");
  expect(addr.address).toBe("0.0.0.0");

  const lan = lanIPv4();
  if (lan) {
    const res = await fetch(`http://${lan}:${addr.port}/health`);
    expect(res.status).toBe(200);
    await res.body?.cancel();
  }

  await closeServer(server);
  cache.cleanup();
});

test("a disconnected /events client leaves no listener behind", async () => {
  const cache = tmp();
  const service = fileStack(cache.dir);
  const server = createHttpServer(service);
  const base = await listen(server);
  const client = connectEvents(base);
  await client.ready;
  expect(service.changes().listenerCount()).toBe(1);

  client.close();
  const deadline = Date.now() + 2000;
  while (service.changes().listenerCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(service.changes().listenerCount()).toBe(0);

  await closeServer(server);
  cache.cleanup();
});
