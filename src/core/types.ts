// The task model, ported from outputty's tasks.js. A backend produces and consumes these; the graph
// engine reasons over them. Every field except id/title/status is optional so a plain todo and a full
// outputty task share one shape.

// The value domains, each stated ONCE — the types, the validators, the zod schemas, and the GitHub
// label parser all derive from these arrays.
export const STATUSES = ["open", "in_progress", "done"] as const;
export const SPEC_STATES = ["drafting", "settled", "replan"] as const;
export const QA_LEVELS = ["skip", "inline", "subagent"] as const;
export const PRIORITIES = ["high", "normal", "low"] as const;
export const TIERS = [1, 2, 3, 4] as const;
// What a record IS. A `target` is a roadmap item: it groups tasks and is never dispatched. Distinct
// from `kind`, which is the user's own free-text classifier (feature, bug, chore).
export const NODE_TYPES = ["task", "target"] as const;
export const LABEL_FIELD_NAMES = [
  "type",
  "kind",
  "tier",
  "qa",
  "spec",
  "stage",
  "priority",
  "status",
] as const;
// The kinds of thing a trail entry records — a decision made, an action taken, or a bare note. Stated
// once here; the type, the zod enum, and the store's validator all derive from it.
export const TRAIL_KINDS = ["decision", "action", "note"] as const;

/**
 * What ABSENCE already means for each label-worn field. Stated once here so the validators
 * (`tierOf`, `qaOf`, `priorityOf`, `specSettled`, `typeOf`) and the GitHub label writer cannot
 * drift: a field set to its default is indistinguishable from one never set, which is why writing
 * a `tier:3` label would put a redundant label on nearly every issue in the repo.
 */
export const DEFAULTS = {
  type: "task",
  tier: 3,
  qa: "subagent",
  spec: "settled",
  priority: "normal",
  status: "open",
} as const;

export type Status = (typeof STATUSES)[number];
export type NodeType = (typeof NODE_TYPES)[number];
export type SpecState = (typeof SPEC_STATES)[number];
export type QaLevel = (typeof QA_LEVELS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type TrailKind = (typeof TRAIL_KINDS)[number];

export interface Attempt {
  tried: string;
  killed_by: string;
}

/**
 * One entry in a task's trail. A trail is the task's GitHub issue COMMENT THREAD: every comment is an
 * entry, so `get_trail` returns the whole discussion (people's comments included). `note` is the comment
 * body; `author`/`at` come from GitHub on read. `kind`/`link` are optional and carried in a hidden
 * marker only on comments outputty wrote — a plain human comment has neither.
 */
export interface TrailEntry {
  /** decision · action · note. Set by an outputty write; absent on a plain human comment. */
  kind?: TrailKind;
  /** The comment body: what was decided, done, or noticed. */
  note: string;
  /** Optional pointer — a file:line, a URL, a commit. */
  link?: string;
  /** Who wrote the comment (GitHub login). Read-only, from GitHub. */
  author?: string;
  /** When the comment was written (ISO 8601). Read-only, from GitHub. */
  at?: string;
}

export interface Task {
  /** Stable key, unique within a project. Survives title edits. */
  id: string;
  title: string;
  /**
   * What this record is. A `target` is a roadmap item — it groups the tasks that serve it and is
   * NEVER offered by `ready`, so nothing dispatches a roadmap row as if it were buildable. Absent
   * means `task`.
   */
  type?: NodeType;
  /**
   * The target this record serves. On GitHub this IS the sub-issue edge (the target's issue is the
   * parent), so re-parenting an issue in the web UI flows back on the next sync.
   */
  target?: string;
  /**
   * Lifecycle. `in_progress` is what a worker sets when it picks the task up: `ready` matches only
   * `open`, so a task being built stops being offered and nobody dispatches it twice. It clears
   * itself — closing sets `done`, and a replan puts the task back to `open`.
   */
  status: Status;
  /** Ids this task waits on. */
  deps: string[];
  /** Folders the task may edit (not a file list). */
  scope: string[];
  kind?: string;
  /**
   * Free-form GitHub labels, carried verbatim (no `field:` prefix). ADOPTED on pull — every bare
   * label a managed issue wears reads back as a tag, so a label added in the web UI flows back like
   * any other edit. ABSENT means outputty does not manage this issue's bare labels and leaves them
   * alone; a present list (`[]` included) is exact, and a write makes the issue wear precisely it.
   */
  tags?: string[];
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

/**
 * A partial update. Only the fields it carries change — and `null` CLEARS one, which is the single
 * thing an absent key cannot say, since absence already means "leave it alone". Clearing is how a
 * `field:value` label comes OFF an issue without anyone opening the GitHub UI.
 */
export type TaskPatch = { [K in keyof Task]?: Task[K] | null };

/** Which project (and optionally which branch) a tool call is about. The server has no cwd of its own. */
export interface ProjectContext {
  /** The project id — an opaque, supplied string, never derived from a path or a provider. */
  project: string;
  /** Branch to scope to; the backend decides how it uses this. */
  branch?: string;
}

/** The GitHub coordinates a project resolves to — from its configured `repo`, else the launch cwd's
 *  `origin`. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** Server-wide options, set once from CLI args — deployment knobs, not user preferences. */
export type ServerOptions = Pick<
  ProjectConfig,
  "provider" | "projects" | "projectNumber" | "board"
> & {
  /** Where the file layer and the config files live. Defaults to the OS cache dir; never the repo. */
  cacheDir?: string;
  /** Background-sync cadence in seconds; 0 (the default) turns the loop off. A deployment knob. */
  syncInterval?: number;
};

/** A field a task can wear as a `field:value` GitHub label. */
export type LabelFieldName = (typeof LABEL_FIELD_NAMES)[number];

/** User preferences, resolved by ConfigProvider (defaults < flags < global spec < per-repo). */
export interface ProjectConfig {
  /** Which provider backs this project. Default "github". A future value is "linear". */
  provider?: string;
  /**
   * The GitHub coordinates (`owner/repo`) backing this project. A project id is opaque and never a
   * path, so the repo is configuration, not something derived from the id. Absent means fall back to
   * the `origin` of the server's launch working directory; a server outside any git repo with no
   * `repo` set cannot resolve one and says so.
   */
  repo?: string;
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
  /** Minutes of silence before a claim is reported stale. Default 15. */
  claimStaleMinutes?: number;
}
