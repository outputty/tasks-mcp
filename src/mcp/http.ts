// The HTTP server — the standalone transport, on node:http (no framework: two routes, and the builtin
// runs everywhere Node or Bun runs). One MCP endpoint plus a health check. Claude Code usually spawns
// the stdio entrypoint via bunx instead (see bin/cli.ts); this is for a long-running shared instance or
// other HTTP clients.

import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRpc, SERVER_INFO, type RpcRequest } from "./protocol.ts";
import { makeService, type TaskService } from "../core/service.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** The MCP-over-HTTP server, not yet listening — the caller picks the port. */
export function createHttpServer(service: TaskService = makeService()): Server {
  return createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && path === "/health")
      return json(res, 200, { ok: true, server: SERVER_INFO });

    // MCP Streamable HTTP: the client POSTs a JSON-RPC message (or a batch). We answer with a single
    // JSON response and never open an SSE stream, which is valid for a server with no server-initiated
    // messages.
    if (req.method === "POST" && path === "/mcp") {
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
      }

      if (Array.isArray(payload)) {
        const responses = (
          await Promise.all(
            payload.map((m) => handleRpc(m as RpcRequest, service)),
          )
        ).filter(Boolean);
        if (responses.length) return json(res, 200, responses);
        res.writeHead(202);
        return res.end();
      }

      const response = await handleRpc(payload as RpcRequest, service);
      if (response) return json(res, 200, response);
      res.writeHead(202);
      return res.end();
    }

    json(res, 404, { error: "not found" });
  });
}
