// Stack semantics, three layers deep: the real file layer on top, the real GitHub layer (nock-backed)
// in the middle, and a controllable mock as the DEEPEST — and therefore most authoritative — layer.
// These tests pin the three rules of the stack: writes fan down, the deepest layer wins a
// disagreement, and absence is never a claim (backfill, never delete).

import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { task, tmp, tmpRepo } from "./helpers.ts";
import { NockGitHub, installNock, nockProvider } from "./nock-github.ts";
import { MockProvider } from "./mock-provider.ts";

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
  const mock = new MockProvider();
  const file = new FileProvider({ cacheDir: cache.dir });
  const svc = new TaskStack({ cacheDir: cache.dir }, [
    file,
    nockProvider({ projects: false, cacheDir: cache.dir }),
    mock,
  ]);
  return {
    svc,
    gh,
    mock,
    file,
    cacheDir: cache.dir,
    ctx: { project: project.dir },
    cleanup: () => {
      project.cleanup();
      cache.cleanup();
    },
  };
}

test("a write fans down through every layer, top to bottom", async () => {
  const { svc, gh, mock, ctx, cleanup } = harness();
  await svc.create(ctx, task({ id: "api", title: "API" }));

  expect((await svc.get(ctx, "api"))?.title).toBe("API"); // file (top)
  expect(gh.issues[0].body).toContain("id: api"); // github (middle)
  expect(mock.remote.get("api")?.task.title).toBe("API"); // mock (bottom)
  cleanup();
});

test("the deepest layer wins a disagreement, and the fix propagates everywhere", async () => {
  const { svc, gh, mock, ctx, cleanup } = harness();
  await svc.create(ctx, task({ id: "api" })); // open in all three layers
  mock.remote.get("api")!.task.status = "done"; // the bottom disagrees

  await svc.sync(ctx);
  expect((await svc.get(ctx, "api"))?.status).toBe("done"); // top adopted it
  expect(gh.issues[0].state).toBe("CLOSED"); // middle adopted it
  cleanup();
});

test("a task born at the bottom propagates to every layer above", async () => {
  const { svc, gh, mock, ctx, cleanup } = harness();
  mock.remote.set("deep", { task: task({ id: "deep", title: "born below" }) });

  await svc.sync(ctx);
  expect((await svc.get(ctx, "deep"))?.title).toBe("born below");
  expect(gh.issues[0].body).toContain("id: deep");
  cleanup();
});

test("an empty, newly added layer backfills instead of erasing (free migration)", async () => {
  const { gh, cacheDir, ctx, cleanup } = harness();
  // Day 0: a two-layer stack accumulates tasks.
  const dayZero = new TaskStack({ cacheDir }, [
    new FileProvider({ cacheDir }),
    nockProvider({ projects: false, cacheDir }),
  ]);
  await dayZero.create(ctx, task({ id: "schema" }));
  await dayZero.create(ctx, task({ id: "api", deps: ["schema"] }));

  // Day 1: the same stack with a brand-new empty layer at the bottom.
  const late = new MockProvider();
  const dayOne = new TaskStack({ cacheDir }, [
    new FileProvider({ cacheDir }),
    nockProvider({ projects: false, cacheDir }),
    late,
  ]);
  await dayOne.sync(ctx);

  expect([...late.remote.keys()].sort()).toEqual(["api", "schema"]); // backfilled
  expect((await dayOne.list(ctx)).length).toBe(2); // nothing erased
  expect(gh.issues).toHaveLength(2);
  cleanup();
});

test("absence never deletes: a task missing from a layer is pushed back into it", async () => {
  const { svc, mock, ctx, cleanup } = harness();
  await svc.create(ctx, task({ id: "api" }));
  mock.remote.delete("api"); // vanished from the bottom

  await svc.sync(ctx);
  expect(mock.remote.has("api")).toBe(true); // restored, not propagated as a delete
  expect(await svc.get(ctx, "api")).not.toBeNull();
  cleanup();
});
