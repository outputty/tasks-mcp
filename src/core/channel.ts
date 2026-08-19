// The channel — how a change reaches an orchestrator session sitting idle at its prompt.
//
// ONE event exists. It is a doorbell, not a report: it says "look again" and carries no state. That
// is deliberate. Claude Code delivers channel events on the session's NEXT turn, batched, so any
// count stamped at emit time can be wrong by the time it is read. The reader calls `capacity` for
// the truth instead.
//
// Two paths, because a worker session and the orchestrator are different processes:
//   - the doorbell rings IN-PROCESS, coalescing every ring in one tick into a single event;
//   - the spool carries a ring ACROSS processes, one file per note under the repo's own directory.
//
// The spool is a BROADCAST, not a queue. Every session's server reads it, but only some of them have a
// channel listener behind their doorbell, so a note consumed by a worker session would be a note the
// orchestrator never sees. Reading therefore never removes a file: each reader remembers what it has
// already delivered, and the files are swept by age.
//
// It is WATCHED, not polled. A note has to reach a session that is idle, making no tool calls, and may
// have no sync loop running — so `EventLog.watch` delivers it the moment it lands. The channel must
// never depend on a flag someone remembered to set.

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
    const notes = [...new Set(this.notes)];
    this.notes = [];
    if (!this.sink || notes.length === 0) return;
    void this.sink(summarize(notes));
  }
}

/**
 * One event's text from a tick's worth of rings. It JOINS them rather than counting them: a burst is
 * exactly when the reader most needs to know what moved, and "3 changes — re-evaluate" is the doorbell
 * a reader can talk themselves out of. A long burst falls back to naming the first few and counting
 * the rest, so the event never becomes a wall of text.
 */
function summarize(notes: string[]): string {
  if (notes.length === 1) return notes[0];
  const named = notes.slice(0, 3).map(withoutTail);
  const rest = notes.length - named.length;
  const more = rest > 0 ? `; and ${rest} more` : "";
  return `${named.join("; ")}${more} — re-evaluate`;
}

/** Drop a note's trailing call to action, so joining several does not repeat it three times. */
const withoutTail = (note: string): string => note.replace(/ — re-evaluate$/, "");

/** One spooled note. `from` is the poster's pid — the only thing that tells two sessions apart. */
interface SpoolEvent {
  note: string;
  at: string;
  from: number;
}

const spoolDir = (cacheDir: string, project: string): string =>
  path.join(cacheDir, "events", repoSlug(project));

/** How long a note stays readable. It only has to outlive the gap between a session being told and
 *  acting, so this is generous; a reader that starts late gets the recent past and rings once. */
const RETENTION_MS = 5 * 60 * 1000;

/**
 * Post a wake note for every OTHER process watching this repo. The poster rings its own doorbell
 * directly, so its own note is skipped on read rather than delivered to it twice.
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

/**
 * One process's view of the spool. Reading DELIVERS, it does not consume: every other session
 * watching the same repo still gets its own copy, which is what lets a worker session read the spool
 * without swallowing the note the orchestrator was waiting for. Each log remembers the files it has
 * handed over, so a note is delivered to this process exactly once however often it reads.
 */
export class EventLog {
  private readonly dir: string;
  private readonly delivered = new Set<string>();

  constructor(
    cacheDir: string,
    project: string,
    private readonly self: number = process.pid,
  ) {
    this.dir = spoolDir(cacheDir, project);
  }

  /** Every note this process has not been given yet, oldest first. Sweeps expired files in passing. */
  read(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    const cutoff = Date.now() - RETENTION_MS;
    const notes: string[] = [];
    for (const name of fs.readdirSync(this.dir).sort()) {
      const note = this.take(name, cutoff);
      if (note !== null) notes.push(note);
    }
    return notes;
  }

  /** One file's note — null when it is not a note, is expired, was already handed over, or is one
   *  this process posted (the poster rang its own doorbell when it wrote it). */
  private take(name: string, cutoff: number): string | null {
    if (!name.endsWith(".json")) return null;
    if (this.sweep(name, cutoff)) return null;
    if (this.delivered.has(name)) return null;
    this.delivered.add(name);
    const event = readEvent(path.join(this.dir, name));
    if (!event || event.from === this.self) return null;
    return event.note;
  }

  /**
   * Deliver notes as they land. This is the PRIMARY cross-process path: no sync loop, no
   * configuration. `fs.watch` coalesces bursts and can miss an event outright on some filesystems,
   * but a miss self-heals — the next event re-reads the whole directory and hands over anything
   * unseen. Returns a stop function; the watcher is unref'd, so it never holds the process open.
   */
  watch(onNote: RingSink): () => void {
    fs.mkdirSync(this.dir, { recursive: true });
    const deliver = (): void => {
      for (const note of this.read()) void onNote(note);
    };
    const watcher = fs.watch(this.dir, deliver);
    // A watch error is all but always the directory going away (a cache wipe, a finished test). The
    // spool is best-effort transport, so this closes quietly rather than crashing an MCP server over
    // a directory that no longer exists.
    watcher.on("error", () => watcher.close());
    watcher.unref?.();
    deliver(); // whatever was spooled before the watch began
    return () => watcher.close();
  }

  /** Drop a note past its retention. Any reader may sweep: a lost race is a file already gone. */
  private sweep(name: string, cutoff: number): boolean {
    // The age is in the filename (`<epoch-ms>-<uuid>.json`), so sweeping costs no stat. An unparseable
    // name is treated as fresh — better a note that lingers than one deleted before it is read.
    const at = Number.parseInt(name, 10);
    if (!Number.isFinite(at) || at >= cutoff) return false;
    fs.rmSync(path.join(this.dir, name), { force: true });
    this.delivered.delete(name);
    return true;
  }
}

/** One spooled note, or null when the file is unreadable or the wrong shape. */
function readEvent(file: string): SpoolEvent | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SpoolEvent>;
    if (typeof parsed.note !== "string") return null;
    return { note: parsed.note, at: parsed.at ?? "", from: parsed.from ?? -1 };
  } catch {
    return null;
  }
}
