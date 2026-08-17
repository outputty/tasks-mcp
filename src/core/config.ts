// Configuration, provider-agnostic. Server-wide knobs come from CLI args (see bin/cli.ts) as
// `ServerOptions`; an optional per-project `.claude/tasks-mcp.config.{yaml,json}` overrides them for one
// repo. The file is PARSED with zod, not trusted: an unknown key or a mistyped value fails loudly with
// the file's path, instead of silently configuring nothing. No environment variables drive behaviour
// here (credentials aside) — the CLI is the surface.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ProjectConfig } from "./types.ts";

/** Server-wide options, set once from CLI args. A per-project config file overrides these. */
export interface ServerOptions {
  provider?: string;
  projects?: boolean;
  projectNumber?: number;
  board?: string;
  /** Where the file layer keeps its task files. Defaults to the OS cache dir; never the repo. */
  cacheDir?: string;
}

/** The config file's schema — the single definition of what a project may configure. */
const ProjectConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    projects: z.boolean().optional(),
    projectNumber: z.number().int().positive().optional(),
    board: z.string().min(1).optional(),
  })
  .strict();

/** The default cache root: `$XDG_CACHE_HOME/tasks-mcp`, else `~/.cache/tasks-mcp`. */
export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "tasks-mcp");
}

/** The per-project config: the CLI defaults, overlaid by an optional in-repo config file if present. */
export function loadConfig(project: string, options: ServerOptions = {}): ProjectConfig {
  const base: ProjectConfig = {
    provider: options.provider,
    projects: options.projects,
    projectNumber: options.projectNumber,
    board: options.board,
  };
  for (const name of ["tasks-mcp.config.yaml", "tasks-mcp.config.json"]) {
    const file = path.join(project, ".claude", name);
    if (fs.existsSync(file)) return { ...base, ...parseConfigFile(file) };
  }
  return base;
}

function parseConfigFile(file: string): ProjectConfig {
  const result = ProjectConfigSchema.safeParse(parse(fs.readFileSync(file, "utf8")) ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid config ${file} — ${issues}`);
  }
  return result.data;
}
