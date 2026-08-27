// The interactive console as a state machine: keys are fed straight to Console.onKey (a real terminal
// delivers the same events; mockInput coalesces ESC, so synthetic keys are cleaner), and each write
// lands on a real in-process service for one project. The renderer is the headless test renderer — no
// TTY, no MCP client.

import { test, expect } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { Console } from "../src/tui/app.ts";
import { tmp, task } from "./helpers.ts";

const fileStack = (cacheDir: string) =>
  new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);

async function makeApp(svc: TaskStack, project = "p") {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 22,
  });
  let quit = false;
  const app = new Console(renderer, svc, project, () => (quit = true));
  const close = async () => renderer.destroy();
  return { app, renderOnce, frame: captureCharFrame, quit: () => quit, close };
}

test("⏎ opens a task and esc returns to the queue", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "p" }, task({ id: "alpha", brief: "## Problem\nbody" }));
  await svc.create({ project: "p" }, task({ id: "beta" }));
  const { app, renderOnce, frame, close } = await makeApp(svc);
  await app.start();
  await app.onKey({ name: "return" });
  await renderOnce();
  expect(frame()).toContain("state open"); // the detail screen
  await app.onKey({ name: "escape" });
  await renderOnce();
  expect(frame()).toContain("PROJECT"); // back on the queue
  await close();
  cache.cleanup();
});

test("q quits from the queue", async () => {
  const cache = tmp();
  const { app, quit, close } = await makeApp(fileStack(cache.dir));
  await app.start();
  await app.onKey({ name: "q" });
  expect(quit()).toBe(true);
  await close();
  cache.cleanup();
});

test("e edits a cycled field and the write carries only the change", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "p" }, task({ id: "alpha", priority: "normal" }));
  const { app, close } = await makeApp(svc);
  await app.start();
  await app.onKey({ name: "return" }); // open
  await app.onKey({ name: "e" }); // edit
  await app.onKey({ name: "down" }); // title -> priority
  await app.onKey({ name: "right" }); // normal -> low
  await app.onKey({ name: "return" }); // save
  expect((await svc.get({ project: "p" }, "alpha"))?.priority).toBe("low");
  await close();
  cache.cleanup();
});

test("s starts a task, and s then c closes one", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "p" }, task({ id: "alpha" }));
  const { app, close } = await makeApp(svc);
  await app.start();
  await app.onKey({ name: "return" });
  await app.onKey({ name: "s" }); // state menu
  await app.onKey({ name: "s" }); // start
  expect((await svc.get({ project: "p" }, "alpha"))?.status).toBe("in_progress");
  await app.onKey({ name: "return" }); // reopen (still in queue, in_progress)
  await app.onKey({ name: "s" });
  await app.onKey({ name: "c" }); // close
  expect((await svc.get({ project: "p" }, "alpha"))?.status).toBe("done");
  await close();
  cache.cleanup();
});

test("n files a drafting idea from a typed title", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "p" }, task({ id: "alpha" }));
  const { app, close } = await makeApp(svc);
  await app.start();
  await app.onKey({ name: "return" });
  await app.onKey({ name: "n" }); // new-idea prompt
  for (const ch of "hello") await app.onKey({ name: ch, sequence: ch });
  await app.onKey({ name: "return" }); // submit
  const idea = (await svc.list({ project: "p" })).find((t) => t.spec === "drafting");
  expect(idea?.title).toBe("hello");
  await close();
  cache.cleanup();
});

test("a failed write surfaces an error and leaves the item unchanged", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "p" }, task({ id: "alpha" }));
  const { app, renderOnce, frame, close } = await makeApp(svc);
  await app.start();
  await app.onKey({ name: "return" });
  await app.onKey({ name: "c" }); // comment prompt
  await app.onKey({ name: "x", sequence: "x" });
  await app.onKey({ name: "return" }); // appendTrail fails: a file-only project has no thread
  await renderOnce();
  expect(frame()).toContain("⚠"); // the error is shown, the app did not crash
  expect((await svc.get({ project: "p" }, "alpha"))?.status).toBe("open"); // unchanged
  await close();
  cache.cleanup();
});
