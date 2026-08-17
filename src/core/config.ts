// Configuration — its own provider class. The server carries no user preferences of its own: they are
// configured CENTRALLY through the MCP tools (`get_config` / `set_config`) and stored next to the task
// caches — one global spec that applies to every repo, overridable per repo. Precedence, weakest
// first: defaults < CLI flags < global spec < per-repo override. Every file is PARSED with zod, not
// trusted: an unknown key or a mistyped value fails loudly with the file's path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { ProjectConfig } from "./types.ts";

/** Server-wide options, set once from CLI args — deployment knobs, not user preferences. */
export interface ServerOptions {
  provider?: string;
  projects?: boolean;
  projectNumber?: number;
  board?: string;
  /** Where the file layer and the config files live. Defaults to the OS cache dir; never the repo. */
  cacheDir?: string;
}

/** The config schema — the single definition of what may be configured, globally or per repo. */
const ProjectConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    projects: z.boolean().optional(),
    projectNumber: z.number().int().positive().optional(),
    board: z.string().min(1).optional(),
    labels: z.boolean().optional(),
    labelFields: z.array(z.enum(["kind", "tier", "qa", "spec", "stage", "priority"])).optional(),
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
    return {
      ...this.flags(),
      ...readConfigFile(this.globalFile()),
      ...readConfigFile(this.repoFile(project)),
    };
  }

  /** Every layer of the configuration, for `get_config`. */
  sources(project: string): ConfigSources {
    return {
      flags: this.flags(),
      global: readConfigFile(this.globalFile()),
      repo: readConfigFile(this.repoFile(project)),
      effective: this.get(project),
    };
  }

  /** Merge a validated patch into the global spec or one repo's override; returns the new effective. */
  set(project: string, scope: "global" | "repo", patch: ProjectConfig): ProjectConfig {
    const file = scope === "global" ? this.globalFile() : this.repoFile(project);
    const next = { ...readConfigFile(file), ...parseConfig(patch, `set_config(${scope})`) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stringify(next));
    return this.get(project);
  }

  /** The CLI-flag layer, in config shape. */
  private flags(): ProjectConfig {
    return {
      ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
      ...(this.options.projects !== undefined ? { projects: this.options.projects } : {}),
      ...(this.options.projectNumber !== undefined
        ? { projectNumber: this.options.projectNumber }
        : {}),
      ...(this.options.board !== undefined ? { board: this.options.board } : {}),
    };
  }
}

function readConfigFile(file: string): ProjectConfig {
  if (!fs.existsSync(file)) return {};
  return parseConfig(parse(fs.readFileSync(file, "utf8")) ?? {}, file);
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
