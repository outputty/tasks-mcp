// An in-memory GraphQL double for GitHub — issues (create/update/close/reopen/list, plus the body-fetch
// and repo-id queries) and Projects v2 (board resolve, add item, set status). Matches on format-stable
// identifiers, never punctuation, because prettier reflows embedded GraphQL and GraphQL ignores spacing.

import fs from "fs";
import os from "os";
import path from "path";
import type { GitHubEnv, GraphQL } from "../src/providers/github/client.ts";
import type { ProjectConfig } from "../src/types.ts";

interface GhIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
}

export class FakeGitHub {
  issues: GhIssue[] = [];
  boards: Array<{ id: string; number: number; title: string }> = [
    { id: "PROJ", number: 7, title: "Tasks" },
  ];
  items = new Map<string, { contentId: string; status: string | null }>();
  private issueSeq = 1;
  private itemSeq = 1;

  graphql: GraphQL = (async (q: string, vars: Record<string, unknown> = {}) => {
    // --- Issues ---
    if (q.includes("createIssue")) {
      const n = this.issueSeq++;
      const issue: GhIssue = {
        id: `I_${n}`,
        number: n,
        title: String(vars.t),
        body: String(vars.b),
        state: "OPEN",
      };
      this.issues.push(issue);
      return { createIssue: { issue: { id: issue.id } } };
    }
    if (q.includes("updateIssue")) {
      const i = this.issues.find((x) => x.id === vars.id);
      if (i) {
        if (vars.t !== undefined) i.title = String(vars.t);
        if (vars.b !== undefined) i.body = String(vars.b);
      }
      return { updateIssue: { issue: { id: vars.id } } };
    }
    if (q.includes("closeIssue")) {
      const i = this.issues.find((x) => x.id === vars.id);
      if (i) i.state = "CLOSED";
      return { closeIssue: { issue: { id: vars.id } } };
    }
    if (q.includes("reopenIssue")) {
      const i = this.issues.find((x) => x.id === vars.id);
      if (i) i.state = "OPEN";
      return { reopenIssue: { issue: { id: vars.id } } };
    }
    // --- Projects v2 ---
    if (q.includes("addProjectV2ItemById")) {
      const id = `ITEM${this.itemSeq++}`;
      this.items.set(id, { contentId: String(vars.c), status: null });
      return { addProjectV2ItemById: { item: { id } } };
    }
    if (q.includes("updateProjectV2ItemFieldValue")) {
      const it = this.items.get(String(vars.i));
      if (it) it.status = String(vars.o);
      return {
        updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.i } },
      };
    }
    if (q.includes("createProjectV2")) {
      const created = { id: "PROJ", number: 7, title: String(vars.title) };
      this.boards.push(created);
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
    if (q.includes("ProjectV2ItemFieldSingleSelectValue")) {
      const nodes = [...this.items.entries()].map(([id, it]) => ({
        id,
        content: { id: it.contentId },
        fieldValueByName: it.status
          ? { name: it.status === "OPT_DONE" ? "Done" : "Todo" }
          : null,
      }));
      return {
        node: {
          items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
        },
      };
    }
    if (q.includes("projectsV2(")) {
      return {
        repository: {
          id: "REPO",
          owner: { id: "OWNER" },
          projectsV2: { nodes: this.boards },
        },
      };
    }
    // --- Shared repository queries (order after the specific ones above) ---
    if (q.includes("issues(first")) {
      return {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: this.issues,
          },
        },
      };
    }
    if (q.includes("on Issue")) {
      const i = this.issues.find((x) => x.id === vars.id);
      return { node: i ? { body: i.body } : null };
    }
    if (q.includes("repository(")) return { repository: { id: "REPO" } };
    throw new Error(`unexpected graphql: ${q.slice(0, 60)}`);
  }) as GraphQL;
}

export function envFor(
  gh: FakeGitHub = new FakeGitHub(),
  config: ProjectConfig = {},
): GitHubEnv {
  return {
    graphql: gh.graphql,
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
