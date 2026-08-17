// The HTTP server — the standalone transport: the SDK's Streamable HTTP on plain node:http (two
// routes never justified a framework). Stateless: each request gets a fresh server + transport pair,
// so there are no session ids to track and any instance can answer any request. Claude Code usually
// spawns the stdio entrypoint via bunx instead (see bin/cli.ts); this is for a long-running shared
// instance or other HTTP clients.

import { createServer, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, SERVER_INFO } from "./server.ts";
import { makeService, type TaskService } from "../core/service.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The MCP-over-HTTP server, not yet listening — the caller picks the port. */
export function createHttpServer(service: TaskService = makeService()): Server {
  return createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && path === "/health")
      return json(res, 200, { ok: true, server: SERVER_INFO });

    if (path === "/mcp") {
      const server = createMcpServer(service);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true, // plain JSON replies; a tools-only server never streams
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      return transport.handleRequest(req, res);
    }

    json(res, 404, { error: "not found" });
  });
}
