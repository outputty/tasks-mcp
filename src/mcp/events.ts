// The change stream — the /events route's two halves. `handleEvents` holds one SSE client open and
// writes a line per change; `watchCacheDir` turns another process's cache write into a change signal.
// Both feed the one ChangeBus the server already emits its OWN writes on, so a reader learns of every
// change whoever made it. Plain node:http and node:fs — no framework, no dependency.

import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { ChangeBus } from "../core/changes.ts";
import { walkProjectFiles, projectIdOf, NON_PROJECT_DIRS } from "../core/projects.ts";

/**
 * Stream `event: changed` to one SSE client for every project change, until it disconnects. The
 * payload names the project and the observation time and nothing else — the reader re-reads the local
 * graph, which is instant and cannot then be stale. Subscribes to `bus` on open and unsubscribes on
 * `res` close, so a dropped client leaks neither a listener nor a socket.
 */
export function handleEvents(bus: ChangeBus, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n"); // flush the headers so the client knows the stream is open
  const off = bus.subscribe((project) => {
    const data = JSON.stringify({ project, at: new Date().toISOString() });
    res.write(`event: changed\ndata: ${data}\n\n`);
  });
  res.on("close", () => {
    off();
    res.end();
  });
}

/**
 * Watch `cacheDir` and its project-id subfolders for ANY process's writes, calling `onChange(project)`
 * for each project whose cache file changed.
 *
 * A raw watcher event is only a HINT to re-read, never a payload: `fs.watch` coalesces bursts and, on
 * macOS, names the watched directory rather than the changed entry — so the filename cannot be trusted
 * to identify the project. Instead every event triggers a re-scan that diffs each project file's mtime
 * against a remembered snapshot, which is reliable on every platform and catches a create, an edit, and
 * a first write into a brand-new nested folder alike. One watcher per directory (no `{ recursive: true }`,
 * which Linux lacks); the returned function tears every watcher down and the caller must call it on
 * server close, or the watchers outlive the server.
 *
 * `watchCacheDir(dir, p => …)` then another process writing `dir/acme/widgets.yaml` → `onChange("acme/widgets")`.
 */
export function watchCacheDir(cacheDir: string, onChange: (project: string) => void): () => void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const watchers = new Map<string, fs.FSWatcher>();
  let snapshot = statAll(cacheDir); // existing files are the baseline, not a change
  let timer: ReturnType<typeof setTimeout> | undefined;
  function trigger(): void {
    if (timer) return; // coalesce a burst of raw events into a single re-scan
    timer = setTimeout(() => {
      timer = undefined;
      watchTree(cacheDir, watchers, trigger); // adopt any subfolder that has appeared since
      const current = statAll(cacheDir);
      for (const [id, mtime] of current) if (snapshot.get(id) !== mtime) onChange(id);
      snapshot = current;
    }, 30);
    timer.unref?.();
  }
  watchTree(cacheDir, watchers, trigger);
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}

/** Attach a watcher to `dir` and every project-id subfolder beneath it not already watched — called
 *  again on each event, so a subfolder that just appeared starts triggering re-scans of its own. */
function watchTree(dir: string, watchers: Map<string, fs.FSWatcher>, trigger: () => void): void {
  if (!watchers.has(dir)) {
    try {
      watchers.set(dir, fs.watch(dir, trigger));
    } catch {
      return; // the directory vanished before it could be watched — a later re-scan re-attempts
    }
  }
  for (const sub of subdirsOf(dir)) watchTree(sub, watchers, trigger);
}

/** The project-id subfolders of `dir` — every subdirectory except the sibling stores. */
function subdirsOf(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NON_PROJECT_DIRS.has(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Every project file's mtime keyed by project id — the snapshot a re-scan diffs to find what moved,
 *  independent of the watcher event's (unreliable, platform-specific) filename. */
function statAll(cacheDir: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const file of walkProjectFiles(cacheDir)) {
    try {
      out.set(projectIdOf(cacheDir, file), fs.statSync(file).mtimeMs);
    } catch {
      // vanished between the walk and the stat — skip
    }
  }
  return out;
}
