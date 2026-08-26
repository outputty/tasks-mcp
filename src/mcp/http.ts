// The HTTP server — the standalone transport: the SDK's Streamable HTTP on plain node:http (three
// routes never justified a framework). Stateless MCP: each POST /mcp gets a fresh server + transport
// pair, so there are no session ids to track and any instance can answer any request. GET /events is
// the one long-lived connection — an SSE change stream for an idle reader. Claude Code usually spawns
// the stdio entrypoint instead (see bin/cli.ts); this is for a long-running shared instance.

import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, SERVER_INFO } from "./server.ts";
import { makeService, type TaskService } from "../core/service.ts";
import type { ChangeBus } from "../core/changes.ts";
import { handleEvents, watchCacheDir } from "./events.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** One stateless MCP exchange: a fresh server + transport pair answers this POST and is torn down. */
async function handleMcp(
  service: TaskService,
  defaultProject: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = createMcpServer(service, defaultProject);
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

/** The MCP-over-HTTP server, not yet listening — the caller picks the port. `defaultProject` is the
 *  --project-id a request uses when it omits `project`. */
export function createHttpServer(
  service: TaskService = makeService(),
  defaultProject?: string,
): Server {
  const bus = service.changes();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    // /mcp first, whatever the method: it owns the 405 that stops the SDK holding a GET open as SSE.
    if (path === "/mcp") return handlePost(service, defaultProject, req, res);
    if (req.method === "GET") return handleGet(bus, path, res);
    json(res, 404, { error: "not found" });
  });

  // One watcher for the whole server (not one per /events connection), catching writes by every OTHER
  // process into the same bus this server's own writes use. Torn down when the server closes.
  const stopWatching = watchCacheDir(service.cacheDir(), (project) => bus.emit(project));
  server.on("close", stopWatching);
  return server;
}

/** The GET routes: /health, and /events — the SSE change stream held open for an idle reader. A
 *  distinct route from /mcp, so the 405 that stops the SDK holding a GET open as SSE is untouched. */
function handleGet(bus: ChangeBus, path: string, res: ServerResponse): void {
  if (path === "/health") return json(res, 200, { ok: true, server: SERVER_INFO });
  if (path === "/events") return handleEvents(bus, res);
  json(res, 404, { error: "not found" });
}

/** POST /mcp only. Stateless JSON mode never streams and has no session to delete, so any other method
 *  is answered 405 here rather than letting the transport hold the connection open as an SSE stream. */
function handlePost(
  service: TaskService,
  defaultProject: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): void | Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  return handleMcp(service, defaultProject, req, res);
}

/**
 * Create the HTTP server and start it listening. Binds `127.0.0.1` unless `host` says otherwise, so
 * the tool surface — `delete_task` included — is reachable only from this machine until exposure is an
 * explicit act (`--host 0.0.0.0`). `onListening` receives the address ACTUALLY bound, so the startup
 * log can never claim `localhost` while listening on every interface.
 *
 * `startHttpServer(svc, { port: 0 })` → a Server bound to 127.0.0.1 on an ephemeral port.
 */
export function startHttpServer(
  service: TaskService,
  opts: {
    port: number;
    host?: string;
    defaultProject?: string;
    onListening?: (addr: AddressInfo) => void;
  },
): Server {
  const server = createHttpServer(service, opts.defaultProject);
  server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
    const addr = server.address();
    if (opts.onListening && addr && typeof addr === "object") opts.onListening(addr);
  });
  return server;
}
