// GitHub-specific resolution: the repo a project points at, the user's existing credentials, and an
// authenticated GraphQL caller. Everything the GitHub provider needs to reach the API, resolved from a
// project path. Injectable so tests supply a fake GraphQL and never touch git, gh, or the network.

import type { ProjectConfig, RepoRef } from "../../types.ts";
import { loadConfig } from "../../config.ts";

/** A GraphQL caller, the shape of `octokit.graphql`. GitHub Issues and Projects both go through this. */
export type GraphQL = <T = unknown>(
  query: string,
  vars?: Record<string, unknown>,
) => Promise<T>;

/** The resolved world a GitHub operation runs against. */
export interface GitHubEnv {
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
      `no git 'origin' remote in ${project} — the GitHub provider needs one`,
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

// One GraphQL caller per token, reused across calls. Imported lazily so the pure graph tests never load
// Octokit.
const clients = new Map<string, GraphQL>();
async function graphqlFor(): Promise<GraphQL> {
  const token = githubToken();
  let client = clients.get(token);
  if (!client) {
    const { Octokit } = await import("octokit");
    client = new Octokit({ auth: token }).graphql as unknown as GraphQL;
    clients.set(token, client);
  }
  return client;
}

/** The production resolver: real git remote, real gh credentials, real config file. */
export async function resolveGitHubEnv(project: string): Promise<GitHubEnv> {
  return {
    graphql: await graphqlFor(),
    repo: resolveRepo(project),
    config: loadConfig(project),
  };
}
