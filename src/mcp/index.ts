// The MCP wrapper — takes the core service and exposes it as an MCP server on the official
// @modelcontextprotocol/sdk: the tool surface plus the two transports (stdio and Streamable HTTP over
// node:http). It depends on the core, never the other way round.

export { createMcpServer, SERVER_INFO } from "./server.ts";
export { createHttpServer, startHttpServer } from "./http.ts";
export { runStdio } from "./stdio.ts";
