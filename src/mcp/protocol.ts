// A minimal, spec-compliant MCP JSON-RPC handler. A tools-only server sends no server-initiated
// messages, so Streamable HTTP collapses to "POST one JSON-RPC message, get one JSON reply" — no SSE, no
// session id. This handles exactly the methods a tools server must: initialize, tools/list, tools/call
// (plus ping and the initialized notification).

import type { TaskService } from "../core/service.ts";
import { TOOLS, TOOLS_BY_NAME } from "./tools.ts";

const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "tasks-mcp", version: "0.5.0" };

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: RpcRequest["id"], result: unknown): RpcResponse => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result,
});
const err = (
  id: RpcRequest["id"],
  code: number,
  message: string,
): RpcResponse => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

/**
 * Handle one JSON-RPC message. Returns a response object, or null for a notification (which gets no
 * reply). `service` is injected so tests drive the whole protocol against a fake environment.
 */
export async function handleRpc(
  msg: RpcRequest,
  service: TaskService,
): Promise<RpcResponse | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return err(msg?.id ?? null, -32600, "invalid JSON-RPC request");
  }

  // Notifications carry no id and expect no response.
  if (msg.method.startsWith("notifications/")) return null;

  switch (msg.method) {
    case "initialize": {
      const requested =
        (msg.params?.protocolVersion as string) || PROTOCOL_VERSION;
      return ok(msg.id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    case "ping":
      return ok(msg.id, {});

    case "tools/list":
      return ok(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments as Record<string, unknown>) || {};
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return ok(msg.id, toolError(`unknown tool: ${name}`));
      try {
        const result = await tool.handler(service, args);
        return ok(msg.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        return ok(msg.id, toolError((e as Error).message));
      }
    }

    default:
      return err(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

// A tool-execution failure is reported inside the result (isError), not as a protocol error, so the
// model sees the message and can react.
const toolError = (message: string) => ({
  content: [{ type: "text", text: message }],
  isError: true,
});
