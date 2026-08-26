// The configuration provider — a provider like the rest: one class in one file, beside the layers it
// configures. The server carries no user preferences of its own: they are
// configured CENTRALLY through the MCP tools (`get_config` / `set_config`) and stored next to the task
// caches — one global spec that applies to every repo, overridable per repo. Precedence, weakest
// first: defaults < CLI flags < global spec < per-repo override. Every file is PARSED with zod, not
// trusted: an unknown key or a mistyped value fails loudly with the file's path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { ProjectConfig, ServerOptions } from "../types.ts";
import { LABEL_FIELD_NAMES } from "../types.ts";

/** The config schema — the ONE definition of what may be configured; the MCP tools reuse its shape. */
export const ProjectConfigSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .optional()
      .describe("The remote layer backing the project (singular)."),
    providers: z
      .array(z.string().min(1))
      .optional()
      .describe("Remote layers backing the project, deepest last (default [provider ?? github])."),
    repo: z
      .string()
      .min(1)
      .optional()
      .describe("GitHub coordinates owner/repo; defaults to the launch cwd's origin."),
    projects: z.boolean().optional().describe("Projects v2 board sync on/off (default on)."),
    projectNumber: z.number().int().positive().optional().describe("Target an existing board."),
    board: z.string().min(1).optional().describe("Board title to find or create (default Tasks)."),
    labels: z
      .boolean()
      .optional()
      .describe("Wear execution properties as GitHub labels (default on)."),
    labelFields: z
      .array(z.enum(LABEL_FIELD_NAMES))
      .optional()
      .describe("Which fields become labels (default: all)."),
    claimStaleMinutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Minutes of silence before a claim is reported stale (default 15)."),
  })
  .strict();

/** Every layer of the configuration, for inspection. */
export interface ConfigSources {
  flags: ProjectConfig;
  global: ProjectConfig;
  repo: ProjectConfig;
  effective: ProjectConfig;
}

/** The default cache root: `$XDG_CACHE_HOME/tasks-mcp`, else `~/.cache/tasks-mcp`. */
export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "tasks-mcp");
}

/**
 * A supplied project id, checked. It is opaque — never resolved against a provider or the filesystem —
 * but it becomes a path segment under the cache dir, so a `..` component would let it escape; that is
 * refused. Everything else (an `owner/repo` id, or even an absolute path from a pre-id caller) is a
 * valid id and nests harmlessly. Returns the id unchanged so a faithful echo round-trips.
 *
 * `validateProjectId("../../etc/passwd")` → throws; `validateProjectId("outputty/tasks-mcp")` → same.
 */
export function validateProjectId(id: string): string {
  if (!id.trim()) throw new Error("a project id may not be empty");
  if (id.split(/[/\\]/).includes("..")) {
    throw new Error(`invalid project id '${id}' — an id may not contain path traversal`);
  }
  return id;
}

/**
 * The cache file for a project: `<root>/<id><suffix>`, the id used VERBATIM so the directory is
 * human-readable and (in the next target) enumerable — an id with `/` nests into folders. Refuses an
 * id that would escape `root`: an absolute pre-id path nests harmlessly, but a `..` or rooted escape
 * is rejected. This is the one place a supplied id becomes a filesystem path, so it is the guard.
 *
 * `cachePath("/cache", "acme/widgets", ".yaml")` → `/cache/acme/widgets.yaml`.
 */
export function cachePath(root: string, id: string, suffix: string): string {
  const file = path.join(root, `${id}${suffix}`);
  const base = path.resolve(root);
  const resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`invalid project id '${id}' — it would escape the cache directory`);
  }
  return file;
}

export class ConfigProvider {
  constructor(private readonly options: ServerOptions = {}) {}

  private dir(): string {
    return this.options.cacheDir ?? defaultCacheDir();
  }

  /** The global spec, applying to every repo. */
  private globalFile(): string {
    return path.join(this.dir(), "config.yaml");
  }

  /** One project's config override, beside its task cache: `<cacheDir>/<id>.config.yaml`. */
  private repoFile(project: string): string {
    return cachePath(this.dir(), project, ".config.yaml");
  }

  /** The effective config for a project: defaults < CLI flags < global spec < per-repo override. */
  get(project: string): ProjectConfig {
    return this.sources(project).effective;
  }

  /** Every layer of the configuration, for `get_config`. */
  sources(project: string): ConfigSources {
    const flags = this.flags();
    const global = readConfigFile(this.globalFile());
    const repo = readConfigFile(this.repoFile(project));
    return { flags, global, repo, effective: { ...flags, ...global, ...repo } };
  }

  /** Merge a validated patch into the global spec or one repo's override; returns the new effective. */
  set(project: string, scope: "global" | "repo", patch: ProjectConfig): ProjectConfig {
    const file = scope === "global" ? this.globalFile() : this.repoFile(project);
    const next = { ...readConfigFile(file), ...parseConfig(patch, `set_config(${scope})`) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stringify(next));
    fileCache.delete(file); // an in-process write always re-reads, whatever the mtime resolution
    return this.get(project);
  }

  /** The CLI-flag layer, in config shape. cacheDir and syncInterval are deployment knobs, not
   *  preferences, so they never reach the config surface. */
  private flags(): ProjectConfig {
    const { cacheDir: _cacheDir, syncInterval: _syncInterval, ...flags } = this.options;
    return flags;
  }
}

// Config files are read on every operation so central changes propagate live; the mtime memo makes
// that a stat() instead of a read + YAML parse + zod parse when nothing changed.
const fileCache = new Map<string, { mtimeMs: number; value: ProjectConfig }>();

function readConfigFile(file: string): ProjectConfig {
  if (!fs.existsSync(file)) {
    fileCache.delete(file);
    return {};
  }
  const mtimeMs = fs.statSync(file).mtimeMs;
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  const value = parseConfig(parse(fs.readFileSync(file, "utf8")) ?? {}, file);
  fileCache.set(file, { mtimeMs, value });
  return value;
}

function parseConfig(value: unknown, where: string): ProjectConfig {
  const result = ProjectConfigSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid config ${where} — ${issues}`);
  }
  return result.data;
}
