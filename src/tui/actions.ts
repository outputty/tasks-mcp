// The detail screen's reads and writes — every one an existing MCP tool call, so the console adds no
// write path of its own and never reaches into TaskStack. Free of @opentui/core, so the whole write
// surface is tested against a real in-process tracker with no terminal.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Task, TrailEntry } from "../core/types.ts";
import { priorityOf, tierOf, qaOf } from "../core/graph.ts";

/** One tool call's structured result; throws with the tool's own message when the call reports an error,
 *  so a rejected edit surfaces rather than being silently dropped. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ text?: string }>;
  };
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text ?? "tool error"}`);
  return res.structuredContent ?? {};
}

/** A task opened in the detail view: its record, its deps each flagged done or not, and its trail
 *  newest-first. */
export interface Detail {
  task: Task;
  deps: Array<{ id: string; done: boolean }>;
  trail: TrailEntry[];
}

/** Open a task whole: `get_task` for the record, `list_tasks` to mark each dep done, `get_trail` for the
 *  thread (reversed to newest-first). Throws when no task carries the id. */
export async function loadDetail(client: Client, project: string, id: string): Promise<Detail> {
  const task = (await call(client, "get_task", { project, id })).task as Task | null;
  if (!task) throw new Error(`no task ${id}`);
  const all = (await call(client, "list_tasks", { project })).tasks as Task[];
  const byId = new Map(all.map((t) => [t.id, t]));
  const deps = (task.deps ?? []).map((d) => ({ id: d, done: byId.get(d)?.status === "done" }));
  return { task, deps, trail: await loadTrail(client, project, id) };
}

/** The trail newest-first, or empty for a project with no GitHub layer — get_trail needs a GitHub-backed
 *  project, and a file-only project legitimately has no thread, so the detail still opens without one. */
async function loadTrail(client: Client, project: string, id: string): Promise<TrailEntry[]> {
  try {
    const trail = (await call(client, "get_trail", { project, id })).trail as TrailEntry[];
    return [...trail].reverse();
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
 * The `edit_task` patch between a before and an after of the form — ONLY the fields that changed. `deps`
 * is a whole-list replace (a partial list would silently drop entries, since edit_task REPLACES it), and
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

/** Send an edit_task carrying only the changed fields. An empty patch is a no-op — no call at all. */
export async function applyEdit(
  client: Client,
  project: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await call(client, "edit_task", { project, id, ...patch });
}

/** Move a task between states through the existing tools: start (start_task), close (close_task), or
 *  replan (edit_task spec:replan, which sends it back to planning). */
export async function changeState(
  client: Client,
  project: string,
  id: string,
  to: "start" | "close" | "replan",
): Promise<void> {
  if (to === "start") return void (await call(client, "start_task", { project, id }));
  if (to === "close") return void (await call(client, "close_task", { project, id }));
  await call(client, "edit_task", { project, id, spec: "replan" });
}

/** Append a trail comment and RE-READ the trail — a trail write raises no /events change, so the detail
 *  view fetches the new thread itself rather than waiting for an event that never comes. */
export async function addComment(
  client: Client,
  project: string,
  id: string,
  note: string,
): Promise<TrailEntry[]> {
  await call(client, "append_trail", { project, id, note });
  return (await call(client, "get_trail", { project, id })).trail as TrailEntry[];
}

/** File a new task as an idea — `spec: drafting`, which is exactly what `list_planning` returns and what
 *  the planning stage picks up. */
export async function fileIdea(
  client: Client,
  project: string,
  id: string,
  title: string,
): Promise<void> {
  await call(client, "add_task", { project, id, title, spec: "drafting" });
}
