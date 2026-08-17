// The stdio transport — how Claude Code runs this server when it spawns the package. MCP stdio is
// newline-delimited JSON-RPC: read one message per line from stdin, write one response line to stdout.
// Notifications get no reply. Logs must go to stderr so they never corrupt the stream.

import { handleRpc, type RpcRequest } from "./protocol.ts";
import { makeService, type TaskService } from "../core/service.ts";

export async function runStdio(
  service: TaskService = makeService(),
): Promise<void> {
  const write = (obj: unknown) =>
    process.stdout.write(JSON.stringify(obj) + "\n");

  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg: RpcRequest;
      try {
        msg = JSON.parse(line);
      } catch {
        write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
        continue;
      }
      const response = await handleRpc(msg, service);
      if (response) write(response);
    }
  }
}
