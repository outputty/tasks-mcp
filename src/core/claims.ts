// The claim ledger — how a dead worker's claim stops hiding work forever.
//
// `start_task` takes a task out of `list_ready` so nothing dispatches it twice. That is exactly right
// while the worker lives, and exactly wrong once it dies: the task stays `in_progress`, the queue is
// one task narrower, and nothing distinguishes "progressing" from "the terminal was closed last
// night". The old detector lived outside the server — an orchestrator pane cross-referenced claims
// against the panes it had started — and it cannot survive a dispatcher whose workers are background
// agents with no pane to enumerate.
//
// So liveness moves onto the claim itself. A claim carries two stamps: when it was taken, and when it
// was last heard from. Nothing new has to be called to refresh the second one — a build already writes
// a trail note per layer, and that write IS the heartbeat. A claim nobody has refreshed for longer
// than the threshold is reported as stale; it is never auto-released, because releasing a claim whose
// worker is merely slow would let a second worker claim the same task, which is the one race
// `start_task` exists to prevent.
//
// The ledger is LOCAL and keyed on the PROJECT ID, like every other store: a build child claims from
// inside its own worktree while the dispatcher sweeps from the primary checkout, and they resolve to
// one file because they share one supplied id (the `--project-id` in the checked-in `.mcp.json`) —
// no git resolution of a worktree back to its primary. It is deliberately not a task field: a
// heartbeat per layer would rewrite the GitHub issue body on every beat, and liveness of a local
// process is not project truth.

import fs from "node:fs";
import path from "node:path";
import { cachePath } from "./providers/config.ts";

/** One live claim: who holds a task, and when it was last heard from. */
export interface Claim {
  id: string;
  /** When `start_task` took the claim (ISO 8601). */
  claimed_at: string;
  /** When the holder last wrote through the server (ISO 8601). */
  heartbeat_at: string;
}

/** A claim past the staleness threshold, with the age that makes it one. */
export interface StaleClaim extends Claim {
  /** Whole minutes since the last heartbeat. */
  stale_for_minutes: number;
}

/**
 * How long a claim may go unheard before it is reported stale. A build writes a trail note per layer
 * and a layer under an hour is ordinary, so this threshold says "quiet", never "slow" — which is why
 * crossing it flags rather than releases.
 */
export const DEFAULT_STALE_MINUTES = 15;

const claimFile = (cacheDir: string, project: string): string =>
  cachePath(path.join(cacheDir, "claims"), project, ".json");

/** Whole minutes between two instants, floored at zero — a clock that jumped back is not negative age. */
export const minutesSince = (at: string, now: number): number => {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((now - then) / 60_000));
};

/**
 * One repo's claim ledger. Every mutation is a read-modify-write of one small JSON file: the ledger
 * holds only in-progress tasks, so it stays a handful of rows, and a lost race costs one heartbeat
 * rather than a claim (the next write re-stamps it).
 */
export class ClaimStore {
  private readonly file: string;

  constructor(cacheDir: string, project: string) {
    this.file = claimFile(cacheDir, project);
  }

  /** Every claim the ledger holds. */
  all(): Claim[] {
    return Object.values(this.read());
  }

  /**
   * Record that a task is being worked. A first claim stamps both times; a repeat only moves the
   * heartbeat, so re-marking an existing claim never rewrites when the work actually started.
   */
  mark(id: string): void {
    const claims = this.read();
    const now = new Date().toISOString();
    const held = claims[id];
    claims[id] = { id, claimed_at: held?.claimed_at ?? now, heartbeat_at: now };
    this.write(claims);
  }

  /** Refresh a claim that exists. A write against an unclaimed task is a no-op, never a new claim —
   *  a trail note on an open task says nothing about anyone working it. */
  touch(id: string): void {
    if (!this.read()[id]) return;
    this.mark(id);
  }

  /** Drop a claim. Called when a task stops being in progress: closed, replanned, or reopened. */
  release(id: string): void {
    const claims = this.read();
    if (!claims[id]) return;
    delete claims[id];
    this.write(claims);
  }

  /** The claims nobody has refreshed inside the threshold, oldest silence first. */
  stale(minutes: number = DEFAULT_STALE_MINUTES, now: number = Date.now()): StaleClaim[] {
    return this.all()
      .map((claim) => ({ ...claim, stale_for_minutes: minutesSince(claim.heartbeat_at, now) }))
      .filter((claim) => claim.stale_for_minutes >= minutes)
      .sort((a, b) => b.stale_for_minutes - a.stale_for_minutes);
  }

  /** The ledger as stored. An unreadable or half-written file reads as empty: a lost ledger costs the
   *  staleness signal, and must never take down the tool call that touched it. */
  private read(): Record<string, Claim> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, Claim>;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private write(claims: Record<string, Claim>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(claims, null, 2));
  }
}
