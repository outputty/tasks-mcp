// The GitHub provider: one plug-and-play unit implementing the Provider seam. It bundles Issues (the
// primary record, via GraphQL) and the Projects v2 board (a best-effort kanban mirror). Issues must
// succeed; a Projects failure is logged and swallowed, so a board hiccup never loses a task.
//
// The resolver is injectable, so tests hand it a fake GraphQL and never touch git, gh, or the network.

import type { ProjectContext, Refs, Task } from "../../types.ts";
import type { Provider, RemoteState } from "../provider.ts";
import type { GitHubEnv } from "./client.ts";
import { resolveGitHubEnv } from "./client.ts";
import { createIssue, updateIssue, listIssues } from "./issues.ts";
import { syncToBoard, readBoard } from "./projects.ts";

export class GitHubProvider implements Provider {
  readonly name = "github";

  constructor(
    private readonly resolve: (
      project: string,
    ) => Promise<GitHubEnv> = resolveGitHubEnv,
  ) {}

  async create(ctx: ProjectContext, task: Task): Promise<Refs> {
    const env = await this.resolve(ctx.project);
    const issueId = await createIssue(env, task);
    return this.withBoard(env, task, { issueId });
  }

  async update(ctx: ProjectContext, task: Task, refs: Refs): Promise<Refs> {
    const env = await this.resolve(ctx.project);
    if (!refs.issueId) return this.create(ctx, task); // lost the ref somehow — re-create rather than orphan
    await updateIssue(env, refs.issueId, task);
    return this.withBoard(env, task, refs);
  }

  async pull(ctx: ProjectContext): Promise<Map<string, RemoteState>> {
    const env = await this.resolve(ctx.project);
    const projectsOn = env.config.projects !== false;
    // Read the board too (best-effort), so a card moved to Done flows back into the cache.
    const board = projectsOn
      ? await readBoard(env).catch(
          () => new Map<string, { itemId: string; done: boolean }>(),
        )
      : new Map();

    const out = new Map<string, RemoteState>();
    for (const issue of await listIssues(env)) {
      const card = board.get(issue.issueId);
      const issueDone = issue.status === "done";
      const done = issueDone || card?.done === true; // done if the issue is closed OR the card is in Done
      // Reconcile (push back) when the sides disagree, the card is missing, or an issue needs adopting —
      // the push makes the issue, the body block, and the board card all consistent.
      const reconcile =
        !issue.managed ||
        issueDone !== done ||
        (projectsOn && (!card || card.done !== done));
      out.set(issue.taskId, {
        patch: { title: issue.title, status: done ? "done" : "open" },
        refs: { issueId: issue.issueId, projectItem: card?.itemId },
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
