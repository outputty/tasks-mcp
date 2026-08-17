// A nock-backed GitHub GraphQL endpoint. Unlike a plain function stub, this makes the tests drive the
// REAL Octokit client over HTTP — nock intercepts POST https://api.github.com/graphql and answers from
// in-memory state, so the actual query strings, request bodies, and response parsing are exercised.

import nock from "nock";
import { Octokit } from "octokit";
import { GitHubProvider } from "../src/core/providers/github/github.ts";
import type { ServerOptions } from "../src/core/config.ts";

export interface FakeIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
}

export class NockGitHub {
  issues: FakeIssue[] = [];
  boards: Array<{ id: string; number: number; title: string }> = [
    { id: "PROJ", number: 7, title: "Tasks" },
  ];
  items = new Map<string, { contentId: string; status: string | null }>();
  private issueSeq = 1;
  private itemSeq = 1;

  /** Answer one GraphQL request. Matches on format-stable identifiers (GraphQL ignores spacing). */
  reply(q: string, vars: Record<string, any>): unknown {
    if (q.includes("createIssue")) {
      const n = this.issueSeq++;
      this.issues.push({
        id: `I_${n}`,
        number: n,
        title: String(vars.t),
        body: String(vars.b),
        state: "OPEN",
      });
      return { createIssue: { issue: { id: `I_${n}` } } };
    }
    if (q.includes("updateIssue")) {
      const i = this.issues.find((x) => x.id === vars.id);
      if (i) {
        i.title = String(vars.t);
        i.body = String(vars.b);
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
    if (q.includes("projectsV2("))
      return {
        repository: {
          id: "REPO",
          owner: { id: "OWNER" },
          projectsV2: { nodes: this.boards },
        },
      };
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
    throw new Error(
      `unexpected graphql: ${q.replace(/\s+/g, " ").slice(0, 90)}`,
    );
  }
}

/** Install the nock interceptor over the GitHub GraphQL endpoint, backed by `gh`. */
export function installNock(gh: NockGitHub = new NockGitHub()): NockGitHub {
  nock("https://api.github.com")
    .persist()
    .post("/graphql")
    .reply(200, (_uri, body: any) => ({
      data: gh.reply(body.query, body.variables || {}),
    }));
  return gh;
}

/**
 * A GitHubProvider whose Octokit is real — its HTTP goes through the nock interceptor. Throttling and
 * retry are disabled: the throttle plugin spaces writes ~1s apart, which the mocked endpoint doesn't
 * need and which would time the suite out. Production keeps both plugins.
 */
export function nockProvider(options: ServerOptions = {}): GitHubProvider {
  const octokit = new Octokit({
    auth: "test-token",
    throttle: { enabled: false },
    retry: { enabled: false },
  });
  return new GitHubProvider(options, octokit);
}
