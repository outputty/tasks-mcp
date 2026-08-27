// The detail screen's reads and writes — each a direct `TaskService` call, so the console reads and
// writes the core in-process and adds no path of its own. Free of @opentui/core, so the whole surface is
// tested against a real in-process service with no terminal.

import type { ProjectContext, Task, TaskPatch, TrailEntry } from "../core/types.ts";
import type { TaskService } from "../core/service.ts";
import { priorityOf, tierOf, qaOf } from "../core/graph.ts";

/** A task opened in the detail view: its record, its deps each flagged done or not, and its trail
 *  newest-first. */
export interface Detail {
  task: Task;
  deps: Array<{ id: string; done: boolean }>;
  trail: TrailEntry[];
}

/** Open a task whole: its record, every dep marked done from the project's task list, and its trail
 *  (newest-first). Throws when no task carries the id. */
export async function loadDetail(
  service: TaskService,
  ctx: ProjectContext,
  id: string,
): Promise<Detail> {
  const task = await service.get(ctx, id);
  if (!task) throw new Error(`no task ${id}`);
  const byId = new Map((await service.list(ctx)).map((t) => [t.id, t]));
  const deps = (task.deps ?? []).map((d) => ({ id: d, done: byId.get(d)?.status === "done" }));
  return { task, deps, trail: await loadTrail(service, ctx, id) };
}

/** The trail newest-first, or empty for a project with no GitHub layer — `getTrail` needs a
 *  GitHub-backed project, and a file-only project legitimately has no thread, so the detail still opens
 *  without one. */
async function loadTrail(
  service: TaskService,
  ctx: ProjectContext,
  id: string,
): Promise<TrailEntry[]> {
  try {
    return [...(await service.getTrail(ctx, id))].reverse();
  } catch {
    return [];
  }
}

/** The editable fields of a task, as the strings the edit form pre-fills. Defaults are resolved
 *  (`tierOf`/`qaOf`/`priorityOf`), so the form shows the effective value, not a blank. */
export interface EditFields {
  title: string;
  priority: string;
  tier: string;
  qa: string;
  deps: string;
}

export function editFields(task: Task): EditFields {
  return {
    title: task.title,
    priority: priorityOf(task),
    tier: String(tierOf(task)),
    qa: qaOf(task),
    deps: (task.deps ?? []).join(", "),
  };
}

/**
 * The `update` patch between a before and an after of the form — ONLY the fields that changed. `deps`
 * is a whole-list replace (a partial list would silently drop entries, since the patch REPLACES it), and
 * `tier` is parsed to a number.
 *
 * `editPatch({ ...f, tier: "3" }, { ...f, tier: "2" })` → `{ tier: 2 }`.
 */
export function editPatch(before: EditFields, after: EditFields): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (after.title !== before.title) patch.title = after.title;
  if (after.priority !== before.priority) patch.priority = after.priority;
  if (after.tier !== before.tier) patch.tier = Number(after.tier);
  if (after.qa !== before.qa) patch.qa = after.qa;
  if (after.deps !== before.deps) {
    patch.deps = after.deps
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return patch;
}

/** Apply an edit carrying only the changed fields. An empty patch is a no-op — no write at all. */
export async function applyEdit(
  service: TaskService,
  ctx: ProjectContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await service.update(ctx, id, patch as TaskPatch);
}

/** Move a task between states: start (`start`), close (`close`), or replan (`spec: replan`, which sends
 *  it back to planning). */
export async function changeState(
  service: TaskService,
  ctx: ProjectContext,
  id: string,
  to: "start" | "close" | "replan",
): Promise<void> {
  if (to === "start") return void (await service.start(ctx, id));
  if (to === "close") return service.close(ctx, id);
  await service.update(ctx, id, { spec: "replan" });
}

/** Append a trail comment and return the whole re-read thread — a trail write raises no change signal,
 *  so the detail view takes the returned trail rather than waiting for one. */
export async function addComment(
  service: TaskService,
  ctx: ProjectContext,
  id: string,
  note: string,
): Promise<TrailEntry[]> {
  return service.appendTrail(ctx, id, { note });
}

/** File a new task as an idea — `spec: drafting`, exactly what `planning` returns and what the planning
 *  stage picks up. The required task fields default to an empty, open, unscoped task. */
export async function fileIdea(
  service: TaskService,
  ctx: ProjectContext,
  id: string,
  title: string,
): Promise<void> {
  await service.create(ctx, { id, title, status: "open", deps: [], scope: [], spec: "drafting" });
}
