// The core library — task-management business logic, provider-agnostic and MCP-agnostic. Import this to
// embed the tracker (or drive it from the CLI); the MCP wrapper lives in `../mcp` and builds on top.

export {
  makeService,
  CachedTaskService,
  DuplicateTaskError,
  type TaskService,
  type SyncResult,
} from "./service.ts";
export { Cache } from "./cache.ts";
export { loadConfig, defaultCacheDir, type ServerOptions } from "./config.ts";
export {
  ready,
  planning,
  schedule,
  tierOf,
  qaOf,
  specSettled,
  withDefaults,
  idList,
} from "./graph.ts";
export type {
  Task,
  ProjectContext,
  ProjectConfig,
  Refs,
  CacheEntry,
  QaLevel,
  SpecState,
} from "./types.ts";
export { providerFor, type Provider, type RemoteState } from "./providers/provider.ts";
export { GitHubProvider } from "./providers/github/github.ts";
