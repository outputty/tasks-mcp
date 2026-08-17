// Resolving a project into everything a sync target needs: the repo it points at, an authenticated
// GitHub client (REST + GraphQL), and the per-project settings. Kept apart from the targets so tests can
// inject a fake environment and never touch git, gh, or the network.

import fs from "fs";
import path from "path";
import type { ProjectConfig, RepoRef } from "./types.ts";
import type { GitHubClient } from "./sync/github-issues.ts";

/** A GraphQL caller, the shape of `octokit.graphql`. Projects v2 is GraphQL-only. */
export type GraphQL = <T = unknown>(
  query: string,
  vars?: Record<string, unknown>,
) => Promise<T>;

/** The resolved world a task operation runs against. */
export interface Env {
  octokit: GitHubClient;
  graphql: GraphQL;
  repo: RepoRef;
  config: ProjectConfig;
}

/** Read `<project>`'s `origin` remote and parse the owner/repo it points at on github.com. */
export function resolveRepo(project: string): RepoRef {
  const proc = Bun.spawnSync([
    "git",
    "-C",
    project,
    "remote",
    "get-url",
    "origin",
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `no git 'origin' remote in ${project} — the GitHub backend needs one`,
    );
  }
  const url = proc.stdout.toString().trim();
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin is not a github.com remote: ${url}`);
  return { owner: m[1], repo: m[2] };
}

/** A GitHub token from the user's existing credentials — env first, then the `gh` CLI. No new login. */
export function githubToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const proc = Bun.spawnSync(["gh", "auth", "token"]);
  const token = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
  if (!token)
    throw new Error(
      "no GitHub credentials: set GITHUB_TOKEN, or run `gh auth login`",
    );
  return token;
}

/** Read `<project>/.claude/tasks-mcp.config.{yaml,json}`, layered under env overrides. All optional. */
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
  if (process.env.OUTPUTTY_PROJECT_NUMBER)
    config.projectNumber = Number(process.env.OUTPUTTY_PROJECT_NUMBER);
  if (process.env.OUTPUTTY_PROJECTS === "off") config.projects = false;
  return config;
}

// One Octokit per token, reused across calls. Imported lazily so the pure graph tests never load it.
const clients = new Map<string, { octokit: GitHubClient; graphql: GraphQL }>();
async function clientFor(): Promise<{
  octokit: GitHubClient;
  graphql: GraphQL;
}> {
  const token = githubToken();
  let client = clients.get(token);
  if (!client) {
    const { Octokit } = await import("octokit");
    const oct = new Octokit({ auth: token });
    client = {
      octokit: oct as unknown as GitHubClient,
      graphql: oct.graphql as unknown as GraphQL,
    };
    clients.set(token, client);
  }
  return client;
}

/** The production resolver: real git remote, real gh credentials, real config file. */
export async function resolveEnv(project: string): Promise<Env> {
  const { octokit, graphql } = await clientFor();
  return {
    octokit,
    graphql,
    repo: resolveRepo(project),
    config: loadConfig(project),
  };
}
