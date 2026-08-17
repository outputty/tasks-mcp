// The hono HTTP server. One MCP endpoint plus a health check. Run with `bun run src/server.ts`; point
// Claude Code at http://localhost:<port>/mcp.

import { Hono } from "hono";
import { handleRpc, SERVER_INFO, type RpcRequest } from "./mcp.ts";
import { makeBackend, type Backend } from "./backend.ts";

export function createApp(backend: Backend = makeBackend()): Hono {
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
          payload.map((m) => handleRpc(m as RpcRequest, backend)),
        )
      ).filter(Boolean);
      // An all-notification batch gets a 202 with no body.
      return responses.length ? c.json(responses) : c.body(null, 202);
    }

    const response = await handleRpc(payload as RpcRequest, backend);
    return response ? c.json(response) : c.body(null, 202);
  });

  return app;
}

const port = Number(process.env.OUTPUTTY_MCP_PORT || 3917);

// Only start listening when run directly, so tests can import createApp without binding a port.
if (import.meta.main) {
  const app = createApp();
  console.error(
    `tasks-mcp listening on http://localhost:${port}/mcp  (health: /health)`,
  );
  Bun.serve({ port, fetch: app.fetch });
}

export default createApp;
