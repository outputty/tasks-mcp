// The configuration provider — a provider like the rest: one class in one file, beside the layers it
// configures. The server carries no user preferences of its own: they are
// configured CENTRALLY through the MCP tools (`get_config` / `set_config`) and stored next to the task
// caches — one global spec that applies to every repo, overridable per repo. Precedence, weakest
// first: defaults < CLI flags < global spec < per-repo override. Every file is PARSED with zod, not
// trusted: an unknown key or a mistyped value fails loudly with the file's path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { ProjectConfig, ServerOptions } from "../types.ts";
import { LABEL_FIELD_NAMES } from "../types.ts";

/** The config schema — the ONE definition of what may be configured; the MCP tools reuse its shape. */
export const ProjectConfigSchema = z
  .object({
    provider: z.string().min(1).optional().describe("The remote layer backing the project."),
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

/** A project's stable file slug: `<basename>-<hash>`, keyed by the project's absolute path. */
export function projectSlug(project: string): string {
  const base = path.basename(project) || "repo";
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * The REPO a project belongs to: the primary checkout, shared by every git worktree cut from it.
 * `--git-common-dir` resolves to the primary `.git` from inside a worktree, so a worktree and the
 * checkout it came from answer the same path. Falls back to the project itself outside a repo.
 */
export function repoRoot(project: string): string {
  const proc = spawnSync(
    "git",
    ["-C", project, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  );
  if (proc.status !== 0) return project;
  const common = proc.stdout.trim();
  if (!common) return project;
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

/**
 * The slug the CROSS-SESSION event spool keys on. Worktrees must share it: a worker session raises a
 * note from its worktree while the orchestrator watches from the primary checkout, and the note has to
 * find it. Task caches stay per-path on `projectSlug`; only the spool is shared.
 */
export function repoSlug(project: string): string {
  return projectSlug(repoRoot(project));
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

  /** One repo's override, beside its task cache. */
  private repoFile(project: string): string {
    return path.join(this.dir(), `${projectSlug(project)}.config.yaml`);
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
