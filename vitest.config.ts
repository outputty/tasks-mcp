import { defineConfig } from "vitest/config";

// The TUI renderer (@opentui/core) reaches native code through an FFI boundary that Node gates behind
// --experimental-ffi (see CLAUDE.md and package.json engines: Node 26.4+). vitest runs each test file in
// a forked worker, so the flag has to reach the WORKER's node — hence execArgv here, not a NODE_OPTIONS
// prefix on the script (which is not cross-platform). In Vitest 4 execArgv is a top-level test option.
export default defineConfig({
  test: {
    execArgv: ["--experimental-ffi"],
  },
});
