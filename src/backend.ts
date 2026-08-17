// The swappable seam. A backend turns a project into a Task[] and accepts writes; the graph engine and
// the MCP tools never know which one they are talking to. Today there is one adapter — GitHub Issues —
// but the port is what lets a second backend land without touching scheduling or the tool surface.

import type { ProjectContext, RepoRef, Task } from "./types.ts";
import {
  GitHubIssuesBackend,
  type GitHubClient,
} from "./backends/github-issues.ts";

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
}

export interface Backend {
  list(ctx: ProjectContext): Promise<Task[]>;
  get(ctx: ProjectContext, id: string): Promise<Task | null>;
  create(ctx: ProjectContext, task: Task): Promise<Task>;
  update(ctx: ProjectContext, id: string, patch: Partial<Task>): Promise<Task>;
  close(ctx: ProjectContext, id: string): Promise<void>;
  sync(ctx: ProjectContext): Promise<SyncResult>;
}

/** What a resolved project gives the adapter: an authenticated client and the repo it points at. */
export interface Resolved {
  octokit: GitHubClient;
  repo: RepoRef;
}

/** Read `<project>/.git`'s `origin` and parse the owner/repo it points at on github.com. */
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

/**
 * A GitHub token from the user's existing credentials — env first, then the `gh` CLI. No new login: if
 * `gh auth login` has run (or GITHUB_TOKEN is set), the server is authenticated.
 */
export function githubToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const proc = Bun.spawnSync(["gh", "auth", "token"]);
  const token = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
  if (!token) {
    throw new Error(
      "no GitHub credentials: set GITHUB_TOKEN, or run `gh auth login`",
    );
  }
  return token;
}

// One Octokit per token, reused across calls. Import is lazy so the pure graph tests never load it.
const clients = new Map<string, GitHubClient>();
async function octokitFor(): Promise<GitHubClient> {
  const token = githubToken();
  let client = clients.get(token);
  if (!client) {
    const { Octokit } = await import("octokit");
    client = new Octokit({ auth: token }) as unknown as GitHubClient;
    clients.set(token, client);
  }
  return client;
}

/** The production backend: GitHub Issues, wired to the real git remote and the user's gh credentials. */
export function makeBackend(): Backend {
  return new GitHubIssuesBackend(
    async (ctx: ProjectContext): Promise<Resolved> => ({
      octokit: await octokitFor(),
      repo: resolveRepo(ctx.project),
    }),
  );
}
