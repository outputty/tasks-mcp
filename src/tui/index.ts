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
import { connectTracker } from "./tracker.ts";
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
  const client = await connectTracker(await mcpUrl(server));
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const app = new Console(renderer, client, () => {
    renderer.destroy();
    void client.close();
    server.close();
    process.exit(0);
  });
  await app.start();
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

/** The `/mcp` URL of `server` once it is bound to its ephemeral loopback port. */
async function mcpUrl(server: Server): Promise<string> {
  if (!server.listening) await once(server, "listening");
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}/mcp`;
}
