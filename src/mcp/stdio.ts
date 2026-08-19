// The stdio transport — how Claude Code runs this server when it spawns the package. The SDK owns the
// framing; logs must go to stderr so they never corrupt the stream.
//
// This is also the ONLY transport that can be a channel: Claude Code spawns a channel server as a
// subprocess and registers the listener over stdio. Wiring the doorbell here is what turns a ring into
// a `notifications/claude/channel` event in the session. Under HTTP, or in a session started without
// `--dangerously-load-development-channels server:tasks`, the ring simply goes nowhere and every tool
// keeps working — the channel is additive, never load-bearing.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.ts";
import { makeService, type TaskService } from "../core/service.ts";
import { Doorbell } from "../core/channel.ts";

export async function runStdio(
  service: TaskService = makeService(),
  doorbell: Doorbell = new Doorbell(),
): Promise<void> {
  const server = createMcpServer(service);
  doorbell.on((note) =>
    server.server.notification({
      method: "notifications/claude/channel",
      params: { content: note },
    }),
  );
  await server.connect(new StdioServerTransport());
}
