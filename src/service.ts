// The task service: the cache is the authority, the targets are mirrors. Reads come straight from the
// committed cache (fast, and the only place with the dependency graph). Writes update the cache first,
// then push the representable fields out to each target. The first target (Issues) is primary and must
// succeed; the rest (Projects) are best-effort, so a board hiccup never loses a task.

import type { CacheEntry, ProjectContext, Refs, Task } from "./types.ts";
import type { Env } from "./config.ts";
import type { SyncTarget } from "./sync/target.ts";
import { Cache } from "./cache.ts";
import { withDefaults } from "./graph.ts";
import { resolveEnv } from "./config.ts";
import { GitHubIssuesTarget } from "./sync/github-issues.ts";
import { GitHubProjectsTarget } from "./sync/github-projects.ts";

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
}

export interface TaskService {
  list(ctx: ProjectContext): Promise<Task[]>;
  get(ctx: ProjectContext, id: string): Promise<Task | null>;
  create(ctx: ProjectContext, task: Task): Promise<Task>;
  update(ctx: ProjectContext, id: string, patch: Partial<Task>): Promise<Task>;
  close(ctx: ProjectContext, id: string): Promise<void>;
  sync(ctx: ProjectContext): Promise<SyncResult>;
}

export class CachedTaskService implements TaskService {
  constructor(
    private readonly resolve: (project: string) => Promise<Env>,
    private readonly targets: SyncTarget[],
  ) {}

  async list(ctx: ProjectContext): Promise<Task[]> {
    return Cache.forProject(ctx.project).load();
  }

  async get(ctx: ProjectContext, id: string): Promise<Task | null> {
    return (
      Cache.forProject(ctx.project)
        .load()
        .find((t) => t.id === id) ?? null
    );
  }

  async create(ctx: ProjectContext, task: Task): Promise<Task> {
    const cache = Cache.forProject(ctx.project);
    const entries = cache.load();
    if (entries.some((e) => e.id === task.id))
      throw new Error(`task ${task.id} already exists`);
    const env = await this.resolve(ctx.project);
    const refs = await this.pushAll(env, ctx, task, {});
    entries.push({ ...task, refs });
    cache.save(entries);
    return task;
  }

  async update(
    ctx: ProjectContext,
    id: string,
    patch: Partial<Task>,
  ): Promise<Task> {
    const cache = Cache.forProject(ctx.project);
    const entries = cache.load();
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error(`no task ${id}`);
    const merged: CacheEntry = { ...entry, ...patch, id };
    const env = await this.resolve(ctx.project);
    merged.refs = await this.pushAll(
      env,
      ctx,
      stripRefs(merged),
      entry.refs ?? {},
    );
    entries[entries.indexOf(entry)] = merged;
    cache.save(entries);
    return stripRefs(merged);
  }

  async close(ctx: ProjectContext, id: string): Promise<void> {
    await this.update(ctx, id, { status: "done" });
  }

  async sync(ctx: ProjectContext): Promise<SyncResult> {
    const cache = Cache.forProject(ctx.project);
    const entries = cache.load();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const env = await this.resolve(ctx.project);
    let pulled = 0;

    // Pull the fields each target owns (issue open/closed) back into the cache, and adopt any task that
    // was created directly in a target (e.g. someone opened an outputty issue in the GitHub UI).
    for (const target of this.targets) {
      if (!target.enabled(env)) continue;
      const changes = await target.pull(env, ctx);
      for (const [id, patch] of changes) {
        const entry = byId.get(id);
        if (entry) {
          Object.assign(entry, patch);
        } else {
          const created: CacheEntry = withDefaults({ id, ...patch });
          byId.set(id, created);
          entries.push(created);
        }
        pulled++;
      }
    }

    // Push every cache task out, so missing issues/board items get created. Idempotent.
    let pushed = 0;
    for (const entry of entries) {
      entry.refs = await this.pushAll(
        env,
        ctx,
        stripRefs(entry),
        entry.refs ?? {},
      );
      pushed++;
    }

    cache.save(entries);
    return { pulled, pushed, conflicts: 0 };
  }

  // Push a task to every enabled target, merging the refs each returns. The primary target's failure is
  // fatal; a secondary target's is a warning, because the task already exists as an issue.
  private async pushAll(
    env: Env,
    ctx: ProjectContext,
    task: Task,
    refs: Refs,
  ): Promise<Refs> {
    let merged = { ...refs };
    for (let i = 0; i < this.targets.length; i++) {
      const target = this.targets[i];
      if (!target.enabled(env)) continue;
      try {
        merged = { ...merged, ...(await target.push(env, ctx, task, merged)) };
      } catch (err) {
        if (i === 0) throw err;
        console.error(
          `tasks-mcp: ${target.name} sync skipped for ${task.id}: ${(err as Error).message}`,
        );
      }
    }
    return merged;
  }
}

const stripRefs = (entry: CacheEntry): Task => {
  const { refs: _refs, ...task } = entry;
  return task;
};

/** The production service: committed cache, GitHub Issues (primary), GitHub Projects (best-effort). */
export function makeService(): TaskService {
  const issues = new GitHubIssuesTarget();
  const projects = new GitHubProjectsTarget((env, id) =>
    issues.issueNodeId(env, id),
  );
  return new CachedTaskService(resolveEnv, [issues, projects]);
}
