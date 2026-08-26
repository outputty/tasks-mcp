// Identity: `project` is an opaque, supplied id — a `--project-id` server default with a per-call
// override — and GitHub's coordinates are per-project `repo` config with a launch-cwd fallback. The
// MCP default/override and the provider's repo resolution are driven e2e (real SDK transport, real
// provider, nock at the wire); `validateProjectId` is a pure function checked directly.

import fs from "node:fs";
import path from "node:path";
import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { Octokit } from "octokit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../src/mcp/http.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { GitHubProvider } from "../src/core/providers/github.ts";
import { parse } from "yaml";
import { ConfigProvider, validateProjectId, cachePath } from "../src/core/providers/config.ts";
import { readProjectSummaries } from "../src/core/projects.ts";
import { buildStack, resolveRemotes } from "../src/core/providers/provider.ts";
import { task, tmp } from "./helpers.ts";
import { NockGitHub, installNock, nockProvider } from "./nock-github.ts";
import { MockProvider } from "./mock-provider.ts";

/** A file-only stack over one cacheDir — isolates the id-keyed storage, no remote involved. */
const fileStack = (cacheDir: string) =>
  new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/^(localhost|127\.0\.0\.1)/); // the tests talk to their own http server
});
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

/** A nock-intercepted Octokit, throttle/retry off so the mocked endpoint answers immediately. */
const octo = (): Octokit =>
  new Octokit({ auth: "test-token", throttle: { enabled: false }, retry: { enabled: false } });

/** The real HTTP server on an ephemeral port with `defaultProject` as its --project-id, plus a
 *  connected SDK client. */
async function startHttp(service: TaskStack, defaultProject?: string) {
  const server = createHttpServer(service, defaultProject);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const close = async () => {
    await client.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  };
  return { client, close };
}

const structured = (res: unknown) => (res as any).structuredContent;

test("validateProjectId accepts any non-empty opaque id and echoes it unchanged", () => {
  expect(validateProjectId("outputty/tasks-mcp")).toBe("outputty/tasks-mcp");
  expect(validateProjectId("my-thing")).toBe("my-thing");
});

test("validateProjectId refuses a traversal id with the message the identify example shows", () => {
  expect(() => validateProjectId("../../etc/passwd")).toThrow(
    "invalid project id '../../etc/passwd' — an id may not contain path traversal",
  );
});

test("validateProjectId refuses an empty or whitespace id", () => {
  expect(() => validateProjectId("   ")).toThrow("may not be empty");
});

test("a tool call omitting project resolves the server's --project-id default; passing project overrides it", async () => {
  installNock(new NockGitHub());
  const cache = tmp();
  const service = new TaskStack({ cacheDir: cache.dir }, [
    new FileProvider({ cacheDir: cache.dir }),
    nockProvider({ projects: false, cacheDir: cache.dir }),
  ]);
  const { client, close } = await startHttp(service, "team/alpha");

  // Created under the explicit default id.
  await client.callTool({
    name: "add_task",
    arguments: { project: "team/alpha", id: "a", title: "A" },
  });

  // Omitting project falls back to the default and sees the task.
  const viaDefault = await client.callTool({ name: "list_tasks", arguments: {} });
  expect(structured(viaDefault).ids).toContain("a");

  // A different id is a different project: the top layer is keyed per id, so it sees its own graph.
  const viaOther = await client.callTool({
    name: "list_tasks",
    arguments: { project: "team/beta" },
  });
  expect(structured(viaOther).ids).not.toContain("a");

  await close();
  cache.cleanup();
});

test("a project's `repo` config lets the GitHub provider resolve coordinates with no git repo present", async () => {
  const gh = installNock(new NockGitHub());
  gh.issues.push({
    id: "I_seed",
    number: 1,
    title: "seed",
    body: "<!-- outputty:task\nid: seed\n-->",
    state: "OPEN",
  });
  const cache = tmp();
  const config = new ConfigProvider({ cacheDir: cache.dir });
  config.set("acme/widgets", "repo", { repo: "acme/widgets", projects: false });
  // launchCwd is a directory that is NOT a git repo — resolution must come from `repo`, not git.
  const provider = new GitHubProvider(config, octo(), "/tasks-mcp-not-a-git-dir");

  const states = await provider.pull({ project: "acme/widgets" });
  expect(states.has("seed")).toBe(true);

  cache.cleanup();
});

test("with no `repo` set and a launch cwd outside any git repo, the provider errors naming `repo`, not git", async () => {
  installNock(new NockGitHub());
  const cache = tmp();
  const config = new ConfigProvider({ cacheDir: cache.dir, projects: false });
  const provider = new GitHubProvider(config, octo(), "/tasks-mcp-not-a-git-dir");

  await expect(provider.pull({ project: "acme/widgets" })).rejects.toThrow(/`repo`/);

  cache.cleanup();
});

// --- identity-storage: tasks, config and claims key on the id, used verbatim as the filename ---------

test("two stacks over one cacheDir and one id share a single, verbatim-named cache file", async () => {
  const cache = tmp();
  const id = "acme/widgets";
  // Two independent stacks — no sync between them, as two worktrees launched from one .mcp.json.
  await fileStack(cache.dir).create({ project: id }, task({ id: "t1", title: "one" }));
  const other = await fileStack(cache.dir).get({ project: id }, "t1");
  expect(other?.title).toBe("one");

  // The file is exactly <cacheDir>/acme/widgets.yaml — the id verbatim, nested on `/`, no hash.
  expect(fs.existsSync(path.join(cache.dir, "acme", "widgets.yaml"))).toBe(true);
  const stray = fs.readdirSync(cache.dir).filter((f) => /-[0-9a-f]{8}\.yaml$/.test(f));
  expect(stray).toEqual([]); // no legacy <basename>-<hash>.yaml
  cache.cleanup();
});

test("the per-project config override lands under the id and a second reader sees it", () => {
  const cache = tmp();
  const id = "acme/widgets";
  new ConfigProvider({ cacheDir: cache.dir }).set(id, "repo", { board: "Roadmap" });
  expect(new ConfigProvider({ cacheDir: cache.dir }).get(id).board).toBe("Roadmap");
  expect(fs.existsSync(path.join(cache.dir, "acme", "widgets.config.yaml"))).toBe(true);
  cache.cleanup();
});

test("a nested id, a top-level id, and the id `claims` each key without colliding with the claims ledger", async () => {
  const cache = tmp();
  for (const id of ["acme/widgets", "widgets", "claims"]) {
    const svc = fileStack(cache.dir);
    await svc.create({ project: id }, task({ id: "t", title: id }));
    await svc.start({ project: id }, "t"); // writes a claim ledger under claims/<id>.json
    expect((await svc.get({ project: id }, "t"))?.title).toBe(id);
    expect((await svc.staleClaims({ project: id })).length).toBe(0); // ledger is readable, not stale yet
  }
  // The top-level id `claims` is the FILE claims.yaml, distinct from the claims/ ledger DIRECTORY.
  expect(fs.statSync(path.join(cache.dir, "claims.yaml")).isFile()).toBe(true);
  expect(fs.statSync(path.join(cache.dir, "claims")).isDirectory()).toBe(true);
  cache.cleanup();
});

test("a file-layer write declares its id, and an absolute-path id round-trips exactly through the projects row", async () => {
  const cache = tmp();
  const id = "/Users/x/Documents/repo"; // an absolute path is a perfectly ordinary opaque id
  await fileStack(cache.dir).create({ project: id }, task({ id: "t1", title: "one" }));

  // contract 2: the cache file carries a `project:` key holding the id verbatim.
  const file = cachePath(cache.dir, id, ".yaml");
  expect((parse(fs.readFileSync(file, "utf8")) as { project?: string }).project).toBe(id);

  // contract 1: `identify` echoes validateProjectId(id) and the projects row reads the declared key —
  // the SAME string, leading separator included, where before they differed by the stripped `/`.
  const [row] = readProjectSummaries(cache.dir);
  expect(row.project).toBe(validateProjectId(id));
  expect(row.project).toBe(id);
  cache.cleanup();
});

test("load reads a file's tasks whether or not it declares an id (both build directions)", async () => {
  const cache = tmp();
  // A NEW file (declares `project:`) — a new build reads its tasks through the declared-id key.
  await fileStack(cache.dir).create({ project: "acme/new" }, task({ id: "a", title: "A" }));
  expect((await fileStack(cache.dir).get({ project: "acme/new" }, "a"))?.title).toBe("A");
  // An OLD file (no `project:` key, as a pre-key build wrote it) — tryParse ignores the missing key
  // and still reads the tasks, so a new build reads an old file unchanged.
  const old = path.join(cache.dir, "acme", "old.yaml");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, "tasks:\n  - id: b\n    title: B\n    status: open\n");
  expect((await fileStack(cache.dir).get({ project: "acme/old" }, "b"))?.title).toBe("B");
  cache.cleanup();
});

test("an unparseable <id>.yaml is quarantined to .corrupt and the layer reads empty, under the new filename", async () => {
  const cache = tmp();
  const id = "acme/widgets";
  const file = path.join(cache.dir, "acme", "widgets.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "tasks: [unterminated");
  expect(await fileStack(cache.dir).list({ project: id })).toEqual([]);
  expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
  cache.cleanup();
});

test("cachePath refuses an id that would escape the cache directory, and nests an absolute-path id instead", () => {
  expect(() => cachePath("/cache", "../../etc/passwd", ".yaml")).toThrow(
    /escape the cache directory/,
  );
  expect(() => cachePath("/cache", "../sibling", ".yaml")).toThrow(/escape/);
  // An absolute path from a pre-id caller nests under the cache dir rather than escaping it.
  expect(cachePath("/cache", "/Users/x/repo", ".yaml")).toBe(
    path.join("/cache", "/Users/x/repo.yaml"),
  );
});

// --- multi-remote-stack: a project's stack can hold more than one remote ------------------------------

test("resolveRemotes: providers wins, the singular provider is its one-element form, github is default", () => {
  expect(resolveRemotes({})).toEqual(["github"]);
  expect(resolveRemotes({ provider: "linear" })).toEqual(["linear"]);
  expect(resolveRemotes({ providers: ["github", "linear"] })).toEqual(["github", "linear"]);
  expect(resolveRemotes({ provider: "linear", providers: ["github"] })).toEqual(["github"]);
});

test("buildStack builds [file, ...remotes] in order (N deep) and fails on an unknown entry naming it", () => {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token"; // GitHubProvider resolves a token at construction (no call)
  try {
    const config = new ConfigProvider();
    expect(buildStack(["github"], {}, config).map((p) => p.name)).toEqual(["file", "github"]);
    // two remotes -> three layers, proving the machinery is N-deep, not fixed at two
    expect(buildStack(["github", "github"], {}, config).map((p) => p.name)).toEqual([
      "file",
      "github",
      "github",
    ]);
    expect(() => buildStack(["github", "nope"], {}, config)).toThrow(
      /unknown provider 'nope'.*github/,
    );
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});

test("set_config accepts providers and get_config reports it in the repo and effective layers", async () => {
  installNock(new NockGitHub());
  const cache = tmp();
  const service = new TaskStack({ cacheDir: cache.dir }, [
    new FileProvider({ cacheDir: cache.dir }),
    nockProvider({ projects: false, cacheDir: cache.dir }),
  ]);
  const { client, close } = await startHttp(service, "team/alpha");

  await client.callTool({
    name: "set_config",
    arguments: { project: "team/alpha", scope: "repo", config: { providers: ["github"] } },
  });
  const cfg = await client.callTool({
    name: "get_config",
    arguments: { project: "team/alpha" },
  });
  expect(structured(cfg).repo.providers).toEqual(["github"]);
  expect(structured(cfg).effective.providers).toEqual(["github"]);

  await close();
  cache.cleanup();
});

test("across a three-layer stack the deepest layer wins a disagreement and the shallower one backfills", async () => {
  const cache = tmp();
  const shallow = new MockProvider();
  const deep = new MockProvider();
  const svc = new TaskStack({ cacheDir: cache.dir }, [
    new FileProvider({ cacheDir: cache.dir }),
    shallow,
    deep,
  ]);
  const ctx = { project: "demo" };
  await svc.create(ctx, task({ id: "api", title: "v1" }));

  deep.remote.get("api")!.task.title = "v2"; // the deepest layer disagrees
  await svc.sync(ctx);

  expect((await svc.get(ctx, "api"))?.title).toBe("v2"); // top adopted the deepest version
  expect(shallow.remote.get("api")?.task.title).toBe("v2"); // the shallower layer backfilled
  cache.cleanup();
});

test("adding an empty deepest layer to a populated stack backfills it on one sync (the free migration)", async () => {
  const cache = tmp();
  const ctx = { project: "demo" };
  const dayZero = new TaskStack({ cacheDir: cache.dir }, [
    new FileProvider({ cacheDir: cache.dir }),
    new MockProvider(),
  ]);
  await dayZero.create(ctx, task({ id: "schema" }));
  await dayZero.create(ctx, task({ id: "api", deps: ["schema"] }));

  const late = new MockProvider();
  const dayOne = new TaskStack({ cacheDir: cache.dir }, [
    new FileProvider({ cacheDir: cache.dir }),
    new MockProvider(),
    late,
  ]);
  await dayOne.sync(ctx);

  expect([...late.remote.keys()].sort()).toEqual(["api", "schema"]); // backfilled, not erased
  expect((await dayOne.list(ctx)).length).toBe(2);
  cache.cleanup();
});
