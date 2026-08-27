// The project id a CLI call acts on. An id is SUPPLIED or DECLARED, never derived from the working
// directory: deriving the id from the launch directory made every worktree a separate project. Both the
// subcommands and the MCP-server default resolve through here, so a human at a shell and an agent in one
// directory address the same project by construction.

import fs from "node:fs";
import path from "node:path";
import { validateProjectId } from "../src/core/providers/config.ts";

/** The two id flags a call may carry: `--project` (per call) overrides `--project-id` (per invocation). */
type IdOpts = { project?: string; projectId?: string };

/**
 * The project id a call acts on, first match wins: `--project`, else `--project-id`, else the id this
 * repo's `.mcp.json` declares; `undefined` when none supplies or declares one — the server's default
 * may legitimately be absent, and tool calls then name their own project.
 *
 * `cwd` locates the `.mcp.json` for tests; omitted, the file is read relative to the launch directory,
 * so nothing derives the id from the launch directory itself.
 *
 * `findProjectId({ projectId: "acme/x" })` → `"acme/x"`; `findProjectId({}, dirWithMcpJson)` → its id.
 */
export function findProjectId(opts: IdOpts, cwd?: string): string | undefined {
  const explicit = opts.project ?? opts.projectId;
  if (explicit !== undefined) return validateProjectId(explicit);
  const declared = readDeclaredId(cwd);
  return declared === undefined ? undefined : validateProjectId(declared);
}

/**
 * As `findProjectId`, but a subcommand MUST name its project, so nothing resolving is a loud failure
 * naming the flag rather than a silent second identity.
 *
 * `resolveProjectId({}, bareDir)` → throws "no project id — pass --project <id>, …".
 */
export function resolveProjectId(opts: IdOpts, cwd?: string): string {
  const id = findProjectId(opts, cwd);
  if (id !== undefined) return id;
  throw new Error("no project id — pass --project <id>, or run where a .mcp.json declares one");
}

/**
 * The id a repo's `.mcp.json` declares in a tasks-mcp server's `--project-id` launch arg, or `undefined`.
 * Reads the MCP CLIENT's own config — matched by the args carrying `--project-id`, never by the server's
 * key name (whoever wrote the file chose it) — and never writes it. A missing, malformed, or id-less
 * file is absence, not a crash, per the defensive-parsing rule for external data at this boundary.
 */
function readDeclaredId(cwd?: string): string | undefined {
  const file = cwd === undefined ? ".mcp.json" : path.join(cwd, ".mcp.json");
  const text = tryRead(file);
  if (text === undefined) return undefined;
  return idFromServers(tryParseJson(text));
}

/** The first `--project-id` value across a parsed `.mcp.json`'s `mcpServers`, or `undefined`. */
function idFromServers(parsed: unknown): string | undefined {
  const servers = (parsed as { mcpServers?: Record<string, unknown> } | undefined)?.mcpServers;
  if (!servers || typeof servers !== "object") return undefined;
  for (const entry of Object.values(servers)) {
    const id = idFromArgs((entry as { args?: unknown } | undefined)?.args);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** The value after `--project-id` in a server's args, or `undefined` if the flag or its value is absent. */
function idFromArgs(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  const i = args.indexOf("--project-id");
  if (i === -1) return undefined;
  const value = args[i + 1] as unknown;
  return typeof value === "string" ? value : undefined;
}

function tryRead(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined; // missing or unreadable .mcp.json — treated as absent
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // malformed .mcp.json — treated as absent
  }
}
