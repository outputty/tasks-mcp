// The task model, ported from outputty's tasks.js. A backend produces and consumes these; the graph
// engine reasons over them. Every field except id/title/status is optional so a plain todo and a full
// outputty task share one shape.

export type SpecState = "drafting" | "settled" | "replan";
export type QaLevel = "skip" | "inline" | "subagent";

export interface Attempt {
  tried: string;
  killed_by: string;
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

/** Where a task already lives in its provider, so the service never re-looks-it-up. */
export interface Refs {
  /** The backing issue's GraphQL node id (the provider's stable handle for the task). */
  issueId?: string;
  /** The Projects v2 item node id, when the task is on a board. */
  projectItem?: string;
}

/** A task as it sits in the committed cache: the full task plus its provider refs. */
export type CacheEntry = Task & { refs?: Refs };

/** Per-project settings, read from `.claude/tasks-mcp.config.*` (all optional). */
export interface ProjectConfig {
  /** Which provider backs this project. Default "github". A future value is "linear". */
  provider?: string;
  /** Turn the Projects v2 board sync on or off (GitHub only). Default on. */
  projects?: boolean;
  /** Target an existing Projects v2 board by number. Absent means find/create one named `board`. */
  projectNumber?: number;
  /** The board title to find or create when `projectNumber` is absent. Default "Tasks". */
  board?: string;
}
