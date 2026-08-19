// Channel tests: the doorbell and the spool driven for real — real timers, real files, real SDK
// protocol over an in-memory transport pair. Nothing here is stubbed; the only value injected is the
// pid, which is the one thing a single test process cannot otherwise vary.

import { test, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  Doorbell,
  drainEvents,
  postEvent,
  watchEvents,
  DEFAULT_NOTE,
} from "../src/core/channel.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { tmp, tmpRepo } from "./helpers.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

/** fs.watch fires on its own schedule, so wait for the EFFECT rather than guessing a delay. */
async function until(done: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

test("the doorbell coalesces every ring in one tick into a single event", async () => {
  const bell = new Doorbell();
  const rung: string[] = [];
  bell.on((note) => void rung.push(note));

  bell.ring("one");
  bell.ring("two");
  bell.ring("three");
  await tick();

  // ONE event, still — but it says what moved. A burst is when the reader most needs to know.
  expect(rung).toEqual(["one; two; three — re-evaluate"]);
});

test("a single ring keeps its own reason", async () => {
  const bell = new Doorbell();
  const rung: string[] = [];
  bell.on((note) => void rung.push(note));
  bell.ring();
  await tick();
  expect(rung).toEqual([DEFAULT_NOTE]);
});

test("a doorbell with no sink drops the ring instead of failing", async () => {
  const bell = new Doorbell();
  expect(() => bell.ring("nobody is listening")).not.toThrow();
  await tick();
});

test("the spool carries a note from another process, and never echoes your own", async () => {
  const cache = tmp();
  const repo = tmpRepo();

  postEvent(cache.dir, repo.dir, "a worker died", 999_999); // another session
  postEvent(cache.dir, repo.dir, "my own ring"); // this process, already delivered locally

  expect(drainEvents(cache.dir, repo.dir)).toEqual(["a worker died"]);
  expect(drainEvents(cache.dir, repo.dir)).toEqual([]); // exactly once: both notes are consumed

  cache.cleanup();
  repo.cleanup();
});

test("worktrees and their primary checkout share one spool", async () => {
  const cache = tmp();
  const repo = tmpRepo();
  // A git worktree resolves --git-common-dir back to the primary checkout, so both key the same spool.
  postEvent(cache.dir, repo.dir, "slot freed by parser — re-evaluate", 999_999);
  expect(drainEvents(cache.dir, repo.dir)).toEqual(["slot freed by parser — re-evaluate"]);
  cache.cleanup();
  repo.cleanup();
});

test("the watcher delivers another process's note with no sync loop running", async () => {
  const cache = tmp();
  const repo = tmpRepo();
  const seen: string[] = [];
  const stop = watchEvents(cache.dir, repo.dir, (note) => void seen.push(note));

  // Nothing polls here: no background sync, no tool call. This is the path that has to wake a session
  // sitting idle at its prompt, which is why it must not depend on --sync-interval being set.
  postEvent(cache.dir, repo.dir, "task rollback-fail-path closed — re-evaluate", 999_999);
  await until(() => seen.length > 0);

  expect(seen).toEqual(["task rollback-fail-path closed — re-evaluate"]);
  stop();
  cache.cleanup();
  repo.cleanup();
});

test("a note spooled before the watch began is delivered the moment it starts", async () => {
  const cache = tmp();
  const repo = tmpRepo();
  postEvent(cache.dir, repo.dir, "spec gate on channel-emitter", 999_999); // while nobody watched

  const seen: string[] = [];
  const stop = watchEvents(cache.dir, repo.dir, (note) => void seen.push(note));
  await until(() => seen.length > 0);

  expect(seen).toEqual(["spec gate on channel-emitter"]);
  stop();
  cache.cleanup();
  repo.cleanup();
});

test("a stopped watcher delivers nothing more", async () => {
  const cache = tmp();
  const repo = tmpRepo();
  const seen: string[] = [];
  const stop = watchEvents(cache.dir, repo.dir, (note) => void seen.push(note));
  stop();

  postEvent(cache.dir, repo.dir, "too late", 999_999);
  await tick();

  expect(seen).toEqual([]);
  expect(drainEvents(cache.dir, repo.dir)).toEqual(["too late"]); // still spooled, just undelivered
  cache.cleanup();
  repo.cleanup();
});

const ChannelEvent = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string() }),
});

/** A real server and client joined by the SDK's in-memory pair, wired exactly as runStdio wires it. */
async function connected(cacheDir: string) {
  const bell = new Doorbell();
  const server = createMcpServer(new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]));
  bell.on((note) =>
    server.server.notification({
      method: "notifications/claude/channel",
      params: { content: note },
    }),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const seen: string[] = [];
  client.setNotificationHandler(ChannelEvent, (n) => void seen.push(n.params.content));
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { bell, seen, close: async () => (await client.close(), server.close()) };
}

test("a ring reaches the client as notifications/claude/channel", async () => {
  const cache = tmp();
  const { bell, seen, close } = await connected(cache.dir);

  bell.ring("slot freed by parser — re-evaluate");
  await tick();

  expect(seen).toEqual(["slot freed by parser — re-evaluate"]);
  await close();
  cache.cleanup();
});

test("a burst names the first few and counts the rest, instead of becoming a wall of text", async () => {
  const bell = new Doorbell();
  const rung: string[] = [];
  bell.on((note) => void rung.push(note));

  for (const id of ["a", "b", "c", "d", "e"]) bell.ring(`task ${id} closed — re-evaluate`);
  await tick();

  expect(rung).toEqual(["task a closed; task b closed; task c closed; and 2 more — re-evaluate"]);
});

test("identical rings in one tick collapse to one mention", async () => {
  const bell = new Doorbell();
  const rung: string[] = [];
  bell.on((note) => void rung.push(note));

  bell.ring("task api closed — re-evaluate");
  bell.ring("task api closed — re-evaluate");
  await tick();

  expect(rung).toEqual(["task api closed — re-evaluate"]);
});
