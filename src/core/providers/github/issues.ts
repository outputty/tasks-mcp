// GitHub Issues over GraphQL — no REST, no labels. The task id lives in a hidden YAML block in the issue
// body (alongside deps/scope/tier/…), so there is nothing to look up by label and nothing to keep in
// sync but the body itself. An issue is "managed" iff its body carries that block with an id.

import { parse, stringify } from "yaml";
import type { Task } from "../../types.ts";
import type { GitHubEnv } from "./client.ts";
import { withDefaults } from "../../graph.ts";

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
export function renderBody(task: Task, human = ""): string {
  const meta: Record<string, unknown> = { id: task.id };
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
export function managedId(issue: GhIssue): string | null {
  const id = parseBody(issue.body).meta.id;
  return typeof id === "string" && id ? id : null;
}

/** The full task an issue encodes (the body block wins; title/status come from the issue). */
export function issueToTask(issue: GhIssue): Task {
  const { meta } = parseBody(issue.body);
  return withDefaults({
    ...meta,
    id: String(meta.id),
    title: issue.title || "",
    status: issue.state === "CLOSED" ? "done" : "open",
  } as Partial<Task> & { id: string });
}

// The repository node id createIssue needs, resolved once per repo per process.
const repoIds = new Map<string, string>();
async function repositoryId(env: GitHubEnv): Promise<string> {
  const key = `${env.repo.owner}/${env.repo.repo}`;
  const cached = repoIds.get(key);
  if (cached) return cached;
  const res = await env.graphql<{ repository: { id: string } }>(
    `query($o:String!,$n:String!){ repository(owner:$o,name:$n){ id } }`,
    { o: env.repo.owner, n: env.repo.repo },
  );
  repoIds.set(key, res.repository.id);
  return res.repository.id;
}

export async function createIssue(env: GitHubEnv, task: Task): Promise<string> {
  const res = await env.graphql<{ createIssue: { issue: { id: string } } }>(
    `mutation($r:ID!,$t:String!,$b:String!){ createIssue(input:{repositoryId:$r,title:$t,body:$b}){ issue{ id } } }`,
    {
      r: await repositoryId(env),
      t: task.title || task.id,
      b: renderBody(task),
    },
  );
  const issueId = res.createIssue.issue.id;
  await setState(env, issueId, task.status);
  return issueId;
}

export async function updateIssue(
  env: GitHubEnv,
  issueId: string,
  task: Task,
): Promise<void> {
  const current = await env.graphql<{ node: { body: string | null } | null }>(
    `query($id:ID!){ node(id:$id){ ... on Issue { body } } }`,
    { id: issueId },
  );
  const human = parseBody(current.node?.body).human;
  await env.graphql(
    `mutation($id:ID!,$t:String!,$b:String!){ updateIssue(input:{id:$id,title:$t,body:$b}){ issue{ id } } }`,
    { id: issueId, t: task.title || task.id, b: renderBody(task, human) },
  );
  await setState(env, issueId, task.status);
}

async function setState(
  env: GitHubEnv,
  issueId: string,
  status: Task["status"],
): Promise<void> {
  const mutation =
    status === "done"
      ? `mutation($id:ID!){ closeIssue(input:{issueId:$id}){ issue{ id } } }`
      : `mutation($id:ID!){ reopenIssue(input:{issueId:$id}){ issue{ id } } }`;
  await env.graphql(mutation, { id: issueId });
}

/** One repo issue as a full task, plus its ref and whether it already carries our block. */
export interface ListedIssue {
  task: Task;
  issueId: string;
  managed: boolean;
}

/**
 * Every issue in the repo (not PRs — the `issues` connection excludes them), reconstructed as a full
 * task from its body block (deps/scope/tier/…). A managed issue keeps its block id; a hand-opened one is
 * given `gh-<number>` so `sync` can adopt it. This is what lets a deleted cache be rebuilt from GitHub.
 */
export async function listIssues(env: GitHubEnv): Promise<ListedIssue[]> {
  const out: ListedIssue[] = [];
  let after: string | null = null;
  for (;;) {
    const res: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: GhIssue[];
        };
      };
    } = await env.graphql(
      `query($o:String!,$n:String!,$c:String){ repository(owner:$o,name:$n){ issues(first:100,after:$c,states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:ASC}){ pageInfo{ hasNextPage endCursor } nodes{ id number title body state } } } }`,
      { o: env.repo.owner, n: env.repo.repo, c: after },
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
