// Per-project configuration, provider-agnostic. Reads `.claude/tasks-mcp.config.{yaml,json}` layered
// under a couple of env overrides. Provider-specific resolution (repo, credentials) lives with each
// provider, not here.

import fs from "fs";
import path from "path";
import type { ProjectConfig } from "./types.ts";

export function loadConfig(project: string): ProjectConfig {
  let config: ProjectConfig = {};
  for (const name of ["tasks-mcp.config.yaml", "tasks-mcp.config.json"]) {
    const file = path.join(project, ".claude", name);
    if (fs.existsSync(file)) {
      config =
        (Bun.YAML.parse(fs.readFileSync(file, "utf8")) as ProjectConfig) || {};
      break;
    }
  }
  if (process.env.OUTPUTTY_PROVIDER)
    config.provider = process.env.OUTPUTTY_PROVIDER;
  if (process.env.OUTPUTTY_PROJECT_NUMBER)
    config.projectNumber = Number(process.env.OUTPUTTY_PROJECT_NUMBER);
  if (process.env.OUTPUTTY_PROJECTS === "off") config.projects = false;
  return config;
}
