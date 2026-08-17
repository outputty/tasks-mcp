// The provider seam — the plug-and-play point. A provider is a whole external system (GitHub today,
// Linear tomorrow); it owns how a task is created, updated, and read back there. Everything above it —
// the committed cache, the graph engine, the service, the tools, the MCP protocol — is provider-agnostic
// and never changes when a provider is added.
//
// The cache stays authoritative for the dependency graph; a provider only handles the fields it can
// represent (title, status). Deps never leave the cache.

import type { ProjectContext, Refs, Task } from "../types.ts";
import { loadConfig, type ServerOptions } from "../config.ts";
import { GitHubProvider } from "./github/github.ts";
import { resolveGitHubEnv } from "./github/client.ts";

/** What a provider reports back for one task on `pull`: the fields it owns, plus refs to remember. */
export interface RemoteState {
  patch: Partial<Task>;
  refs: Refs;
  /** The provider's sides disagree (or an issue needs adopting): the service should push this back. */
  reconcile?: boolean;
}

export interface Provider {
  readonly name: string;
  /** Create the task in the provider (it is new to the cache). Returns refs to store. */
  create(ctx: ProjectContext, task: Task): Promise<Refs>;
  /** Update an existing task in the provider, using the refs from its cache entry. */
  update(ctx: ProjectContext, task: Task, refs: Refs): Promise<Refs>;
  /** Read every task this provider manages, keyed by task id — the provider-owned fields plus refs. */
  pull(ctx: ProjectContext): Promise<Map<string, RemoteState>>;
}

// Registered providers. Adding Linear is one entry here plus its implementation — nothing else moves.
const PROVIDERS: Record<string, (options: ServerOptions) => Provider> = {
  github: (options) => new GitHubProvider((p) => resolveGitHubEnv(p, options)),
};

/** The provider a project uses, from its config (default "github"). */
export function providerFor(
  project: string,
  options: ServerOptions = {},
): Provider {
  const name = loadConfig(project, options).provider ?? "github";
  const make = PROVIDERS[name];
  if (!make)
    throw new Error(
      `unknown provider '${name}' (known: ${Object.keys(PROVIDERS).join(", ")})`,
    );
  return make(options);
}
