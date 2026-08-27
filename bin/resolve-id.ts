// The project id a CLI call acts on. An id is SUPPLIED or DECLARED, never derived from the working
// directory: deriving the id from the launch directory made every worktree a separate project. A repo
// declares its project in a `tasks.config.yaml` at its root (discovered from cwd upward, like git/eslint
// rc files); the legacy `.mcp.json` read sits below it until `delete-mcp-layer` removes it. Both the
// subcommands and the server default resolve through here, so a human at a shell and an agent in one
// directory address the same project by construction.

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { validateProjectId, ProjectConfigSchema } from "../src/core/providers/config.ts";

/** The two id flags a call may carry: `--project` (per call) overrides `--project-id` (per invocation). */
type IdOpts = { project?: string; projectId?: string };

/** The `tasks.config.yaml` shape: the config schema plus the `project` id it declares. Reusing
 *  `ProjectConfigSchema` keeps one definition of `providers`; an unknown key or a bad value fails, and a
 *  failure is treated as absence by the reader. */
const RcConfigSchema = ProjectConfigSchema.extend({
  project: z.string().min(1).optional(),
});

/**
 * The project id a call acts on, first match wins: `--project`, else `--project-id`, else the id this
 * repo's `tasks.config.yaml` declares, else the id its legacy `.mcp.json` declares; `undefined` when none
 * supplies or declares one — the server's default may legitimately be absent, and tool calls then name
 * their own project.
 *
 * `cwd` is the directory the rc/`.mcp.json` search starts from (tests pass one); omitted, it is the launch
 * directory, so nothing derives the id from the launch directory itself.
 *
 * `findProjectId({ projectId: "acme/x" })` → `"acme/x"`; `findProjectId({}, dirWithRcFile)` → its id.
 */
export function findProjectId(opts: IdOpts, cwd?: string): string | undefined {
  const explicit = opts.project ?? opts.projectId;
  if (explicit !== undefined) return validateProjectId(explicit);
  const declared = readRcId(cwd) ?? readDeclaredId(cwd);
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
  throw new Error(
    "no project id — pass --project <id>, or run where a tasks.config.yaml declares one",
  );
}

/**
 * The id a repo's `tasks.config.yaml` declares in its `project:` key, discovered from `cwd` (or the
 * launch directory) upward like git/eslint rc files — or `undefined`. A missing, malformed, or
 * `project`-less file is absence, not a crash: the whole file is validated with the config schema and any
 * failure falls through to the next source. Read only; the CLI never writes it.
 */
function readRcId(cwd?: string): string | undefined {
  const file = findUp("tasks.config.yaml", cwd);
  if (file === undefined) return undefined;
  const text = tryRead(file);
  if (text === undefined) return undefined;
  const parsed = RcConfigSchema.safeParse(tryParseYaml(text));
  return parsed.success ? parsed.data.project : undefined;
}

/** The nearest `name` at or above `from` (the launch directory by default), or undefined at the
 *  filesystem root. `findUp("tasks.config.yaml", "/repo/src")` → `/repo/tasks.config.yaml`. */
function findUp(name: string, from?: string): string | undefined {
  let dir = from ?? process.cwd();
  for (;;) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function tryParseYaml(text: string): unknown {
  try {
    return parse(text) as unknown;
  } catch {
    return undefined; // malformed tasks.config.yaml — treated as absent
  }
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
