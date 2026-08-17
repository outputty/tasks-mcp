// In-memory stand-ins for the slices of GitHub the targets use — REST Issues and GraphQL Projects — so
// the whole stack is tested without a network or credentials, plus small helpers for temp projects.

import fs from "fs";
import os from "os";
import path from "path";
import type { GitHubClient, RawIssue } from "../src/sync/github-issues.ts";
import type { Env, GraphQL } from "../src/config.ts";
import type { ProjectConfig } from "../src/types.ts";

export class FakeGitHub implements GitHubClient {
  issues: RawIssue[] = [];
  labels = new Set<string>();
  private nextNumber = 1;

  rest = {
    issues: {
      listForRepo: async (params: Record<string, unknown>) => {
        const state = (params.state as string) || "open";
        const wanted = params.labels
          ? String(params.labels)
              .split(",")
              .map((s) => s.trim())
          : [];
        const perPage = Number(params.per_page ?? 30);
        const page = Number(params.page ?? 1);
        let data = this.issues.filter(
          (i) => state === "all" || i.state === state,
        );
        if (wanted.length)
          data = data.filter((i) => wanted.every((w) => names(i).includes(w)));
        return { data: data.slice((page - 1) * perPage, page * perPage) };
      },

      create: async (params: Record<string, unknown>) => {
        const n = this.nextNumber++;
        const issue: RawIssue = {
          number: n,
          node_id: `ISSUE_${n}`,
          title: String(params.title ?? ""),
          state: "open",
          body: (params.body as string) ?? "",
          labels: ((params.labels as string[]) ?? []).map((name) => ({ name })),
        };
        this.issues.push(issue);
        return { data: issue };
      },

      update: async (params: Record<string, unknown>) => {
        const issue = this.issues.find(
          (i) => i.number === Number(params.issue_number),
        );
        if (!issue)
          throw Object.assign(new Error("not found"), { status: 404 });
        if (params.title !== undefined) issue.title = String(params.title);
        if (params.body !== undefined) issue.body = String(params.body);
        if (params.state !== undefined)
          issue.state = params.state as "open" | "closed";
        if (params.labels !== undefined)
          issue.labels = (params.labels as string[]).map((name) => ({ name }));
        return { data: issue };
      },

      createLabel: async (params: Record<string, unknown>) => {
        const name = String(params.name);
        if (this.labels.has(name))
          throw Object.assign(new Error("already_exists"), { status: 422 });
        this.labels.add(name);
        return {};
      },
    },
  };
}

const names = (issue: RawIssue): string[] =>
  (issue.labels || []).map((l) => (typeof l === "string" ? l : (l.name ?? "")));

/** A GraphQL double for Projects v2. Pattern-matches the queries the target sends and records mutations. */
export function fakeGraphql(
  opts: { boards?: Array<{ id: string; number: number; title: string }> } = {},
): GraphQL & {
  items: Map<string, { contentId: string; status: string | null }>;
} {
  const boards = opts.boards ?? [{ id: "PROJ", number: 7, title: "Tasks" }];
  const items = new Map<string, { contentId: string; status: string | null }>();
  let seq = 1;

  // Match on format-stable identifiers, not punctuation/spacing — prettier reflows embedded GraphQL, and
  // GraphQL itself is whitespace-insensitive, so brittle substring matches would break on a reformat.
  const fn = (async (q: string, vars: Record<string, unknown> = {}) => {
    if (q.includes("createProjectV2")) {
      const created = { id: "PROJ", number: 7, title: String(vars.title) };
      boards.push(created);
      return { createProjectV2: { projectV2: created } };
    }
    if (q.includes("linkProjectV2ToRepository"))
      return { linkProjectV2ToRepository: { repository: { id: "REPO" } } };
    if (q.includes("ProjectV2SingleSelectField")) {
      return {
        node: {
          field: {
            id: "FIELD",
            options: [
              { id: "OPT_TODO", name: "Todo" },
              { id: "OPT_DONE", name: "Done" },
            ],
          },
        },
      };
    }
    if (q.includes("projectsV2(")) {
      return {
        repository: {
          id: "REPO",
          owner: { id: "OWNER" },
          projectsV2: { nodes: boards },
        },
      };
    }
    if (q.includes("addProjectV2ItemById")) {
      const id = `ITEM${seq++}`;
      items.set(id, { contentId: String(vars.c), status: null });
      return { addProjectV2ItemById: { item: { id } } };
    }
    if (q.includes("updateProjectV2ItemFieldValue")) {
      const it = items.get(String(vars.i));
      if (it) it.status = String(vars.o);
      return {
        updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.i } },
      };
    }
    throw new Error(`unexpected graphql: ${q.slice(0, 48)}`);
  }) as GraphQL;

  return Object.assign(fn, { items });
}

export function envFor(
  gh: FakeGitHub = new FakeGitHub(),
  graphql: GraphQL = fakeGraphql(),
  config: ProjectConfig = {},
): Env {
  return {
    octokit: gh,
    graphql,
    repo: { owner: "outputty", repo: "demo" },
    config,
  };
}

/** A throwaway project directory; returns the path and a cleanup fn. */
export function tmpProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-mcp-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
