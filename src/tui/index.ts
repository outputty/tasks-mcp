// The console entry — orchestration only, imported by the CLI ONLY under --tui (a dynamic import, the
// deliberate exception to "no imports inside functions" recorded in CLAUDE.md). It starts a tracker for
// itself on an ephemeral loopback port, connects to it as an MCP client, reads the queue, and renders
// it. Importing this module loads @opentui/core (through ./view), so keeping it off the server path is
// what keeps the renderer's native FFI out of every plain server spawn.

import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createCliRenderer } from "@opentui/core";
import { startHttpServer } from "../mcp/http.ts";
import type { TaskService } from "../core/service.ts";
import { connectTracker, mcpEndpoint, type Tracker } from "./tracker.ts";
import { readTrackers } from "./config.ts";
import { Console } from "./app.ts";

const FFI_FLAG = "--experimental-ffi";
const REEXEC_ENV = "TASKS_MCP_TUI_FFI";

/**
 * Run the interactive console over `service`: serve it on an ephemeral loopback port, connect as an MCP
 * client (the same path a remote tracker uses), read the queue, and render until `q`. Re-execs once
 * under --experimental-ffi when the renderer's FFI is off, so `tasks-mcp --tui` works without the user
 * remembering a node flag (a feature that needs a remembered flag has a bug, not a caveat).
 */
export async function runTui(service: TaskService): Promise<void> {
  if (reexecedForFfi()) return;
  const server = startHttpServer(service, { port: 0 });
  const cacheDir = service.cacheDir();
  const base = await localBase(server);
  const local: Tracker = {
    id: "local",
    url: base,
    client: await connectTracker(mcpEndpoint(base)),
  };
  const { trackers, unreachable } = await connectSaved(cacheDir, local);
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const quit = () => shutdown(renderer, server, trackers);
  await new Console(renderer, trackers, cacheDir, quit, unreachable).start();
}

/** Tear everything down and exit: the renderer, every tracker's client, and the in-process server. */
function shutdown(renderer: { destroy: () => void }, server: Server, trackers: Tracker[]): void {
  renderer.destroy();
  for (const t of trackers) void t.client.close();
  server.close();
  process.exit(0);
}

/** Connect the saved trackers alongside the local one; a tracker down at startup degrades — its url is
 *  returned as unreachable (shown on the queue), and the console still runs. */
async function connectSaved(
  cacheDir: string,
  local: Tracker,
): Promise<{ trackers: Tracker[]; unreachable: string[] }> {
  const trackers: Tracker[] = [local];
  const unreachable: string[] = [];
  for (const { url } of readTrackers(cacheDir)) {
    try {
      trackers.push({ id: url, url, client: await connectTracker(mcpEndpoint(url)) });
    } catch {
      unreachable.push(url);
    }
  }
  return { trackers, unreachable };
}

/**
 * Re-exec this process under --experimental-ffi and return true, UNLESS the flag is already active or a
 * previous re-exec set the sentinel (then return false and let the caller proceed). The renderer reaches
 * native code through Node's FFI, which that flag gates; a plain `tasks-mcp --tui` cannot pass it, and
 * the sentinel stops an infinite loop.
 */
function reexecedForFfi(): boolean {
  if (process.env[REEXEC_ENV]) return false;
  if (process.execArgv.some((a) => a.includes("experimental-ffi"))) return false;
  const argv = [FFI_FLAG, ...process.execArgv, process.argv[1], ...process.argv.slice(2)];
  const child = spawnSync(process.execPath, argv, {
    stdio: "inherit",
    env: { ...process.env, [REEXEC_ENV]: "1" },
  });
  process.exit(child.status ?? 1);
}

/** The base url of the in-process server once it is bound to its ephemeral loopback port. */
async function localBase(server: Server): Promise<string> {
  if (!server.listening) await once(server, "listening");
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}
