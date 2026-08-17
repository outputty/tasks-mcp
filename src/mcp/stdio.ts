// The stdio transport — how Claude Code runs this server when it spawns the package. The SDK owns the
// framing; logs must go to stderr so they never corrupt the stream.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.ts";
import { makeService, type TaskService } from "../core/service.ts";

export async function runStdio(service: TaskService = makeService()): Promise<void> {
  await createMcpServer(service).connect(new StdioServerTransport());
}
