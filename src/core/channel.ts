// The channel — how a change reaches an orchestrator session sitting idle at its prompt.
//
// ONE event exists. It is a doorbell, not a report: it says "look again" and carries no state. That
// is deliberate. Claude Code delivers channel events on the session's NEXT turn, batched, so any
// count stamped at emit time can be wrong by the time it is read. The reader calls `capacity` for
// the truth instead.
//
// Two paths, because a worker session and the orchestrator are different processes:
//   - the doorbell rings IN-PROCESS, coalescing every ring in one tick into a single event;
//   - the spool carries a ring ACROSS processes, one file per note under the repo's own directory,
//     claimed by rename so two servers draining it never both deliver one note.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { repoSlug } from "./providers/config.ts";

/** What a ring is handed to. The stdio entry wires this to the MCP channel notification. */
export type RingSink = (note: string) => void | Promise<void>;

/** The text of a ring with nothing more specific to say. */
export const DEFAULT_NOTE = "task graph changed — re-evaluate";

export class Doorbell {
  private sink?: RingSink;
  private pending = false;
  private notes: string[] = [];

  /** Wire the sink. A doorbell with no sink still coalesces and then drops — the HTTP transport and
   *  the CLI subcommands run that way, and a ring there is a no-op rather than an error. */
  on(sink: RingSink): void {
    this.sink = sink;
  }

  /** Ring once. Rings within one tick collapse into a single event, so ten tasks closing at once
   *  wake the session exactly once. */
  ring(note: string = DEFAULT_NOTE): void {
    this.notes.push(note);
    if (this.pending) return;
    this.pending = true;
    const timer = setTimeout(() => this.flush(), 0);
    timer.unref?.(); // a pending ring must never hold the process open
  }

  private flush(): void {
    this.pending = false;
    const notes = this.notes;
    this.notes = [];
    if (!this.sink || notes.length === 0) return;
    void this.sink(notes.length === 1 ? notes[0] : `${notes.length} changes — re-evaluate`);
  }
}

/** One spooled note. `from` is the poster's pid — the only thing that tells two sessions apart. */
interface SpoolEvent {
  note: string;
  at: string;
  from: number;
}

const spoolDir = (cacheDir: string, project: string): string =>
  path.join(cacheDir, "events", repoSlug(project));

/**
 * Post a wake note for every OTHER process watching this repo. The poster rings its own doorbell
 * directly, so its own note is consumed and discarded on its next drain rather than delivered twice.
 */
export function postEvent(
  cacheDir: string,
  project: string,
  note: string,
  from: number = process.pid,
): void {
  const dir = spoolDir(cacheDir, project);
  fs.mkdirSync(dir, { recursive: true });
  const event: SpoolEvent = { note, at: new Date().toISOString(), from };
  fs.writeFileSync(path.join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(event));
}

/** Take every pending note, exactly once. Notes `self` posted are consumed but not returned — the
 *  poster already rang its own doorbell, so returning them here would deliver the same ring twice. */
export function drainEvents(
  cacheDir: string,
  project: string,
  self: number = process.pid,
): string[] {
  const dir = spoolDir(cacheDir, project);
  if (!fs.existsSync(dir)) return [];
  const notes: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const event = takeEvent(path.join(dir, name));
    if (event && event.from !== self) notes.push(event.note);
  }
  return notes;
}

/** Claim one spooled note by renaming it. A failed rename means another drainer got there first. */
function takeEvent(file: string): SpoolEvent | null {
  const mine = `${file}.taken-${process.pid}`;
  try {
    fs.renameSync(file, mine);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(mine, "utf8")) as Partial<SpoolEvent>;
    if (typeof parsed.note !== "string") return null;
    return { note: parsed.note, at: parsed.at ?? "", from: parsed.from ?? -1 };
  } catch {
    return null;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}
