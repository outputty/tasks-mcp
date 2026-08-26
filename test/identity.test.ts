// Identity: `project` is an opaque, supplied id — a `--project-id` server default with a per-call
// override — and GitHub's coordinates are per-project `repo` config with a launch-cwd fallback. The
// MCP default/override and the provider's repo resolution are driven e2e (real SDK transport, real
// provider, nock at the wire); `validateProjectId` is a pure function checked directly.

import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { Octokit } from "octokit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../src/mcp/http.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { GitHubProvider } from "../src/core/providers/github.ts";
import { ConfigProvider, validateProjectId } from "../src/core/providers/config.ts";
import { tmp } from "./helpers.ts";
import { NockGitHub, installNock, nockProvider } from "./nock-github.ts";

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
