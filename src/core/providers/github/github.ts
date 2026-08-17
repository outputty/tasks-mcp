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
import { parse, stringify } from "yaml";
import type {
  ProjectConfig,
  ProjectContext,
  Refs,
  RepoRef,
  Task,
} from "../../types.ts";
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
  if (!token)
    throw new Error(
      "no GitHub credentials: set GITHUB_TOKEN, or run `gh auth login`",
    );
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
    throw new Error(
      `no git 'origin' remote in ${project} — the GitHub provider needs one`,
    );
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

/** Serialise a task into an issue body: the hidden block (id first), then any human prose kept below. */
function renderBody(task: Task, human = ""): string {
  const meta: Record<string, unknown> = { id: task.id };
  for (const key of META_KEYS) {
    const value = (task as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (
      Array.isArray(value) &&
      value.length === 0 &&
      key !== "deps" &&
      key !== "scope"
    )
      continue;
    meta[key] = value;
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
    status: issue.state === "CLOSED" ? "done" : "open",
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
    // Read the board too (best-effort), so a card moved to Done flows back into the cache.
    const board = state.board
      ? await this.readBoard(state.board).catch(
          () => new Map<string, { itemId: string; done: boolean }>(),
        )
      : new Map<string, { itemId: string; done: boolean }>();

    const out = new Map<string, RemoteState>();
    for (const { task, issueId, managed } of await this.listIssues(state)) {
      const card = board.get(issueId);
      const issueDone = task.status === "done";
      const done = issueDone || card?.done === true; // done if the issue is closed OR the card is in Done
      // Reconcile (push back) when the sides disagree, the card is missing, or an issue needs adopting —
      // the push makes the issue, the body block, and the board card all consistent.
      const reconcile =
        !managed ||
        issueDone !== done ||
        (state.board !== null && (!card || card.done !== done));
      // The patch is the whole task rebuilt from the body (deps included), with status reconciled.
      out.set(task.id, {
        patch: { ...task, status: done ? "done" : "open" },
        refs: { issueId, projectItem: card?.itemId },
        reconcile,
      });
    }
    return out;
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
    // One query for the ids init needs: the repository node (createIssue mutates against it), its
    // owner (createProjectV2 needs it), and the boards already linked to the repo.
    const found = await this.octokit.graphql<{
      repository: {
        id: string;
        owner: { id: string };
        projectsV2: {
          nodes: Array<{ id: string; number: number; title: string }>;
        };
      };
    }>(
      `query($o:String!,$n:String!){ repository(owner:$o,name:$n){ id owner{ id } projectsV2(first:50){ nodes{ id number title } } } }`,
      { o: repo.owner, n: repo.repo },
    );

    // The board is a mirror: init failing to produce one must not take the provider down with it.
    let board: BoardMeta | null = null;
    if (config.projects !== false) {
      try {
        board = await this.resolveBoard(found.repository, config);
      } catch (err) {
        console.error(
          `tasks-mcp: github-projects board unavailable for ${repo.owner}/${repo.repo}, syncing issues only: ${(err as Error).message}`,
        );
      }
    }
    return { repo, config, repoId: found.repository.id, board };
  }

  /** Find the board by number (config.projectNumber) or title (config.board, default "Tasks") among
   *  the repo's linked boards — or create it and link it to the repo — then read its Status field. */
  private async resolveBoard(
    repository: {
      id: string;
      owner: { id: string };
      projectsV2: {
        nodes: Array<{ id: string; number: number; title: string }>;
      };
    },
    config: ProjectConfig,
  ): Promise<BoardMeta> {
    const number = config.projectNumber;
    const title = config.board ?? "Tasks";
    let project = number
      ? repository.projectsV2.nodes.find((p) => p.number === number)
      : repository.projectsV2.nodes.find((p) => p.title === title);

    if (!project) {
      if (number) throw new Error(`Projects v2 board #${number} not found`);
      const created = await this.octokit.graphql<{
        createProjectV2: {
          projectV2: { id: string; number: number; title: string };
        };
      }>(
        `mutation($owner:ID!,$title:String!){ createProjectV2(input:{ownerId:$owner,title:$title}){ projectV2{ id number title } } }`,
        { owner: repository.owner.id, title },
      );
      project = created.createProjectV2.projectV2;
      await this.octokit.graphql(
        `mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){ repository{ id } } }`,
        { p: project.id, r: repository.id },
      );
    }

    const fields = await this.octokit.graphql<{
      node: {
        field: {
          id: string;
          options: Array<{ id: string; name: string }>;
        } | null;
      };
    }>(
      `query($id:ID!){ node(id:$id){ ... on ProjectV2 { field(name:"Status"){ ... on ProjectV2SingleSelectField { id options{ id name } } } } } }`,
      { id: project.id },
    );

    const options = new Map<string, string>();
    const status = fields.node.field;
    for (const opt of status?.options ?? [])
      options.set(opt.name.toLowerCase(), opt.id);
    return { projectId: project.id, statusFieldId: status?.id, options };
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

  private async setIssueState(
    issueId: string,
    status: Task["status"],
  ): Promise<void> {
    const mutation =
      status === "done"
        ? `mutation($id:ID!){ closeIssue(input:{issueId:$id}){ issue{ id } } }`
        : `mutation($id:ID!){ reopenIssue(input:{issueId:$id}){ issue{ id } } }`;
    await this.octokit.graphql(mutation, { id: issueId });
  }

  /**
   * Every issue in the repo (not PRs — the `issues` connection excludes them), reconstructed as a full
   * task from its body block. A managed issue keeps its block id; a hand-opened one is given
   * `gh-<number>` so `sync` can adopt it. This is what lets a deleted cache be rebuilt from GitHub.
   */
  private async listIssues(
    state: ProjectState,
  ): Promise<Array<{ task: Task; issueId: string; managed: boolean }>> {
    const out: Array<{ task: Task; issueId: string; managed: boolean }> = [];
    let after: string | null = null;
    for (;;) {
      const res: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: GhIssue[];
          };
        };
      } = await this.octokit.graphql(
        `query($o:String!,$n:String!,$c:String){ repository(owner:$o,name:$n){ issues(first:100,after:$c,states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:ASC}){ pageInfo{ hasNextPage endCursor } nodes{ id number title body state } } } }`,
        { o: state.repo.owner, n: state.repo.repo, c: after },
      );
      for (const issue of res.repository.issues.nodes) {
        const mid = managedId(issue);
        const task = mid
          ? issueToTask(issue)
          : withDefaults({
              id: `gh-${issue.number}`,
              title: issue.title || "",
              status: issue.state === "CLOSED" ? "done" : "open",
            });
        out.push({ task, issueId: issue.id, managed: mid !== null });
      }
      if (!res.repository.issues.pageInfo.hasNextPage) break;
      after = res.repository.issues.pageInfo.endCursor;
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------
  // The Projects v2 board — the mirror. Best-effort: never let a board failure fail the task write.

  private async withBoard(
    state: ProjectState,
    task: Task,
    refs: Refs,
  ): Promise<Refs> {
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
    let itemId = existingItem;
    if (!itemId) {
      const added = await this.octokit.graphql<{
        addProjectV2ItemById: { item: { id: string } };
      }>(
        `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`,
        { p: board.projectId, c: issueId },
      );
      itemId = added.addProjectV2ItemById.item.id;
    }

    if (board.statusFieldId) {
      const wanted =
        status === "done" ? ["done", "closed"] : ["todo", "to do", "backlog"];
      const optionId = wanted.map((w) => board.options.get(w)).find(Boolean);
      if (optionId) {
        await this.octokit.graphql(
          `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`,
          {
            p: board.projectId,
            i: itemId,
            f: board.statusFieldId,
            o: optionId,
          },
        );
      }
    }
    return itemId;
  }

  /** Read the board back: every card keyed by its content issue's node id. Powers board → cache sync. */
  private async readBoard(
    board: BoardMeta,
  ): Promise<Map<string, { itemId: string; done: boolean }>> {
    const out = new Map<string, { itemId: string; done: boolean }>();
    let after: string | null = null;
    for (;;) {
      const res: {
        node: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              id: string;
              content: { id?: string } | null;
              fieldValueByName: { name?: string } | null;
            }>;
          };
        };
      } = await this.octokit.graphql(
        `query($p:ID!,$c:String){ node(id:$p){ ... on ProjectV2 { items(first:100,after:$c){ pageInfo{ hasNextPage endCursor } nodes{ id content{ ... on Issue { id } } fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`,
        { p: board.projectId, c: after },
      );
      for (const item of res.node.items.nodes) {
        const issueId = item.content?.id;
        if (!issueId) continue; // draft cards or non-issue content
        const name = (item.fieldValueByName?.name ?? "").toLowerCase();
        out.set(issueId, {
          itemId: item.id,
          done: name === "done" || name === "closed",
        });
      }
      if (!res.node.items.pageInfo.hasNextPage) break;
      after = res.node.items.pageInfo.endCursor;
    }
    return out;
  }
}
