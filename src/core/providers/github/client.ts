// GitHub-specific resolution: the repo a project points at, the user's existing credentials, and an
// authenticated Octokit client. Everything the GitHub provider needs to reach the API, resolved from a
// project path. The client is the provider's one test seam — tests pass their own Octokit and nock
// intercepts its HTTP, so the real request/response path is always exercised.

import { spawnSync } from "node:child_process";
import { Octokit } from "octokit";
import type { ProjectConfig, RepoRef } from "../../types.ts";

/** The resolved world a GitHub operation runs against. */
export interface GitHubEnv {
  octokit: Octokit;
  repo: RepoRef;
  config: ProjectConfig;
}

/** Run a command, returning its trimmed stdout, or null when it exits non-zero (or is missing). */
function run(cmd: string, args: string[]): string | null {
  const proc = spawnSync(cmd, args, { encoding: "utf8" });
  return proc.status === 0 ? proc.stdout.trim() : null;
}

/** Read `<project>`'s `origin` remote and parse the owner/repo it points at on github.com. */
export function resolveRepo(project: string): RepoRef {
  const url = run("git", ["-C", project, "remote", "get-url", "origin"]);
  if (url === null) {
    throw new Error(
      `no git 'origin' remote in ${project} — the GitHub provider needs one`,
    );
  }
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin is not a github.com remote: ${url}`);
  return { owner: m[1], repo: m[2] };
}

/** A GitHub token from the user's existing credentials — env first, then the `gh` CLI. No new login. */
export function githubToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const token = run("gh", ["auth", "token"]) ?? "";
  if (!token)
    throw new Error(
      "no GitHub credentials: set GITHUB_TOKEN, or run `gh auth login`",
    );
  return token;
}

// One Octokit per token, reused across calls — the token is re-read each time so a rotated `gh`
// credential picks up a fresh client instead of failing on a stale one.
const clients = new Map<string, Octokit>();

/** The shared authenticated client for the user's current credentials. */
export function defaultOctokit(): Octokit {
  const token = githubToken();
  let client = clients.get(token);
  if (!client) {
    client = new Octokit({ auth: token });
    clients.set(token, client);
  }
  return client;
}
