// The console entry — orchestration only, imported by the CLI ONLY under --tui (a dynamic import, the
// deliberate exception to "no imports inside functions" recorded in CLAUDE.md). It reads the core
// service directly and renders one project's queue. Importing this module loads @opentui/core (through
// ./view), so keeping it off every other path keeps the renderer's native FFI out of a plain CLI spawn.

import { spawnSync } from "node:child_process";
import { createCliRenderer } from "@opentui/core";
import type { TaskService } from "../core/service.ts";
import { Console } from "./app.ts";

const FFI_FLAG = "--experimental-ffi";
const REEXEC_ENV = "TASKS_MCP_TUI_FFI";

/**
 * Run the interactive console over `service` for one `project`: read that project's queue directly from
 * the core and render until `q`. Re-execs once under --experimental-ffi when the renderer's FFI is off,
 * so `tasks-mcp --tui` works without the user remembering a node flag (a feature that needs a remembered
 * flag has a bug, not a caveat).
 */
export async function runTui(service: TaskService, project: string): Promise<void> {
  if (reexecedForFfi()) return;
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const quit = () => shutdown(renderer);
  await new Console(renderer, service, project, quit).start();
}

/** Tear down the renderer and exit. */
function shutdown(renderer: { destroy: () => void }): void {
  renderer.destroy();
  process.exit(0);
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
