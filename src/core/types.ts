// The task model, ported from outputty's tasks.js. A backend produces and consumes these; the graph
// engine reasons over them. Every field except id/title/status is optional so a plain todo and a full
// outputty task share one shape.

// The value domains, each stated ONCE — the types, the validators, the zod schemas, and the GitHub
// label parser all derive from these arrays.
export const SPEC_STATES = ["drafting", "settled", "replan"] as const;
export const QA_LEVELS = ["skip", "inline", "subagent"] as const;
export const PRIORITIES = ["high", "normal", "low"] as const;
export const TIERS = [1, 2, 3, 4] as const;
export const LABEL_FIELD_NAMES = ["kind", "tier", "qa", "spec", "stage", "priority"] as const;
// The kinds of thing a trail entry records — a decision made, an action taken, or a bare note. Stated
// once here; the type, the zod enum, and the store's validator all derive from it.
export const TRAIL_KINDS = ["decision", "action", "note"] as const;

export type SpecState = (typeof SPEC_STATES)[number];
export type QaLevel = (typeof QA_LEVELS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type TrailKind = (typeof TRAIL_KINDS)[number];

export interface Attempt {
  tried: string;
  killed_by: string;
}

/**
 * One entry in a task's trail: the append-only, per-task journal that lets a later session backtrack
 * the decisions and actions behind a task. Local-only — trails never sync to a remote. Order is append
 * order; entries are never rewritten, so hand-authored prose in `note` survives every later append.
 */
export interface TrailEntry {
  /** decision made · action taken · bare note. Absent means "note". */
  kind: TrailKind;
  /** The prose: what was decided, done, or noticed. */
  note: string;
  /** Optional pointer to where it landed — a file:line, a URL, a commit. */
  link?: string;
}

export interface Task {
  /** Stable key, unique within a project. Survives title edits. */
  id: string;
  title: string;
  status: "open" | "done";
  /** Ids this task waits on. */
  deps: string[];
  /** Folders the task may edit (not a file list). */
  scope: string[];
  kind?: string;
  brief?: string;
  contract?: string;
  /** 1-4; how much model the work needs. Absent means 3. */
  tier?: number;
  /** How much review the work earns. Absent means "subagent". */
  qa?: QaLevel;
  /** How urgent the work is. Absent means "normal". */
  priority?: Priority;
  /** Planning lifecycle. Absent means "settled". */
  spec?: SpecState;
  /** A narrative label on a staged deliverable (prototype/build/sweep). */
  stage?: string;
  /** Roads already closed, appended when a build replans. */
  attempts?: Attempt[];
  /** The parent task a discovered task was split from. */
  discovered_from?: string;
}

/** Which project (and optionally which branch) a tool call is about. The server has no cwd of its own. */
export interface ProjectContext {
  /** Absolute path to the target repository root. */
  project: string;
  /** Branch to scope to; the backend decides how it uses this. */
  branch?: string;
}

/** The GitHub coordinates a project resolves to, read from its `origin` remote. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** Server-wide options, set once from CLI args — deployment knobs, not user preferences. */
export type ServerOptions = Pick<
  ProjectConfig,
  "provider" | "projects" | "projectNumber" | "board" | "trailsDir"
> & {
  /** Where the file layer and the config files live. Defaults to the OS cache dir; never the repo. */
  cacheDir?: string;
};

/** A field a task can wear as a `field:value` GitHub label. */
export type LabelFieldName = (typeof LABEL_FIELD_NAMES)[number];

/** User preferences, resolved by ConfigProvider (defaults < flags < global spec < per-repo). */
export interface ProjectConfig {
  /** Which provider backs this project. Default "github". A future value is "linear". */
  provider?: string;
  /** Turn the Projects v2 board sync on or off (GitHub only). Default on. */
  projects?: boolean;
  /** Target an existing Projects v2 board by number. Absent means find/create one named `board`. */
  projectNumber?: number;
  /** The board title to find or create when `projectNumber` is absent. Default "Tasks". */
  board?: string;
  /** Wear execution properties as GitHub labels. Default on. */
  labels?: boolean;
  /** Which fields become labels when `labels` is on. Default: all of them. */
  labelFields?: LabelFieldName[];
  /**
   * Where per-task trails live. A relative path hangs off the repo root; absolute is used as-is.
   * Default `.trails` in the repo root — trails are durable local memory, unlike the throwaway cache.
   */
  trailsDir?: string;
}
