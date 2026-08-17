// The GitHub Projects v2 sync target — a kanban view of the tasks. Projects v2 is GraphQL-only, so this
// target talks through `env.graphql`. It is best-effort: a task always exists as an issue; the board is a
// mirror. The service treats a Projects failure as a warning, never a lost task.
//
// Per project it needs the board's id and its Status field's option ids, resolved once and cached. The
// board is found by number (config.projectNumber) or by title (config.board, default "Tasks"), and
// created + linked to the repo when neither exists.

import type { ProjectContext, Refs, Task } from "../types.ts";
import type { Env, GraphQL } from "../config.ts";
import type { SyncTarget } from "./target.ts";

interface BoardMeta {
  projectId: string;
  statusFieldId?: string;
  options: Map<string, string>; // lower-cased option name -> option id
}

// Resolved board metadata, cached per repo+board for the process.
const boards = new Map<string, BoardMeta>();

export class GitHubProjectsTarget implements SyncTarget {
  readonly name = "github-projects";

  constructor(
    private readonly issueNodeId: (
      env: Env,
      id: string,
    ) => Promise<string | null>,
  ) {}

  enabled(env: Env): boolean {
    return env.config.projects !== false;
  }

  async push(
    env: Env,
    _ctx: ProjectContext,
    task: Task,
    refs: Refs,
  ): Promise<Refs> {
    const board = await this.board(env);

    let itemId = refs.projectItem;
    if (!itemId) {
      // The content id is only needed to ADD the item; an existing item just needs its status updated.
      const contentId =
        refs.issueNodeId ?? (await this.issueNodeId(env, task.id));
      if (!contentId) return {}; // no issue yet; nothing to place on the board
      const added = await env.graphql<{
        addProjectV2ItemById: { item: { id: string } };
      }>(
        `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`,
        { p: board.projectId, c: contentId },
      );
      itemId = added.addProjectV2ItemById.item.id;
    }

    await this.setStatus(env, board, itemId, task.status);
    return { projectItem: itemId };
  }

  // The board is a view; the canonical status comes from Issues. Nothing to pull back for now.
  async pull(): Promise<Map<string, Partial<Task>>> {
    return new Map();
  }

  private async setStatus(
    env: Env,
    board: BoardMeta,
    itemId: string,
    status: Task["status"],
  ): Promise<void> {
    if (!board.statusFieldId) return;
    const wanted =
      status === "done" ? ["done", "closed"] : ["todo", "to do", "backlog"];
    const optionId = wanted.map((w) => board.options.get(w)).find(Boolean);
    if (!optionId) return;
    await env.graphql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`,
      { p: board.projectId, i: itemId, f: board.statusFieldId, o: optionId },
    );
  }

  private async board(env: Env): Promise<BoardMeta> {
    const key = `${env.repo.owner}/${env.repo.repo}#${env.config.projectNumber ?? env.config.board ?? "Tasks"}`;
    const cached = boards.get(key);
    if (cached) return cached;
    const meta = await resolveBoard(
      env.graphql,
      env.repo,
      env.config.projectNumber,
      env.config.board ?? "Tasks",
    );
    boards.set(key, meta);
    return meta;
  }
}

async function resolveBoard(
  graphql: GraphQL,
  repo: { owner: string; repo: string },
  number: number | undefined,
  title: string,
): Promise<BoardMeta> {
  // One round-trip fetches the repo node id, its owner node id, and its existing boards.
  const found = await graphql<{
    repository: {
      id: string;
      owner: { id: string };
      projectsV2: {
        nodes: Array<{ id: string; number: number; title: string }>;
      };
    };
  }>(
    `
      query ($o: String!, $n: String!) {
        repository(owner: $o, name: $n) {
          id
          owner {
            id
          }
          projectsV2(first: 50) {
            nodes {
              id
              number
              title
            }
          }
        }
      }
    `,
    { o: repo.owner, n: repo.repo },
  );

  const nodes = found.repository.projectsV2.nodes;
  let project = number
    ? nodes.find((p) => p.number === number)
    : nodes.find((p) => p.title === title);

  if (!project) {
    if (number)
      throw new Error(
        `Projects v2 board #${number} not found on ${repo.owner}/${repo.repo}`,
      );
    const created = await graphql<{
      createProjectV2: {
        projectV2: { id: string; number: number; title: string };
      };
    }>(
      `
        mutation ($owner: ID!, $title: String!) {
          createProjectV2(input: { ownerId: $owner, title: $title }) {
            projectV2 {
              id
              number
              title
            }
          }
        }
      `,
      { owner: found.repository.owner.id, title },
    );
    project = created.createProjectV2.projectV2;
    await graphql(
      `
        mutation ($p: ID!, $r: ID!) {
          linkProjectV2ToRepository(
            input: { projectId: $p, repositoryId: $r }
          ) {
            repository {
              id
            }
          }
        }
      `,
      { p: project.id, r: found.repository.id },
    );
  }

  const fields = await graphql<{
    node: {
      field: {
        id: string;
        options: Array<{ id: string; name: string }>;
      } | null;
    };
  }>(
    `
      query ($id: ID!) {
        node(id: $id) {
          ... on ProjectV2 {
            field(name: "Status") {
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `,
    { id: project.id },
  );

  const options = new Map<string, string>();
  const status = fields.node.field;
  for (const opt of status?.options ?? [])
    options.set(opt.name.toLowerCase(), opt.id);
  return { projectId: project.id, statusFieldId: status?.id, options };
}
