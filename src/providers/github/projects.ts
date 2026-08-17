// GitHub Projects v2 — the kanban view, GraphQL-only. Best-effort: a task always exists as an issue; the
// board is a mirror. Given an issue node id, this ensures the issue is a board card and its Status column
// tracks the task (open → Todo, done → Done). The board is found by number (config.projectNumber) or by
// title (config.board, default "Tasks"), and created + linked to the repo when neither exists.

import type { Task } from "../../types.ts";
import type { GitHubEnv, GraphQL } from "./client.ts";

interface BoardMeta {
  projectId: string;
  statusFieldId?: string;
  options: Map<string, string>; // lower-cased option name -> option id
}

const boards = new Map<string, BoardMeta>();

/** Ensure the issue is a card on the board and its status column matches. Returns the board item id. */
export async function syncToBoard(
  env: GitHubEnv,
  issueNodeId: string,
  existingItem: string | undefined,
  status: Task["status"],
): Promise<string> {
  const board = await resolveBoardCached(env);

  let itemId = existingItem;
  if (!itemId) {
    const added = await env.graphql<{
      addProjectV2ItemById: { item: { id: string } };
    }>(
      `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`,
      { p: board.projectId, c: issueNodeId },
    );
    itemId = added.addProjectV2ItemById.item.id;
  }

  await setStatus(env, board, itemId, status);
  return itemId;
}

/** What the board says about one card: its item id and whether its Status column is a Done column. */
export interface BoardCard {
  itemId: string;
  done: boolean;
}

/** Read the board back: every card keyed by its content issue's node id. Powers board → cache sync. */
export async function readBoard(
  env: GitHubEnv,
): Promise<Map<string, BoardCard>> {
  const board = await resolveBoardCached(env);
  const out = new Map<string, BoardCard>();
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
    } = await env.graphql(
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

async function setStatus(
  env: GitHubEnv,
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

async function resolveBoardCached(env: GitHubEnv): Promise<BoardMeta> {
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

async function resolveBoard(
  graphql: GraphQL,
  repo: { owner: string; repo: string },
  number: number | undefined,
  title: string,
): Promise<BoardMeta> {
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
