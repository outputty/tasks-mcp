// The GitHub provider: one plug-and-play unit implementing the Provider seam, wrapping one Octokit
// client. It bundles Issues (the primary record) and the Projects v2 board (a best-effort kanban
// mirror), both over GraphQL — the board has no complete REST API, and one protocol keeps one kind of
// handle (node ids) end to end. Issues must succeed; a Projects failure is logged and swallowed, so a
// board hiccup never loses a task.
//
// The client is the one test seam: tests construct the provider with their own Octokit (throttling
// off) and nock intercepts its HTTP — git, gh, and the request path all stay real.

import type { Octokit } from "octokit";
import type { ProjectContext, Refs, Task } from "../../types.ts";
import type { ServerOptions } from "../../config.ts";
import { loadConfig } from "../../config.ts";
import type { Provider, RemoteState } from "../provider.ts";
import type { GitHubEnv } from "./client.ts";
import { defaultOctokit, resolveRepo } from "./client.ts";
import { createIssue, updateIssue, listIssues } from "./issues.ts";
import { syncToBoard, readBoard } from "./projects.ts";

export class GitHubProvider implements Provider {
  readonly name = "github";
  private readonly octokit: Octokit;
  // Repo resolution spawns git; remember it per project path for the provider's lifetime.
  private readonly repos = new Map<string, GitHubEnv["repo"]>();

  constructor(
    private readonly options: ServerOptions = {},
    octokit?: Octokit,
  ) {
    this.octokit = octokit ?? defaultOctokit();
  }

  /** The resolved world one call runs against: this client, the project's repo, its config. */
  private env(project: string): GitHubEnv {
    let repo = this.repos.get(project);
    if (!repo) {
      repo = resolveRepo(project);
      this.repos.set(project, repo);
    }
    return {
      octokit: this.octokit,
      repo,
      config: loadConfig(project, this.options),
    };
  }

  async create(ctx: ProjectContext, task: Task): Promise<Refs> {
    const env = this.env(ctx.project);
    const issueId = await createIssue(env, task);
    return this.withBoard(env, task, { issueId });
  }

  async update(ctx: ProjectContext, task: Task, refs: Refs): Promise<Refs> {
    const env = this.env(ctx.project);
    if (!refs.issueId) return this.create(ctx, task); // lost the ref somehow — re-create rather than orphan
    await updateIssue(env, refs.issueId, task);
    return this.withBoard(env, task, refs);
  }

  async pull(ctx: ProjectContext): Promise<Map<string, RemoteState>> {
    const env = this.env(ctx.project);
    const projectsOn = env.config.projects !== false;
    // Read the board too (best-effort), so a card moved to Done flows back into the cache.
    const board = projectsOn
      ? await readBoard(env).catch(
          () => new Map<string, { itemId: string; done: boolean }>(),
        )
      : new Map();

    const out = new Map<string, RemoteState>();
    for (const { task, issueId, managed } of await listIssues(env)) {
      const card = board.get(issueId);
      const issueDone = task.status === "done";
      const done = issueDone || card?.done === true; // done if the issue is closed OR the card is in Done
      // Reconcile (push back) when the sides disagree, the card is missing, or an issue needs adopting —
      // the push makes the issue, the body block, and the board card all consistent.
      const reconcile =
        !managed ||
        issueDone !== done ||
        (projectsOn && (!card || card.done !== done));
      // The patch is the whole task rebuilt from the body (deps included), with status reconciled.
      out.set(task.id, {
        patch: { ...task, status: done ? "done" : "open" },
        refs: { issueId, projectItem: card?.itemId },
        reconcile,
      });
    }
    return out;
  }

  // Best-effort board sync: never let a Projects failure fail the whole task write.
  private async withBoard(
    env: GitHubEnv,
    task: Task,
    refs: Refs,
  ): Promise<Refs> {
    if (env.config.projects === false || !refs.issueId) return refs;
    try {
      const projectItem = await syncToBoard(
        env,
        refs.issueId,
        refs.projectItem,
        task.status,
      );
      return { ...refs, projectItem };
    } catch (err) {
      console.error(
        `tasks-mcp: github-projects sync skipped for ${task.id}: ${(err as Error).message}`,
      );
      return refs;
    }
  }
}
