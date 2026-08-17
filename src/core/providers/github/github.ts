// The GitHub provider: one class wrapping one Octokit client, implementing the Provider seam. It
// bundles Issues (the primary record) and the Projects v2 board (a best-effort kanban mirror), both
// over GraphQL — the board has no complete REST API, and one protocol keeps one kind of handle (node
// ids) end to end. Issues must succeed; a board failure is logged at init and skipped after, so a
// Projects hiccup never loses a task.
//
// Lifecycle: construct (optionally passing your own Octokit — the one test seam; nock intercepts its
// HTTP so the real request path is always exercised), then `await init(ctx)`. There are no async
// constructors, so init is where everything remote is resolved ONCE per project: the repo behind the
// project's `origin`, its config, the repository node id, and the Projects v2 board — found by
// number/title, or created and linked to the repo. Task calls after that only touch issues and cards.
//
// The task id lives in a hidden YAML block in the issue body (alongside deps/scope/tier/…) — no
// labels, nothing to keep in sync but the body itself. An issue is "managed" iff it carries that block.

import { spawnSync } from "node:child_process";
import { Octokit } from "octokit";
import { match } from "ts-pattern";
import { parse, stringify } from "yaml";
import type { ProjectConfig, ProjectContext, Refs, RepoRef, Task } from "../../types.ts";
import { loadConfig, type ServerOptions } from "../../config.ts";
import type { Provider, RemoteState } from "../provider.ts";
import { withDefaults } from "../../graph.ts";

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
// The issue body block — how a full task (deps included) round-trips through its issue.

interface GhIssue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED";
}

const META_OPEN = "<!-- outputty:task";
const META_CLOSE = "-->";
// Fields carried in the body block, in a stable order. `id` leads; title/status live outside the block.
const META_KEYS = [
  "kind",
  "deps",
  "scope",
  "tier",
  "qa",
  "spec",
  "stage",
  "brief",
  "contract",
  "attempts",
  "discovered_from",
] as const;

/** A meta value stays out of the block when absent, or an empty list where emptiness means nothing. */
function skipMeta(key: string, value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length === 0 && key !== "deps" && key !== "scope";
}

/** Serialise a task into an issue body: the hidden block (id first), then any human prose kept below. */
function renderBody(task: Task, human = ""): string {
  const meta: Record<string, unknown> = { id: task.id };
  for (const key of META_KEYS) {
    const value = (task as unknown as Record<string, unknown>)[key];
    if (!skipMeta(key, value)) meta[key] = value;
  }
  const yaml = stringify(meta).trim();
  const block = `${META_OPEN}\n${yaml}\n${META_CLOSE}`;
  return (human ? `${block}\n\n${human}` : block).trimEnd() + "\n";
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
  return { meta, human: body.slice(end + META_CLOSE.length).trim() };
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

/** The full task an issue encodes (the body block wins; title/status come from the issue). */
function issueToTask(issue: GhIssue): Task {
  const { meta } = parseBody(issue.body);
  return withDefaults({
    ...meta,
    id: String(meta.id),
    title: issue.title || "",
    status: taskStatus(issue.state),
  } as Partial<Task> & { id: string });
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

/** What init's one repository query returns: the ids it needs plus the repo's linked boards. */
interface RepoSnapshot {
  id: string;
  owner: { id: string };
  projectsV2: { nodes: Array<{ id: string; number: number; title: string }> };
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
function remoteState(
  listed: ListedIssue,
  card: BoardCard | undefined,
  boardOn: boolean,
): RemoteState {
  // Done if the issue is closed OR the card sits in a Done column.
  const done = listed.task.status === "done" || card?.done === true;
  // The patch is the whole task rebuilt from the body (deps included), with status reconciled.
  return {
    patch: { ...listed.task, status: done ? "done" : "open" },
    refs: { issueId: listed.issueId, projectItem: card?.itemId },
    reconcile: needsReconcile(listed, card, done, boardOn),
  };
}

/** Everything init resolves for one project; every later call runs against this. */
interface ProjectState {
  repo: RepoRef;
  config: ProjectConfig;
  /** The repository node id — what createIssue mutates against. */
  repoId: string;
  board: BoardMeta | null;
}

export class GitHubProvider implements Provider {
  readonly name = "github";
  private readonly octokit: Octokit;
  // One init per project path, shared by concurrent callers; a failed init is forgotten so it retries.
  private readonly states = new Map<string, Promise<ProjectState>>();

  constructor(
    private readonly options: ServerOptions = {},
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

  async create(ctx: ProjectContext, task: Task): Promise<Refs> {
    const state = await this.state(ctx.project);
    const issueId = await this.createIssue(state, task);
    return this.withBoard(state, task, { issueId });
  }

  async update(ctx: ProjectContext, task: Task, refs: Refs): Promise<Refs> {
    const state = await this.state(ctx.project);
    if (!refs.issueId) return this.create(ctx, task); // lost the ref somehow — re-create rather than orphan
    await this.updateIssue(refs.issueId, task);
    return this.withBoard(state, task, refs);
  }

  async pull(ctx: ProjectContext): Promise<Map<string, RemoteState>> {
    const state = await this.state(ctx.project);
    const cards = await this.boardCards(state);
    const out = new Map<string, RemoteState>();
    for (const listed of await this.listIssues(state)) {
      out.set(listed.task.id, remoteState(listed, cards.get(listed.issueId), state.board !== null));
    }
    return out;
  }

  /** The board's cards (best-effort — a read failure means no cards), so Done cards flow back in. */
  private async boardCards(state: ProjectState): Promise<Map<string, BoardCard>> {
    if (!state.board) return new Map();
    return this.readBoard(state.board).catch(() => new Map());
  }

  // -------------------------------------------------------------------------------------------------
  // Init.

  private state(project: string): Promise<ProjectState> {
    let state = this.states.get(project);
    if (!state) {
      state = this.buildState(project).catch((err) => {
        this.states.delete(project); // a failed init retries next call instead of caching the error
        throw err;
      });
      this.states.set(project, state);
    }
    return state;
  }

  private async buildState(project: string): Promise<ProjectState> {
    const repo = resolveRepo(project);
    const config = loadConfig(project, this.options);
    const snapshot = await this.repoSnapshot(repo);
    return {
      repo,
      config,
      repoId: snapshot.id,
      board: await this.boardFor(snapshot, config, repo),
    };
  }

  /** One query for the ids init needs: the repository node (createIssue mutates against it), its
   *  owner (createProjectV2 needs it), and the boards already linked to the repo. */
  private async repoSnapshot(repo: RepoRef): Promise<RepoSnapshot> {
    const res = await this.octokit.graphql<{ repository: RepoSnapshot }>(
      `query($o:String!,$n:String!){ repository(owner:$o,name:$n){ id owner{ id } projectsV2(first:50){ nodes{ id number title } } } }`,
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

  private async createIssue(state: ProjectState, task: Task): Promise<string> {
    const res = await this.octokit.graphql<{
      createIssue: { issue: { id: string } };
    }>(
      `mutation($r:ID!,$t:String!,$b:String!){ createIssue(input:{repositoryId:$r,title:$t,body:$b}){ issue{ id } } }`,
      { r: state.repoId, t: task.title || task.id, b: renderBody(task) },
    );
    const issueId = res.createIssue.issue.id;
    await this.setIssueState(issueId, task.status);
    return issueId;
  }

  private async updateIssue(issueId: string, task: Task): Promise<void> {
    const current = await this.octokit.graphql<{
      node: { body: string | null } | null;
    }>(`query($id:ID!){ node(id:$id){ ... on Issue { body } } }`, {
      id: issueId,
    });
    const human = parseBody(current.node?.body).human;
    await this.octokit.graphql(
      `mutation($id:ID!,$t:String!,$b:String!){ updateIssue(input:{id:$id,title:$t,body:$b}){ issue{ id } } }`,
      { id: issueId, t: task.title || task.id, b: renderBody(task, human) },
    );
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
      `query($o:String!,$n:String!,$c:String){ repository(owner:$o,name:$n){ issues(first:100,after:$c,states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:ASC}){ pageInfo{ hasNextPage endCursor } nodes{ id number title body state } } } }`,
      { o: repo.owner, n: repo.repo, c: after },
    );
    return res.repository.issues;
  }

  // -------------------------------------------------------------------------------------------------
  // The Projects v2 board — the mirror. Best-effort: never let a board failure fail the task write.

  private async withBoard(state: ProjectState, task: Task, refs: Refs): Promise<Refs> {
    if (!state.board || !refs.issueId) return refs;
    try {
      const projectItem = await this.syncToBoard(
        state.board,
        refs.issueId,
        refs.projectItem,
        task.status,
      );
      return { ...refs, projectItem };
    } catch (err) {
      console.error(
        `tasks-mcp: github-projects sync skipped for ${task.id}: ${(err as Error).message}`,
      );
      return refs;
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
