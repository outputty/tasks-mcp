// The console's data layer — an MCP CLIENT over Streamable HTTP. The console connects to a tracker this
// way whether the tracker is in its own process (the --tui default) or on another machine, so there is
// ONE implementation, never a local path and a remote path. Free of @opentui/core, so it is tested with
// a real in-process server and no terminal.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Task } from "../core/types.ts";
import { SERVER_INFO } from "../mcp/server.ts";
import type { ProjectQueue } from "./queue.ts";

/**
 * Connect to a tracker as an MCP client over its `/mcp` endpoint. The caller closes the returned client
 * on quit. Same path for a local or a remote tracker — the console has no second, in-process shortcut.
 *
 * `connectTracker("http://127.0.0.1:53211/mcp")` → a connected Client.
 */
export async function connectTracker(url: string): Promise<Client> {
  const client = new Client({ name: `${SERVER_INFO.name}-tui`, version: SERVER_INFO.version });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/**
 * One snapshot per project from a connected tracker: `list_projects`, then per project `list_tasks`
 * (full records, in_progress included) and `list_ready` (the ready ids, and the claim start times the
 * tracker exposes as `stale_claims`). `queueRows` filters these into the view's rows.
 */
export async function fetchQueues(client: Client): Promise<ProjectQueue[]> {
  const projects = (await read(client, "list_projects", {})).projects as Array<{ project: string }>;
  const out: ProjectQueue[] = [];
  for (const { project } of projects) {
    const tasks = (await read(client, "list_tasks", { project })).tasks as Task[];
    const ready = await read(client, "list_ready", { project });
    const stale = ready.stale_claims as Array<{ id: string; claimed_at: string }>;
    out.push({ project, tasks, readyIds: ready.ids as string[], claimedAt: claimTimes(stale) });
  }
  return out;
}

/** One tool call's structured result. */
async function read(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  return (res as { structuredContent: Record<string, unknown> }).structuredContent;
}

/** Claim start times keyed by task id, from `list_ready`'s stale-claim rows. */
function claimTimes(stale: Array<{ id: string; claimed_at: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of stale) out[c.id] = c.claimed_at;
  return out;
}
