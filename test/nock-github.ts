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

  // Query → handler, matched on format-stable identifiers (GraphQL ignores spacing). ORDERED: first
  // match wins, and some needles ("on Issue", "repository(") are substrings of other queries' text.
  private readonly routes: Array<
    [string, (vars: Record<string, any>) => unknown]
  > = [
    ["createIssue", (v) => this.createIssue(v)],
    ["updateIssue", (v) => this.updateIssue(v)],
    ["closeIssue", (v) => this.setIssueState(v, "CLOSED", "closeIssue")],
    ["reopenIssue", (v) => this.setIssueState(v, "OPEN", "reopenIssue")],
    ["addProjectV2ItemById", (v) => this.addItem(v)],
    ["updateProjectV2ItemFieldValue", (v) => this.setItemStatus(v)],
    ["createProjectV2", (v) => this.createBoard(v)],
    [
      "linkProjectV2ToRepository",
      () => ({ linkProjectV2ToRepository: { repository: { id: "REPO" } } }),
    ],
    ["ProjectV2SingleSelectField", () => this.statusField()],
    ["ProjectV2ItemFieldSingleSelectValue", () => this.boardItems()],
    ["projectsV2(", () => this.repoBoards()],
    ["issues(first", () => this.repoIssues()],
    ["on Issue", (v) => this.issueBody(v)],
    ["repository(", () => ({ repository: { id: "REPO" } })],
  ];

  /** Answer one GraphQL request. */
  reply(q: string, vars: Record<string, any>): unknown {
    const route = this.routes.find(([needle]) => q.includes(needle));
    if (!route)
      throw new Error(
        `unexpected graphql: ${q.replace(/\s+/g, " ").slice(0, 90)}`,
      );
    return route[1](vars);
  }

  private createIssue(vars: Record<string, any>): unknown {
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

  private updateIssue(vars: Record<string, any>): unknown {
    const i = this.issues.find((x) => x.id === vars.id);
    if (i) {
      i.title = String(vars.t);
      i.body = String(vars.b);
    }
    return { updateIssue: { issue: { id: vars.id } } };
  }

  private setIssueState(
    vars: Record<string, any>,
    state: FakeIssue["state"],
    mutation: string,
  ): unknown {
    const i = this.issues.find((x) => x.id === vars.id);
    if (i) i.state = state;
    return { [mutation]: { issue: { id: vars.id } } };
  }

  private addItem(vars: Record<string, any>): unknown {
    const id = `ITEM${this.itemSeq++}`;
    this.items.set(id, { contentId: String(vars.c), status: null });
    return { addProjectV2ItemById: { item: { id } } };
  }

  private setItemStatus(vars: Record<string, any>): unknown {
    const it = this.items.get(String(vars.i));
    if (it) it.status = String(vars.o);
    return { updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.i } } };
  }

  private createBoard(vars: Record<string, any>): unknown {
    const created = { id: "PROJ", number: 7, title: String(vars.title) };
    this.boards.push(created);
    return { createProjectV2: { projectV2: created } };
  }

  private statusField(): unknown {
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

  private boardItems(): unknown {
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

  private repoBoards(): unknown {
    return {
      repository: {
        id: "REPO",
        owner: { id: "OWNER" },
        projectsV2: { nodes: this.boards },
      },
    };
  }

  private repoIssues(): unknown {
    return {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: this.issues,
        },
      },
    };
  }

  private issueBody(vars: Record<string, any>): unknown {
    const i = this.issues.find((x) => x.id === vars.id);
    return { node: i ? { body: i.body } : null };
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
