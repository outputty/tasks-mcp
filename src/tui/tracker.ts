// The console's data layer — an MCP CLIENT over Streamable HTTP. The console connects to a tracker this
// way whether the tracker is in its own process (the --tui default) or on another machine, so there is
// ONE implementation, never a local path and a remote path. Free of @opentui/core, so it is tested with
// a real in-process server and no terminal.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Task } from "../core/types.ts";
import { SERVER_INFO } from "../mcp/server.ts";
import type { ProjectQueue } from "./queue.ts";

/** One connected tracker: its id (the url, or `local` for the in-process one), the url, and the client.
 *  A write routes to the tracker its row came from, so the id has to be stable. */
export interface Tracker {
  id: string;
  url: string;
  client: Client;
}

/** What a probe found: the tracker's identity and the projects it holds, shown before it is saved. */
export interface ProbeResult {
  server: { name: string; version: string };
  projects: Array<{ project: string; tasks: number; in_progress: number }>;
}

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

/** The `/mcp` endpoint for a tracker's base url — what a user types (`http://host:3917`) and what
 *  console.yaml stores, turned into what the client connects to. Idempotent if `/mcp` is already there. */
export function mcpEndpoint(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
}

/**
 * Prove a URL is a tracker before it is saved: connect (the MCP handshake), then call `list_projects` —
 * NOT `/health`, which answers "a server is up" when the question is "is this a tracker". Returns the
 * server's name and version and its projects. Throws a message that names WHY on a refused connection, a
 * timeout, or a port serving something that is not MCP, so each failure reads differently.
 */
export async function probeTracker(url: string): Promise<ProbeResult> {
  let client: Client;
  try {
    client = await connectTracker(mcpEndpoint(url));
  } catch (e) {
    throw new Error(`no tracker at ${url} — ${classifyConnectError(e)}`);
  }
  try {
    const projects = (await read(client, "list_projects", {})).projects as ProbeResult["projects"];
    const info = client.getServerVersion();
    return { server: { name: info?.name ?? "?", version: info?.version ?? "?" }, projects };
  } finally {
    await client.close();
  }
}

/** Turn a connection failure into a human reason: a refused port, a timeout, or a port that answered but
 *  is not an MCP tracker — the three the add-tracker form distinguishes. `fetch` wraps a network error in
 *  a TypeError whose `cause` holds the real code, so both levels are inspected. */
export function classifyConnectError(e: unknown): string {
  const code = errorCode(e);
  const text = errorText(e);
  if (code === "ECONNREFUSED" || /econnrefused|refused/i.test(text)) return "connection refused";
  if (code === "ETIMEDOUT" || /etimedout|timed?\s?out/i.test(text)) return "timed out";
  return "not an MCP tracker";
}

function errorCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code ?? err?.cause?.code;
}

function errorText(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } };
  return [err?.message, err?.cause?.message].filter(Boolean).join(" ") || String(e);
}

/**
 * One snapshot per project from a connected tracker, tagged with `trackerId` so a row can route its
 * writes back: `list_projects`, then per project `list_tasks` (in_progress included) and `list_ready`
 * (the ready ids, and the claim start times the tracker exposes as `claims`).
 */
export async function fetchQueues(client: Client, trackerId?: string): Promise<ProjectQueue[]> {
  const projects = (await read(client, "list_projects", {})).projects as Array<{ project: string }>;
  const out: ProjectQueue[] = [];
  for (const { project } of projects) {
    const tasks = (await read(client, "list_tasks", { project })).tasks as Task[];
    const ready = await read(client, "list_ready", { project });
    const claims = ready.claims as Array<{ id: string; claimed_at: string }>;
    out.push({
      project,
      tracker: trackerId,
      tasks,
      readyIds: ready.ids as string[],
      claimedAt: claimTimes(claims),
    });
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

/** Claim start times keyed by task id, from `list_ready`'s claim rows. */
function claimTimes(claims: Array<{ id: string; claimed_at: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of claims) out[c.id] = c.claimed_at;
  return out;
}
