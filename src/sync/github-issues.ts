// The GitHub Issues sync target. Issues carry the human-facing record: title, open/closed status, the id
// (as a label so lookups survive a title edit), and a mirror of the structured fields in a hidden body
// block. The dependency graph is NOT authoritative here — the cache owns it — but deps are mirrored into
// the body too, so a human reading the issue sees them.

import type { ProjectContext, Refs, Task } from "../types.ts";
import type { Env } from "../config.ts";
import type { SyncTarget } from "./target.ts";
import { withDefaults } from "../graph.ts";

// The subset of Octokit the target uses. The real client and the test double both satisfy it.
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
  node_id?: string;
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

function humanPart(body: string | null | undefined): string {
  if (!body) return "";
  const start = body.indexOf(META_OPEN);
  if (start === -1) return body.trim();
  const end = body.indexOf(META_CLOSE, start);
  return end === -1 ? body.trim() : body.slice(end + META_CLOSE.length).trim();
}

// The provisioning marker, cached once per repo per process.
const provisioned = new Set<string>();

export class GitHubIssuesTarget implements SyncTarget {
  readonly name = "github-issues";

  enabled(): boolean {
    return true; // Issues are always the base record.
  }

  async push(
    env: Env,
    _ctx: ProjectContext,
    task: Task,
    refs: Refs,
  ): Promise<Refs> {
    const { octokit, repo } = env;
    await this.ensureProvisioned(octokit, repo);
    const existing = refs.issue
      ? { number: refs.issue }
      : await this.findByIdRaw(octokit, repo, task.id);

    if (existing) {
      const current = await this.get(octokit, repo, existing.number);
      const { data } = await octokit.rest.issues.update({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: existing.number,
        title: task.title || task.id,
        state: task.status === "done" ? "closed" : "open",
        body: renderBody(task, humanPart(current?.body)),
      });
      return { issue: data.number, issueNodeId: data.node_id };
    }

    const { data } = await octokit.rest.issues.create({
      owner: repo.owner,
      repo: repo.repo,
      title: task.title || task.id,
      body: renderBody(task),
      labels: [`${ID_LABEL}${task.id}`, MARKER_LABEL],
    });
    return { issue: data.number, issueNodeId: data.node_id };
  }

  async pull(env: Env): Promise<Map<string, Partial<Task>>> {
    const { octokit, repo } = env;
    const issues = (await this.allIssues(octokit, repo)).filter(isTask);
    const out = new Map<string, Partial<Task>>();
    for (const issue of issues) {
      out.set(idOf(issue)!, {
        title: issue.title,
        status: issue.state === "closed" ? "done" : "open",
      });
    }
    return out;
  }

  /** The issue number backing a task id, for other targets (Projects needs the issue node id). */
  async issueNodeId(env: Env, id: string): Promise<string | null> {
    const issue = await this.findByIdRaw(env.octokit, env.repo, id);
    return issue?.node_id ?? null;
  }

  private async ensureProvisioned(
    octokit: GitHubClient,
    repo: { owner: string; repo: string },
  ): Promise<void> {
    const key = `${repo.owner}/${repo.repo}`;
    if (provisioned.has(key)) return;
    try {
      await octokit.rest.issues.createLabel({
        owner: repo.owner,
        repo: repo.repo,
        name: MARKER_LABEL,
        color: "5319e7",
        description: "Task managed by outputty tasks-mcp",
      });
    } catch (err) {
      if ((err as { status?: number }).status !== 422) throw err; // 422 == already exists
    }
    provisioned.add(key);
  }

  private async get(
    octokit: GitHubClient,
    repo: { owner: string; repo: string },
    num: number,
  ) {
    const { data } = await octokit.rest.issues.listForRepo({
      owner: repo.owner,
      repo: repo.repo,
      state: "all",
      per_page: 100,
    });
    return data.find((i) => i.number === num) ?? null;
  }

  private async findByIdRaw(
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
  ) {
    const out: RawIssue[] = [];
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.repo,
        state: "all",
        per_page: 100,
        page,
      });
      out.push(...data);
      if (data.length < 100) break;
    }
    return out;
  }
}

// Re-exported so the service can hydrate a cache miss into a full task when a target reports a new id.
export const taskFromPartial = (id: string, partial: Partial<Task>): Task =>
  withDefaults({ id, ...partial });
