// The MCP wrapper — takes the core service and exposes it as an MCP server: the tool surface, the
// JSON-RPC handler, and the two transports (stdio and node:http). It depends on the core, never the
// other way round.

export {
  handleRpc,
  SERVER_INFO,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.ts";
export { TOOLS, TOOLS_BY_NAME, type Tool } from "./tools.ts";
export { createHttpServer } from "./http.ts";
export { runStdio } from "./stdio.ts";
