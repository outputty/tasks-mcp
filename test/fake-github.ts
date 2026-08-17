// An in-memory stand-in for the slice of GitHub the adapter uses. Lets the backend and the whole MCP
// protocol be tested without a network or credentials.

import type { GitHubClient, RawIssue } from "../src/backends/github-issues.ts";

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
        if (wanted.length) {
          data = data.filter((i) => wanted.every((w) => names(i).includes(w)));
        }
        return { data: data.slice((page - 1) * perPage, page * perPage) };
      },

      create: async (params: Record<string, unknown>) => {
        const issue: RawIssue = {
          number: this.nextNumber++,
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
