// The GitHub layer: one class wrapping one Octokit client, implementing the Provider seam. It bundles
// Issues (the primary record) and the Projects v2 board (a best-effort kanban mirror), both over
// GraphQL — the board has no complete REST API, and one protocol keeps one kind of handle (node ids)
// end to end. Issues must succeed; a board failure is logged at init and skipped after, so a Projects
// hiccup never loses a task.
//
// Lifecycle: construct (optionally passing your own Octokit — the one test seam; nock intercepts its
// HTTP so the real request path is always exercised), then `await init(ctx)`. There are no async
// constructors, so init is where everything remote is resolved ONCE per project: the repo behind the
// project's `origin`, its config, the repository node id, and the Projects v2 board — found by
// number/title, or created and linked to the repo.
//
// The layer owns its own bookkeeping: a per-project index from task id to issue/card node ids, built
// from one listing pass and refreshed by every `pull`. Nothing above the seam sees a GitHub handle —
// `upsert` decides create-vs-update from the index alone. The task id lives in a hidden YAML block in
// the issue body (alongside deps/scope/brief/…) — the source of truth `pull` reads back; the
// execution-modifying scalars (kind, tier, qa, spec, stage, priority) are worn as `field:value`
// labels. An issue is "managed" iff it carries the block. Below the block, the body renders a VISIBLE,
// human-readable spec (brief, contract, scope, deps) between `<!-- outputty:spec -->` sentinels,
// regenerated on every write so it never goes stale — that render is for the GitHub web UI, never read
// back. The issue's comment thread is the task's TRAIL (see getTrail/appendTrail).

import { spawnSync } from "node:child_process";
import { Octokit } from "octokit";
import { match } from "ts-pattern";
import { parse, stringify } from "yaml";
import type {
  LabelFieldName,
  ProjectConfig,
  ProjectContext,
  RepoRef,
  Task,
  TrailEntry,
  TrailKind,
} from "../types.ts";
import {
  LABEL_FIELD_NAMES,
  TIERS,
  QA_LEVELS,
  SPEC_STATES,
  PRIORITIES,
  TRAIL_KINDS,
} from "../types.ts";
import { ConfigProvider } from "./config.ts";
import type { Provider, ProviderState } from "./provider.ts";
import { withDefaults } from "../graph.ts";

// ---------------------------------------------------------------------------------------------------
// Local credentials — a token from the user's existing setup (env, then the gh CLI), no new login.

/** Run a command, returning its trimmed stdout, or null when it exits non-zero (or is missing). */
function run(cmd: string, args: string[]): string | null {
  const proc = spawnSync(cmd, args, { encoding: "utf8" });
  return proc.status === 0 ? proc.stdout.trim() : null;
}

function githubToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const token = run("gh", ["auth", "token"]) ?? "";
  if (!token) throw new Error("no GitHub credentials: set GITHUB_TOKEN, or run `gh auth login`");
  return token;
}

// One Octokit per token, reused across provider instances — the token is re-read each time so a
// rotated `gh` credential picks up a fresh client instead of failing on a stale one.
const clients = new Map<string, Octokit>();
function defaultOctokit(): Octokit {
  const token = githubToken();
  let client = clients.get(token);
  if (!client) {
    client = new Octokit({ auth: token });
    clients.set(token, client);
  }
  return client;
}

/** Read `<project>`'s `origin` remote and parse the owner/repo it points at on github.com. */
function resolveRepo(project: string): RepoRef {
  const url = run("git", ["-C", project, "remote", "get-url", "origin"]);
  if (url === null) {
    throw new Error(`no git 'origin' remote in ${project} — the GitHub provider needs one`);
  }
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin is not a github.com remote: ${url}`);
  return { owner: m[1], repo: m[2] };
}

// ---------------------------------------------------------------------------------------------------
// The issue body block and the labels — how a full task round-trips through its issue. The scalar
// fields that modify execution (kind, tier, qa, spec, stage, priority) are worn as `field:value`
// LABELS, so they are visible and editable in the GitHub UI and filterable in searches; the body block
// keeps what labels cannot carry (the id, deps, scope, brief, contract, attempts, discovered_from).
// Labels win over a legacy block that still carries those fields; foreign labels are never touched.

interface GhIssue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED";
  labels?: { nodes: Array<{ name: string }> };
}

const META_OPEN = "<!-- outputty:task";
const META_CLOSE = "-->";
// Fields carried in the body block, in a stable order. `id` leads; title/status live outside the
// block; the label-worn fields live on the issue as labels.
const META_KEYS = ["deps", "scope", "brief", "contract", "attempts", "discovered_from"] as const;
// The VISIBLE spec region markers. The body shows a human-readable render of the task between them,
// regenerated on every write; the hidden machine block above stays the source of truth. Sentinels are
// HTML comments (invisible on GitHub) so parseBody can strip the region and keep real human prose.
const SPEC_OPEN = "<!-- outputty:spec -->";
const SPEC_CLOSE = "<!-- /outputty:spec -->";

// The label-worn fields (LABEL_FIELD_NAMES is the one source), each with its label color.
const LABEL_FIELDS: Record<LabelFieldName, string> = {
  kind: "bfd4f2",
  tier: "1d76db",
  qa: "5319e7",
  spec: "fbca04",
  stage: "0e8a16",
  priority: "b60205",
};
const labelField = (name: string): LabelFieldName | null => {
  const at = name.indexOf(":");
  if (at === -1) return null;
  const field = name.slice(0, at);
  return (LABEL_FIELD_NAMES as readonly string[]).includes(field)
    ? (field as LabelFieldName)
    : null;
};

/** The labels a task wears — one `field:value` per configured label-worn field that is set — or
 *  null when the label sync is configured off (meaning: do not touch labels at all). */
function labelsFor(task: Task, config: ProjectConfig): string[] | null {
  if (config.labels === false) return null;
  const fields = config.labelFields ?? LABEL_FIELD_NAMES;
  const out: string[] = [];
  for (const field of fields) {
    if (task[field] !== undefined) out.push(`${field}:${task[field]}`);
  }
  return out;
}

/** A label's value parsed for its field — hand-typed junk (`tier:x`) is ignored, not crashed on.
 *  The valid sets are the shared domains, so the parser can never drift from the validators. */
function parseLabelValue(field: LabelFieldName, value: string): unknown {
  const inSet = (set: readonly string[]) => (set.includes(value) ? value : undefined);
  return match(field)
    .with("tier", () =>
      (TIERS as readonly number[]).includes(Number(value)) ? Number(value) : undefined,
    )
    .with("qa", () => inSet(QA_LEVELS))
    .with("spec", () => inSet(SPEC_STATES))
    .with("priority", () => inSet(PRIORITIES))
    .otherwise(() => value); // kind and stage are free text
}

/** The task fields an issue's labels carry. */
function labelFields(issue: GhIssue): Partial<Task> {
  const out: Record<string, unknown> = {};
  for (const { name } of issue.labels?.nodes ?? []) {
    const field = labelField(name);
    if (!field) continue;
    const value = parseLabelValue(field, name.slice(field.length + 1));
    if (value !== undefined) out[field] = value;
  }
  return out as Partial<Task>;
}

/** A meta value stays out of the block when absent, or an empty list where emptiness means nothing. */
function skipMeta(key: string, value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length === 0 && key !== "deps" && key !== "scope";
}

/** The VISIBLE body: a readable markdown render of the task's spec, wrapped in sentinels. Regenerated on
 *  every write, so it never goes stale; the machine block, not this, is what pull reads back. */
function renderSpec(task: Task): string {
  const lines: string[] = [];
  if (task.brief) lines.push(task.brief.trim());
  if (task.contract) lines.push(`**Contract**\n\n${task.contract.trim()}`);
  if (task.scope.length) lines.push(`**Scope:** ${task.scope.map((s) => `\`${s}\``).join(" · ")}`);
  if (task.deps.length)
    lines.push(`**Depends on:** ${task.deps.map((d) => `\`${d}\``).join(", ")}`);
  return `${SPEC_OPEN}\n${lines.join("\n\n")}\n${SPEC_CLOSE}`;
}

/** Serialise a task into an issue body: the hidden machine block (id first), the visible spec render,
 *  then any genuinely human-added prose kept below (regenerating the spec never touches it). */
function renderBody(task: Task, human = ""): string {
  const meta: Record<string, unknown> = { id: task.id };
  for (const key of META_KEYS) {
    const value = (task as unknown as Record<string, unknown>)[key];
    if (!skipMeta(key, value)) meta[key] = value;
  }
  const yaml = stringify(meta).trim();
  const block = `${META_OPEN}\n${yaml}\n${META_CLOSE}`;
  const parts = human ? [block, renderSpec(task), human] : [block, renderSpec(task)];
  return parts.join("\n\n").trimEnd() + "\n";
}

function parseBody(body: string | null | undefined): {
  meta: Record<string, unknown>;
  human: string;
} {
  if (!body) return { meta: {}, human: "" };
  const start = body.indexOf(META_OPEN);
  if (start === -1) return { meta: {}, human: body.trim() };
  const end = body.indexOf(META_CLOSE, start);
  if (end === -1) return { meta: {}, human: body.trim() };
  const yaml = body.slice(start + META_OPEN.length, end).trim();
  let meta: Record<string, unknown> = {};
  try {
    meta = (parse(yaml) as Record<string, unknown>) || {};
  } catch {
    meta = {};
  }
  return { meta, human: stripSpec(body.slice(end + META_CLOSE.length)) };
}

/** Drop the regenerated visible-spec region, leaving only genuinely human-added prose. A body from
 *  before this feature (no sentinels) is returned as-is. */
function stripSpec(text: string): string {
  const start = text.indexOf(SPEC_OPEN);
  if (start === -1) return text.trim();
  const end = text.indexOf(SPEC_CLOSE, start);
  if (end === -1) return text.trim();
  return (text.slice(0, start) + text.slice(end + SPEC_CLOSE.length)).trim();
}

/** GitHub's issue state → the task status it means. */
const taskStatus = (state: GhIssue["state"]): Task["status"] =>
  match(state)
    .with("CLOSED", () => "done" as const)
    .with("OPEN", () => "open" as const)
    .exhaustive();

/** The task id an issue carries, or null when the issue is not one of ours. */
function managedId(issue: GhIssue): string | null {
  const id = parseBody(issue.body).meta.id;
  return typeof id === "string" && id ? id : null;
}

/** The full task an issue encodes: the body block, then labels win the fields they carry, then
 *  title/status from the issue itself. */
function issueToTask(issue: GhIssue): Task {
  const { meta } = parseBody(issue.body);
  return withDefaults({
    ...meta,
    ...labelFields(issue),
    id: String(meta.id),
    title: issue.title || "",
    status: taskStatus(issue.state),
  } as Partial<Task> & { id: string });
}

// ---------------------------------------------------------------------------------------------------
// Trails — a task's issue COMMENT THREAD. Every comment is a trail entry (people's comments included).
// `kind`/`link` ride a hidden marker on comments outputty writes; a plain human comment carries neither
// and reads back as a bare note plus GitHub's author and timestamp.

const TRAIL_MARK = "<!-- outputty:trail";

/** One issue comment as GitHub returns it. */
interface GhComment {
  body: string | null;
  author: { login: string } | null;
  createdAt: string;
}

/** Serialise an entry into a comment body: a hidden marker for kind/link when set, then the note. */
function renderComment(entry: TrailEntry): string {
  const attrs: string[] = [];
  if (entry.kind) attrs.push(`kind=${entry.kind}`);
  if (entry.link) attrs.push(`link=${entry.link}`);
  if (attrs.length === 0) return entry.note;
  return `${TRAIL_MARK} ${attrs.join(" ")} -->\n${entry.note}`;
}

/** The kind/link a leading marker carries and the note below it — or the whole body as the note. */
function splitMarker(body: string): { kind?: TrailKind; link?: string; note: string } {
  if (!body.startsWith(TRAIL_MARK)) return { note: body };
  const end = body.indexOf("-->");
  if (end === -1) return { note: body };
  const attrs = body.slice(TRAIL_MARK.length, end);
  const raw = /kind=(\S+)/.exec(attrs)?.[1];
  const kind =
    raw && (TRAIL_KINDS as readonly string[]).includes(raw) ? (raw as TrailKind) : undefined;
  return { kind, link: /link=(\S+)/.exec(attrs)?.[1], note: body.slice(end + 3).trim() };
}

/** One GitHub comment → a trail entry: the marker fields, the note, and GitHub's author + timestamp. */
function commentToEntry(c: GhComment): TrailEntry {
  const { kind, link, note } = splitMarker(c.body ?? "");
  const entry: TrailEntry = { note };
  if (kind) entry.kind = kind;
  if (link) entry.link = link;
  if (c.author?.login) entry.author = c.author.login;
  if (c.createdAt) entry.at = c.createdAt;
  return entry;
}

// ---------------------------------------------------------------------------------------------------
// The provider.

/** The Projects v2 board init resolved, or null when the board is off or unavailable. */
interface BoardMeta {
  projectId: string;
  statusFieldId?: string;
  options: Map<string, string>; // lower-cased option name -> option id
}

/** One board card: its item node id, and whether its Status column reads as a Done column. */
interface BoardCard {
  itemId: string;
  done: boolean;
}

/** What init's one repository query returns: the ids it needs, the repo's linked boards, its labels. */
interface RepoSnapshot {
  id: string;
  owner: { id: string };
  projectsV2: { nodes: Array<{ id: string; number: number; title: string }> };
  labels: { nodes: Array<{ id: string; name: string }> };
}

/** One page of a GraphQL connection. */
interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

/** One raw item from the board's items connection. */
interface BoardItem {
  id: string;
  content: { id?: string } | null;
  fieldValueByName: { name?: string } | null;
}

/** Record one board item as a card — skipping draft cards and non-issue content. */
function collectCard(out: Map<string, BoardCard>, item: BoardItem): void {
  const issueId = item.content?.id;
  if (!issueId) return;
  const name = (item.fieldValueByName?.name ?? "").toLowerCase();
  out.set(issueId, {
    itemId: item.id,
    done: name === "done" || name === "closed",
  });
}

/** One issue as pull sees it: the full task it encodes, its ref, whether it carries our block. */
interface ListedIssue {
  task: Task;
  issueId: string;
  managed: boolean;
}

function listedIssue(issue: GhIssue): ListedIssue {
  const mid = managedId(issue);
  const task = mid
    ? issueToTask(issue)
    : withDefaults({
        id: `gh-${issue.number}`,
        title: issue.title || "",
        status: taskStatus(issue.state),
      });
  return { task, issueId: issue.id, managed: mid !== null };
}

/** Push back when the sides disagree, the card is missing, or the issue needs adopting — the push
 *  makes the issue, the body block, and the board card all consistent. */
function needsReconcile(
  listed: ListedIssue,
  card: BoardCard | undefined,
  done: boolean,
  boardOn: boolean,
): boolean {
  if (!listed.managed) return true;
  if ((listed.task.status === "done") !== done) return true;
  return boardOn && (!card || card.done !== done);
}

/** Reconcile one issue with its board card into the state pull reports to the service. */
function providerState(
  listed: ListedIssue,
  card: BoardCard | undefined,
  boardOn: boolean,
): ProviderState {
  // Done if the issue is closed OR the card sits in a Done column.
  const done = listed.task.status === "done" || card?.done === true;
  // The task is rebuilt whole from the body (deps included), with status reconciled.
  return {
    task: { ...listed.task, status: done ? "done" : "open" },
    reconcile: needsReconcile(listed, card, done, boardOn),
  };
}

/** Where one task already sits in GitHub: its issue node id, and its board card when known. */
interface IssueHandle {
  issueId: string;
  projectItem?: string;
}

/** One issue joined with its board card — pull and the index are both derived from this scan. */
interface Scanned {
  listed: ListedIssue;
  card?: BoardCard;
}

/** Both views of one scan: the pull states and the upsert index. FIRST WINS everywhere a task id
 *  repeats — the listing is oldest-first, so pulls and upserts always resolve to the OLDEST issue
 *  carrying an id (deterministic, and the one a human saw first); newer duplicates are flagged. */
function collate(
  scan: Scanned[],
  boardOn: boolean,
): { states: Map<string, ProviderState>; index: Map<string, IssueHandle> } {
  const states = new Map<string, ProviderState>();
  const index = new Map<string, IssueHandle>();
  for (const { listed, card } of scan) {
    const existing = states.get(listed.task.id);
    if (existing) {
      existing.conflict = true; // a newer issue also claims this id; the oldest stays the record
      continue;
    }
    states.set(listed.task.id, providerState(listed, card, boardOn));
    index.set(
      listed.task.id,
      card ? { issueId: listed.issueId, projectItem: card.itemId } : { issueId: listed.issueId },
    );
  }
  return { states, index };
}

/** The label node ids on an issue that are NOT ours — kept as-is on every update. */
function foreignLabelIds(
  node: { labels: { nodes: Array<{ id: string; name: string }> } } | null,
): string[] {
  return (node?.labels.nodes ?? []).filter((l) => labelField(l.name) === null).map((l) => l.id);
}

/** Duplicate ids are worth a line in the log every time they are seen — they mean two issues claim
 *  one task and a human should merge or close one; sync counts them but never deletes. */
function warnConflicts(repo: RepoRef, states: Map<string, ProviderState>): void {
  const ids = [...states.entries()].filter(([, s]) => s.conflict).map(([id]) => id);
  if (ids.length === 0) return;
  console.error(
    `tasks-mcp: ${repo.owner}/${repo.repo} has duplicate issues for task id(s): ${ids.join(", ")} — using the oldest of each`,
  );
}

/** Everything init resolves for one project; every later call runs against this. */
interface ProjectState {
  repo: RepoRef;
  config: ProjectConfig;
  /** The repository node id — what createIssue mutates against. */
  repoId: string;
  board: BoardMeta | null;
  /** The repo's labels, name → node id; missing ones are created on demand during upsert. */
  labels: Map<string, string>;
}

export class GitHubProvider implements Provider {
  readonly name = "github";
  private readonly octokit: Octokit;
  // One init per project path, shared by concurrent callers; a failed init is forgotten so it retries.
  private readonly states = new Map<string, Promise<ProjectState>>();
  // The layer's own bookkeeping: task id → issue/card handles, one listing pass per project (refreshed
  // by every pull). A failed build is forgotten so it retries.
  private readonly indexes = new Map<string, Promise<Map<string, IssueHandle>>>();

  constructor(
    private readonly config: ConfigProvider,
    octokit?: Octokit,
  ) {
    this.octokit = octokit ?? defaultOctokit();
  }

  /**
   * Resolve everything remote for `ctx.project` — repo, config, repository node id, and the board
   * (found or created + linked). Idempotent; task calls also await it, so calling it explicitly is
   * about surfacing setup errors early, not a hard precondition.
   */
  async init(ctx: ProjectContext): Promise<void> {
    await this.state(ctx.project);
  }

  async upsert(ctx: ProjectContext, task: Task): Promise<void> {
    const state = await this.state(ctx.project);
    const index = await this.index(ctx.project, state);
    const known = index.get(task.id);
    const wanted = labelsFor(task, state.config);
    const labelIds = wanted === null ? undefined : await this.ensureLabels(state, wanted);
    const issueId = await this.writeIssue(state, known?.issueId, task, labelIds);
    const projectItem = await this.withBoard(state, task, issueId, known?.projectItem);
    index.set(task.id, projectItem ? { issueId, projectItem } : { issueId });
  }

  /** The node ids for these label names, creating any label the repo does not have yet. */
  private async ensureLabels(state: ProjectState, names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const id = state.labels.get(name) ?? (await this.createLabel(state, name));
      state.labels.set(name, id);
      ids.push(id);
    }
    return ids;
  }

  private async createLabel(state: ProjectState, name: string): Promise<string> {
    const field = labelField(name);
    const res = await this.octokit.graphql<{ createLabel: { label: { id: string } } }>(
      `mutation($r:ID!,$n:String!,$c:String!){ createLabel(input:{repositoryId:$r,name:$n,color:$c}){ label{ id } } }`,
      {
        r: state.repoId,
        n: name,
        c: field ? LABEL_FIELDS[field] : "ededed",
        // Label mutations spent years behind this preview; the header is harmless once they are GA.
        headers: { accept: "application/vnd.github.bane-preview+json" },
      },
    );
    return res.createLabel.label.id;
  }

  async pull(ctx: ProjectContext): Promise<Map<string, ProviderState>> {
    const state = await this.state(ctx.project);
    const { states, index } = collate(await this.scan(state), state.board !== null);
    this.indexes.set(ctx.project, Promise.resolve(index));
    warnConflicts(state.repo, states);
    return states;
  }

  // -------------------------------------------------------------------------------------------------
  // Trails — the issue's comment thread. get_trail is the whole thread; append posts one comment.

  async getTrail(ctx: ProjectContext, id: string): Promise<TrailEntry[]> {
    const state = await this.state(ctx.project);
    const handle = (await this.index(ctx.project, state)).get(id);
    if (!handle) return []; // no issue for this id yet → no trail
    return this.listComments(handle.issueId);
  }

  async appendTrail(ctx: ProjectContext, id: string, entry: TrailEntry): Promise<TrailEntry[]> {
    const note = (entry.note ?? "").trim();
    if (!note) throw new Error("a trail entry needs a note");
    if (entry.kind && !(TRAIL_KINDS as readonly string[]).includes(entry.kind)) {
      throw new Error(`unknown trail kind '${entry.kind}' (kinds: ${TRAIL_KINDS.join(", ")})`);
    }
    const state = await this.state(ctx.project);
    const handle = (await this.index(ctx.project, state)).get(id);
    if (!handle) throw new Error(`no task ${id} on GitHub — sync it before adding a trail entry`);
    await this.octokit.graphql(
      `mutation($s:ID!,$b:String!){ addComment(input:{subjectId:$s,body:$b}){ commentEdge{ node{ id } } } }`,
      { s: handle.issueId, b: renderComment({ ...entry, note }) },
    );
    return this.listComments(handle.issueId);
  }

  /** Every comment on an issue, oldest first, each mapped to a trail entry. */
  private async listComments(issueId: string): Promise<TrailEntry[]> {
    const out: TrailEntry[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.commentPage(issueId, after);
      out.push(...page.nodes.map(commentToEntry));
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return out;
  }

  private async commentPage(issueId: string, after: string | null): Promise<Page<GhComment>> {
    const res: { node: { comments: Page<GhComment> } | null } = await this.octokit.graphql(
      `query($id:ID!,$c:String){ node(id:$id){ ... on Issue { comments(first:100,after:$c){ pageInfo{ hasNextPage endCursor } nodes{ body author{ login } createdAt } } } } }`,
      { id: issueId, c: after },
    );
    return res.node?.comments ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  }

  // -------------------------------------------------------------------------------------------------
  // The index — how upsert decides create-vs-update without anything above the seam holding handles.

  private index(project: string, state: ProjectState): Promise<Map<string, IssueHandle>> {
    let index = this.indexes.get(project);
    if (!index) {
      index = this.scan(state)
        .then((scan) => collate(scan, state.board !== null).index)
        .catch((err) => {
          this.indexes.delete(project);
          throw err;
        });
      this.indexes.set(project, index);
    }
    return index;
  }

  /** One listing pass: every issue joined with its board card. */
  private async scan(state: ProjectState): Promise<Scanned[]> {
    const cards = await this.boardCards(state);
    return (await this.listIssues(state)).map((listed) => ({
      listed,
      card: cards.get(listed.issueId),
    }));
  }

  /** Update the issue behind `issueId`, or create one when the id is new here. Returns the node id. */
  private async writeIssue(
    state: ProjectState,
    issueId: string | undefined,
    task: Task,
    labelIds: string[] | undefined, // undefined = label sync configured off: never touch labels
  ): Promise<string> {
    if (!issueId) return this.createIssue(state, task, labelIds);
    await this.updateIssue(issueId, task, labelIds);
    return issueId;
  }

  /** The board's cards (best-effort — a read failure means no cards), so Done cards flow back in. */
  private async boardCards(state: ProjectState): Promise<Map<string, BoardCard>> {
    if (!state.board) return new Map();
    return this.readBoard(state.board).catch(() => new Map());
  }

  // -------------------------------------------------------------------------------------------------
  // Init.

  private state(project: string): Promise<ProjectState> {
    // The cache key carries the effective config, so ANY preference change (board, projects, labels)
    // rebuilds the state on the next call — set_config propagates uniformly, no special cases.
    const config = this.config.get(project);
    const key = `${project}\u0000${JSON.stringify(config)}`;
    let state = this.states.get(key);
    if (!state) {
      state = this.buildState(project, config).catch((err) => {
        this.states.delete(key); // a failed init retries next call instead of caching the error
        throw err;
      });
      this.states.set(key, state);
    }
    return state;
  }

  private async buildState(project: string, config: ProjectConfig): Promise<ProjectState> {
    const repo = resolveRepo(project);
    const snapshot = await this.repoSnapshot(repo);
    return {
      repo,
      config,
      repoId: snapshot.id,
      board: await this.boardFor(snapshot, config, repo),
      labels: new Map(snapshot.labels.nodes.map((l) => [l.name, l.id])),
    };
  }

  /** One query for the ids init needs: the repository node (createIssue mutates against it), its
   *  owner (createProjectV2 needs it), and the boards already linked to the repo. */
  private async repoSnapshot(repo: RepoRef): Promise<RepoSnapshot> {
    const res = await this.octokit.graphql<{ repository: RepoSnapshot }>(
      `query($o:String!,$n:String!){ repository(owner:$o,name:$n){ id owner{ id } projectsV2(first:50){ nodes{ id number title } } labels(first:100){ nodes{ id name } } } }`,
      { o: repo.owner, n: repo.repo },
    );
    return res.repository;
  }

  /** The board to mirror onto, or null: turned off, or unavailable — a mirror failing to init must
   *  not take the provider down with it, so that error is logged and swallowed here. */
  private async boardFor(
    snapshot: RepoSnapshot,
    config: ProjectConfig,
    repo: RepoRef,
  ): Promise<BoardMeta | null> {
    if (config.projects === false) return null;
    try {
      return await this.resolveBoard(snapshot, config);
    } catch (err) {
      console.error(
        `tasks-mcp: github-projects board unavailable for ${repo.owner}/${repo.repo}, syncing issues only: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Find the board by number (config.projectNumber) or title (config.board, default "Tasks") among
   *  the repo's linked boards — or create it and link it to the repo — then read its Status field. */
  private async resolveBoard(repository: RepoSnapshot, config: ProjectConfig): Promise<BoardMeta> {
    const found = await this.findOrCreateBoard(repository, config);
    return this.statusField(found.id);
  }

  private async findOrCreateBoard(
    repository: RepoSnapshot,
    config: ProjectConfig,
  ): Promise<{ id: string }> {
    const number = config.projectNumber;
    const title = config.board ?? "Tasks";
    const project = number
      ? repository.projectsV2.nodes.find((p) => p.number === number)
      : repository.projectsV2.nodes.find((p) => p.title === title);
    if (project) return project;
    if (number) throw new Error(`Projects v2 board #${number} not found`);
    return this.createBoard(repository, title);
  }

  private async createBoard(repository: RepoSnapshot, title: string): Promise<{ id: string }> {
    const created = await this.octokit.graphql<{
      createProjectV2: { projectV2: { id: string } };
    }>(
      `mutation($owner:ID!,$title:String!){ createProjectV2(input:{ownerId:$owner,title:$title}){ projectV2{ id number title } } }`,
      { owner: repository.owner.id, title },
    );
    const project = created.createProjectV2.projectV2;
    await this.octokit.graphql(
      `mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){ repository{ id } } }`,
      { p: project.id, r: repository.id },
    );
    return project;
  }

  /** The board's Status single-select field and its options — how open/done map onto columns. */
  private async statusField(projectId: string): Promise<BoardMeta> {
    const fields = await this.octokit.graphql<{
      node: {
        field: {
          id: string;
          options: Array<{ id: string; name: string }>;
        } | null;
      };
    }>(
      `query($id:ID!){ node(id:$id){ ... on ProjectV2 { field(name:"Status"){ ... on ProjectV2SingleSelectField { id options{ id name } } } } } }`,
      { id: projectId },
    );
    const options = new Map<string, string>();
    const status = fields.node.field;
    for (const opt of status?.options ?? []) options.set(opt.name.toLowerCase(), opt.id);
    return { projectId, statusFieldId: status?.id, options };
  }

  // -------------------------------------------------------------------------------------------------
  // Issues — the primary record. A write here must succeed.

  private async createIssue(
    state: ProjectState,
    task: Task,
    labelIds: string[] | undefined,
  ): Promise<string> {
    const mutation =
      labelIds === undefined
        ? `mutation($r:ID!,$t:String!,$b:String!){ createIssue(input:{repositoryId:$r,title:$t,body:$b}){ issue{ id } } }`
        : `mutation($r:ID!,$t:String!,$b:String!,$l:[ID!]){ createIssue(input:{repositoryId:$r,title:$t,body:$b,labelIds:$l}){ issue{ id } } }`;
    const res = await this.octokit.graphql<{
      createIssue: { issue: { id: string } };
    }>(mutation, { r: state.repoId, t: task.title || task.id, b: renderBody(task), l: labelIds });
    const issueId = res.createIssue.issue.id;
    await this.setIssueState(issueId, task.status);
    return issueId;
  }

  private async updateIssue(
    issueId: string,
    task: Task,
    labelIds: string[] | undefined,
  ): Promise<void> {
    const current = await this.octokit.graphql<{
      node: { body: string | null; labels: { nodes: Array<{ id: string; name: string }> } } | null;
    }>(
      `query($id:ID!){ node(id:$id){ ... on Issue { body labels(first:50){ nodes{ id name } } } } }`,
      { id: issueId },
    );
    const human = parseBody(current.node?.body).human;
    // updateIssue's labelIds REPLACES the whole set: keep every foreign label, replace only ours.
    // Label sync off (labelIds undefined) leaves the labels field out of the mutation entirely.
    const mutation =
      labelIds === undefined
        ? `mutation($id:ID!,$t:String!,$b:String!){ updateIssue(input:{id:$id,title:$t,body:$b}){ issue{ id } } }`
        : `mutation($id:ID!,$t:String!,$b:String!,$l:[ID!]){ updateIssue(input:{id:$id,title:$t,body:$b,labelIds:$l}){ issue{ id } } }`;
    await this.octokit.graphql(mutation, {
      id: issueId,
      t: task.title || task.id,
      b: renderBody(task, human),
      l: labelIds === undefined ? undefined : [...foreignLabelIds(current.node), ...labelIds],
    });
    await this.setIssueState(issueId, task.status);
  }

  private async setIssueState(issueId: string, status: Task["status"]): Promise<void> {
    const mutation = match(status)
      .with("done", () => `mutation($id:ID!){ closeIssue(input:{issueId:$id}){ issue{ id } } }`)
      .with("open", () => `mutation($id:ID!){ reopenIssue(input:{issueId:$id}){ issue{ id } } }`)
      .exhaustive();
    await this.octokit.graphql(mutation, { id: issueId });
  }

  /**
   * Every issue in the repo (not PRs — the `issues` connection excludes them), reconstructed as a full
   * task from its body block. A managed issue keeps its block id; a hand-opened one is given
   * `gh-<number>` so `sync` can adopt it. This is what lets a deleted cache be rebuilt from GitHub.
   */
  private async listIssues(state: ProjectState): Promise<ListedIssue[]> {
    const out: ListedIssue[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.issuePage(state.repo, after);
      out.push(...page.nodes.map(listedIssue));
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return out;
  }

  private async issuePage(repo: RepoRef, after: string | null): Promise<Page<GhIssue>> {
    const res: { repository: { issues: Page<GhIssue> } } = await this.octokit.graphql(
      `query($o:String!,$n:String!,$c:String){ repository(owner:$o,name:$n){ issues(first:100,after:$c,states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:ASC}){ pageInfo{ hasNextPage endCursor } nodes{ id number title body state labels(first:20){ nodes{ name } } } } } }`,
      { o: repo.owner, n: repo.repo, c: after },
    );
    return res.repository.issues;
  }

  // -------------------------------------------------------------------------------------------------
  // The Projects v2 board — the mirror. Best-effort: never let a board failure fail the task write.

  private async withBoard(
    state: ProjectState,
    task: Task,
    issueId: string,
    existingItem: string | undefined,
  ): Promise<string | undefined> {
    if (!state.board) return existingItem;
    try {
      return await this.syncToBoard(state.board, issueId, existingItem, task.status);
    } catch (err) {
      console.error(
        `tasks-mcp: github-projects sync skipped for ${task.id}: ${(err as Error).message}`,
      );
      return existingItem;
    }
  }

  /** Ensure the issue is a card on the board and its Status column matches. Returns the item id. */
  private async syncToBoard(
    board: BoardMeta,
    issueId: string,
    existingItem: string | undefined,
    status: Task["status"],
  ): Promise<string> {
    const itemId = existingItem ?? (await this.addCard(board, issueId));
    await this.setCardStatus(board, itemId, status);
    return itemId;
  }

  private async addCard(board: BoardMeta, issueId: string): Promise<string> {
    const added = await this.octokit.graphql<{
      addProjectV2ItemById: { item: { id: string } };
    }>(
      `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`,
      { p: board.projectId, c: issueId },
    );
    return added.addProjectV2ItemById.item.id;
  }

  /** Move the card's Status to the first column that matches the task status, if one exists. */
  private async setCardStatus(
    board: BoardMeta,
    itemId: string,
    status: Task["status"],
  ): Promise<void> {
    if (!board.statusFieldId) return;
    const wanted = match(status)
      .with("done", () => ["done", "closed"])
      .with("open", () => ["todo", "to do", "backlog"])
      .exhaustive();
    const optionId = wanted.map((w) => board.options.get(w)).find(Boolean);
    if (!optionId) return;
    await this.octokit.graphql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`,
      { p: board.projectId, i: itemId, f: board.statusFieldId, o: optionId },
    );
  }

  /** Read the board back: every card keyed by its content issue's node id. Powers board → cache sync. */
  private async readBoard(board: BoardMeta): Promise<Map<string, BoardCard>> {
    const out = new Map<string, BoardCard>();
    let after: string | null = null;
    for (;;) {
      const page = await this.boardPage(board, after);
      for (const item of page.nodes) collectCard(out, item);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return out;
  }

  private async boardPage(board: BoardMeta, after: string | null): Promise<Page<BoardItem>> {
    const res: { node: { items: Page<BoardItem> } } = await this.octokit.graphql(
      `query($p:ID!,$c:String){ node(id:$p){ ... on ProjectV2 { items(first:100,after:$c){ pageInfo{ hasNextPage endCursor } nodes{ id content{ ... on Issue { id } } fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`,
      { p: board.projectId, c: after },
    );
    return res.node.items;
  }
}
