// The GitHub Issues backend. Issues are the source of truth: reads pull from the API, writes push to it,
// so the "two-way sync" is inherent in every operation, not a batch job bolted on. The dedicated `sync`
// tool adds the file bridge — it materialises the full remote state into an in-repo snapshot and imports
// any locally-seeded tasks that are missing upstream.
//
// MAPPING
//   task.id           -> label `outputty:id:<id>`   (the stable key; lets GitHub look a task up directly)
//   task.title        -> issue title
//   task.status       -> issue state (open | closed)
//   everything else   -> a fenced YAML block in the issue body, hidden inside an HTML comment
//
// The adapter takes its client through a resolver, so tests inject a fake GitHub and never hit the wire.

import fs from "fs";
import path from "path";
import type { ProjectContext, Task } from "../types.ts";
import type { Backend, Resolved, SyncResult } from "../backend.ts";
import { withDefaults } from "../graph.ts";

// The subset of Octokit the adapter uses. The real client and the test double both satisfy it.
export interface GitHubClient {
  rest: {
    issues: {
      listForRepo(
        params: Record<string, unknown>,
      ): Promise<{ data: RawIssue[] }>;
      create(params: Record<string, unknown>): Promise<{ data: RawIssue }>;
      update(params: Record<string, unknown>): Promise<{ data: RawIssue }>;
      createLabel(params: Record<string, unknown>): Promise<unknown>;
    };
  };
}

export interface RawIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  body?: string | null;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
}

const ID_LABEL = "outputty:id:";
const MARKER_LABEL = "outputty";
const META_OPEN = "<!-- outputty:task";
const META_CLOSE = "-->";

const labelNames = (issue: RawIssue): string[] =>
  (issue.labels || [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);

const idOf = (issue: RawIssue): string | null =>
  labelNames(issue)
    .find((n) => n.startsWith(ID_LABEL))
    ?.slice(ID_LABEL.length) ?? null;

const isTask = (issue: RawIssue): boolean =>
  !issue.pull_request && idOf(issue) !== null;

// The task fields that live in the body block, in a stable order. id/title/status live outside it.
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

/** Serialise a task into an issue body: the hidden YAML block, then any human prose kept below it. */
function renderBody(task: Task, human = ""): string {
  const meta: Record<string, unknown> = {};
  for (const key of META_KEYS) {
    const value = (task as Record<string, unknown>)[key];
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
  const yaml = Bun.YAML.stringify(meta, null, 2).trim();
  const block = `${META_OPEN}\n${yaml}\n${META_CLOSE}`;
  return (human ? `${block}\n\n${human}` : block).trimEnd() + "\n";
}

/** Split an issue body into the parsed meta block and the human prose beneath it. */
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
    meta = (Bun.YAML.parse(yaml) as Record<string, unknown>) || {};
  } catch {
    meta = {};
  }
  return { meta, human: body.slice(end + META_CLOSE.length).trim() };
}

function issueToTask(issue: RawIssue): Task {
  const { meta } = parseBody(issue.body);
  return withDefaults({
    ...meta,
    id: idOf(issue) ?? `gh-${issue.number}`,
    title: issue.title || "",
    status: issue.state === "closed" ? "done" : "open",
  } as Partial<Task> & { id: string });
}

export class GitHubIssuesBackend implements Backend {
  private provisioned = new Set<string>();

  constructor(
    private readonly resolve: (ctx: ProjectContext) => Promise<Resolved>,
  ) {}

  async list(ctx: ProjectContext): Promise<Task[]> {
    const { octokit, repo } = await this.resolve(ctx);
    const issues = await this.allIssues(octokit, repo, "all");
    return issues.filter(isTask).map(issueToTask);
  }

  async get(ctx: ProjectContext, id: string): Promise<Task | null> {
    const { octokit, repo } = await this.resolve(ctx);
    const issue = await this.findById(octokit, repo, id);
    return issue ? issueToTask(issue) : null;
  }

  async create(ctx: ProjectContext, task: Task): Promise<Task> {
    const { octokit, repo } = await this.resolve(ctx);
    await this.ensureProvisioned(octokit, repo);
    if (await this.findById(octokit, repo, task.id))
      throw new Error(`task ${task.id} already exists`);
    const { data } = await octokit.rest.issues.create({
      owner: repo.owner,
      repo: repo.repo,
      title: task.title || task.id,
      body: renderBody(task),
      labels: [`${ID_LABEL}${task.id}`, MARKER_LABEL],
    });
    return issueToTask(data);
  }

  async update(
    ctx: ProjectContext,
    id: string,
    patch: Partial<Task>,
  ): Promise<Task> {
    const { octokit, repo } = await this.resolve(ctx);
    const issue = await this.findById(octokit, repo, id);
    if (!issue) throw new Error(`no task ${id}`);
    const merged: Task = { ...issueToTask(issue), ...patch, id };
    const params: Record<string, unknown> = {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issue.number,
      body: renderBody(merged, parseBody(issue.body).human),
    };
    if (patch.title !== undefined) params.title = patch.title;
    if (patch.status !== undefined)
      params.state = patch.status === "done" ? "closed" : "open";
    const { data } = await octokit.rest.issues.update(params);
    return issueToTask(data);
  }

  async close(ctx: ProjectContext, id: string): Promise<void> {
    await this.update(ctx, id, { status: "done" });
  }

  /**
   * The file bridge. Pull the whole remote into `<project>/.claude/tasks.yaml` (an in-repo snapshot),
   * then push any task in `<project>/.claude/tasks.seed.yaml` that has no issue yet. GitHub is the source
   * of truth, so the pull never edits an existing issue and there are no conflicts to resolve.
   */
  async sync(ctx: ProjectContext): Promise<SyncResult> {
    const remote = await this.list(ctx);
    writeSnapshot(path.join(ctx.project, ".claude", "tasks.yaml"), remote);

    let pushed = 0;
    const seedPath = path.join(ctx.project, ".claude", "tasks.seed.yaml");
    if (fs.existsSync(seedPath)) {
      const seed =
        (Bun.YAML.parse(fs.readFileSync(seedPath, "utf8")) as Array<
          Partial<Task> & { id: string }
        >) || [];
      const have = new Set(remote.map((t) => t.id));
      for (const raw of seed) {
        if (have.has(raw.id)) continue;
        await this.create(ctx, withDefaults(raw));
        pushed++;
      }
    }
    return { pulled: remote.length, pushed, conflicts: 0 };
  }

  // "Spots a new repo -> sets up the backend": ensure the marker label exists, once per repo per process.
  private async ensureProvisioned(
    octokit: GitHubClient,
    repo: { owner: string; repo: string },
  ): Promise<void> {
    const key = `${repo.owner}/${repo.repo}`;
    if (this.provisioned.has(key)) return;
    try {
      await octokit.rest.issues.createLabel({
        owner: repo.owner,
        repo: repo.repo,
        name: MARKER_LABEL,
        color: "5319e7",
        description: "Task managed by outputty tasks-mcp",
      });
    } catch (err) {
      // 422 == label already exists, which is the normal steady state. Anything else is a real failure.
      if ((err as { status?: number }).status !== 422) throw err;
    }
    this.provisioned.add(key);
  }

  private async findById(
    octokit: GitHubClient,
    repo: { owner: string; repo: string },
    id: string,
  ) {
    const { data } = await octokit.rest.issues.listForRepo({
      owner: repo.owner,
      repo: repo.repo,
      state: "all",
      labels: `${ID_LABEL}${id}`,
      per_page: 10,
    });
    return data.find(isTask) ?? null;
  }

  private async allIssues(
    octokit: GitHubClient,
    repo: { owner: string; repo: string },
    state: string,
  ) {
    const out: RawIssue[] = [];
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.repo,
        state,
        per_page: 100,
        page,
      });
      out.push(...data);
      if (data.length < 100) break;
    }
    return out;
  }
}

/** Write the pulled tasks to an in-repo snapshot, in the derived-index shape, marked never-hand-edit. */
function writeSnapshot(file: string, tasks: Task[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header =
    "# DERIVED — a snapshot of GitHub Issues, refreshed by the tasks-mcp `sync` tool.\n";
  const body = tasks.length ? Bun.YAML.stringify(tasks, null, 2) : "";
  fs.writeFileSync(
    file,
    header + (body && !body.endsWith("\n") ? body + "\n" : body),
  );
}
