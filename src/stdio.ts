// The stdio transport — how Claude Code runs this server when it spawns `bunx @outputty/tasks-mcp`. MCP
// stdio is newline-delimited JSON-RPC: read one message per line from stdin, write one response line to
// stdout. Notifications get no reply. Logs must go to stderr so they never corrupt the stream.

import { handleRpc, type RpcRequest } from "./mcp.ts";
import { makeService, type TaskService } from "./service.ts";

export async function runStdio(
  service: TaskService = makeService(),
): Promise<void> {
  const encoder = new TextEncoder();
  const write = (obj: unknown) =>
    Bun.write(Bun.stdout, encoder.encode(JSON.stringify(obj) + "\n"));

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg: RpcRequest;
      try {
        msg = JSON.parse(line);
      } catch {
        await write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
        continue;
      }
      const response = await handleRpc(msg, service);
      if (response) await write(response);
    }
  }
}
