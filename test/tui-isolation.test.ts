// The renderer is --tui only: starting the MCP server must never load @opentui/core (a ~20 MB native
// TUI framework). This file records every module the server path resolves and asserts the renderer is
// not among them. It MUST stay free of a top-level @opentui/core import — one would load it before the
// check and defeat the whole test — which is why it is a separate file from tui.test.ts.

import { test, expect } from "vitest";
import { registerHooks } from "node:module";

test("starting the stdio server does NOT load @opentui/core", async () => {
  const resolved: string[] = [];
  registerHooks({
    resolve(specifier, context, next) {
      resolved.push(specifier);
      return next(specifier, context);
    },
  });
  const loadsRenderer = () => resolved.some((s) => s.includes("@opentui/core"));

  // Build the server the no-flag CLI path builds — its whole static import graph loads here.
  await import("../src/mcp/stdio.ts"); // the stdio entry's graph
  const { createMcpServer } = await import("../src/mcp/server.ts");
  const { TaskStack } = await import("../src/core/service.ts");
  const { FileProvider } = await import("../src/core/providers/file.ts");
  createMcpServer(
    new TaskStack({ cacheDir: "/tmp/none" }, [new FileProvider({ cacheDir: "/tmp/none" })]),
  );
  expect(loadsRenderer()).toBe(false); // the renderer stayed out of the server graph

  // Positive control: the hook DOES see @opentui/core when something imports it, so the check above is
  // a real assertion rather than a hook that never fires.
  await import("@opentui/core");
  expect(loadsRenderer()).toBe(true);
});
