// The hono HTTP server — the standalone transport. One MCP endpoint plus a health check. Claude Code
// usually spawns the stdio entrypoint via bunx instead (see bin/cli.ts); this is for a long-running
// shared instance or other HTTP clients.

import { Hono } from "hono";
import { handleRpc, SERVER_INFO, type RpcRequest } from "./mcp.ts";
import { makeService, type TaskService } from "./service.ts";

export function createApp(service: TaskService = makeService()): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, server: SERVER_INFO }));

  // MCP Streamable HTTP: the client POSTs a JSON-RPC message (or a batch). We answer with a single JSON
  // response and never open an SSE stream, which is valid for a server with no server-initiated messages.
  app.post("/mcp", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        },
        400,
      );
    }

    if (Array.isArray(payload)) {
      const responses = (
        await Promise.all(
          payload.map((m) => handleRpc(m as RpcRequest, service)),
        )
      ).filter(Boolean);
      return responses.length ? c.json(responses) : c.body(null, 202);
    }

    const response = await handleRpc(payload as RpcRequest, service);
    return response ? c.json(response) : c.body(null, 202);
  });

  return app;
}

export default createApp;
