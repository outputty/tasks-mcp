// Channel tests: the doorbell and the spool driven for real — real timers, real files, real SDK
// protocol over an in-memory transport pair. Nothing here is stubbed; the only value injected is the
// pid, which is the one thing a single test process cannot otherwise vary.

import { test, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { Doorbell, drainEvents, postEvent, DEFAULT_NOTE } from "../src/core/channel.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { tmp, tmpRepo } from "./helpers.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("the doorbell coalesces every ring in one tick into a single event", async () => {
  const bell = new Doorbell();
  const rung: string[] = [];
  bell.on((note) => void rung.push(note));

  bell.ring("one");
  bell.ring("two");
  bell.ring("three");
  await tick();

  expect(rung).toEqual(["3 changes — re-evaluate"]); // ten tasks closing at once wake the session once
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
