// Enumerate the projects a cache directory holds — the one read that answers about the SERVER rather
// than one project. Every other read takes a project id; this walks the cache tree the file layer
// writes (`<cacheDir>/<id>.yaml`, the id verbatim, so an `owner/repo` id nests into folders) and counts
// each file's tasks by status. No provider, no network — it matches every other read by staying local.

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { Status } from "./types.ts";

/**
 * One project's line on the server's roster: its id and its task counts by status, plus when the cache
 * last changed. `updated_at` is the cache file's mtime — the cheapest honest answer, so a project
 * edited only on GitHub reads an older stamp until the next sync. `tasks` is the total record count
 * (targets included); in a well-formed file it equals `open + in_progress + done`.
 */
export interface ProjectSummary {
  project: string;
  tasks: number;
  open: number;
  in_progress: number;
  done: number;
  updated_at: string;
}

/** Directories under the cache root that never hold a project file — the sibling stores (`claims`, and
 *  the legacy `events` spool). Both the walk here and the change watcher skip them, so they share one
 *  definition rather than drifting. */
export const NON_PROJECT_DIRS = new Set(["claims", "events"]);

/**
 * Every project the cache directory holds, sorted by id so a console's list never reorders itself
 * between calls. A missing cache directory is not an error — it means no project yet, so the result is
 * empty. Unparseable files and non-project files (a config file, a file with no `tasks:` key) are
 * skipped, so one bad file never takes the listing down.
 *
 * `readProjectSummaries("/empty")` → `[]`.
 */
export function readProjectSummaries(cacheDir: string): ProjectSummary[] {
  const rows: ProjectSummary[] = [];
  for (const file of walkProjectFiles(cacheDir)) {
    const row = summarize(file);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => (a.project < b.project ? -1 : 1));
}

/**
 * Every project cache file under `dir`, recursing through project-id subfolders. A `.config.yaml` is a
 * config file, not a project, so it is excluded here rather than parsed and rejected later. The change
 * watcher and the project reader share this one walk, so both agree on which files are projects.
 */
export function* walkProjectFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // the dir does not exist, or vanished mid-walk (the cache is written by other processes)
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NON_PROJECT_DIRS.has(entry.name)) yield* walkProjectFiles(full);
    } else if (entry.name.endsWith(".yaml") && !entry.name.endsWith(".config.yaml")) {
      yield full;
    }
  }
}

/**
 * The project id a cache file declares, or null when the file has no `project:` key (a pre-identity
 * orphan) or cannot be read or parsed. The project reader and the change watcher both call this, so
 * both skip the same files; the id is trusted verbatim even where it disagrees with the file's own
 * location, because a moved or hand-edited file is not a corruption.
 *
 * `declaredProjectId("<cacheDir>/acme/widgets.yaml")` → `"acme/widgets"`; an old-shape file → `null`.
 */
export function declaredProjectId(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // vanished between the walk and the read — skip
  }
  return parseProjectDoc(text)?.project ?? null;
}

/** One file's summary, or null if it is unreadable, unparseable, or not a live project file. */
function summarize(file: string): ProjectSummary | null {
  let text: string;
  let mtimeMs: number;
  try {
    text = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null; // vanished between the walk and the read — skip, the listing survives
  }
  const doc = parseProjectDoc(text);
  if (!doc) return null;
  const counts = { open: 0, in_progress: 0, done: 0 };
  for (const t of doc.tasks) {
    if (t.status === "open" || t.status === "in_progress" || t.status === "done")
      counts[t.status]++;
  }
  return {
    project: doc.project,
    tasks: doc.tasks.length,
    ...counts,
    updated_at: new Date(mtimeMs).toISOString(),
  };
}

/** A cache file's declared id and its task records, or null when it is not a live project file — the
 *  `project:` key (a pre-identity orphan lacks it) AND the `tasks:` array must both be present. A
 *  config file (no `tasks:`) and malformed YAML both return null and are skipped. */
function parseProjectDoc(
  text: string,
): { project: string; tasks: Array<{ status?: Status }> } | null {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { project, tasks } = parsed as { project?: unknown; tasks?: unknown };
  if (typeof project !== "string" || project.length === 0) return null;
  if (!Array.isArray(tasks)) return null;
  return { project, tasks: tasks as Array<{ status?: Status }> };
}
