// The core library — task-management business logic, provider-agnostic and MCP-agnostic. Import this to
// embed the tracker (or drive it from the CLI); the MCP wrapper lives in `../mcp` and builds on top.

export {
  makeService,
  TaskStack,
  DuplicateTaskError,
  type TaskService,
  type SyncResult,
} from "./service.ts";
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
export type { Task, ProjectContext, ProjectConfig, QaLevel, SpecState } from "./types.ts";
export { stackFor, type Provider, type ProviderState } from "./providers/provider.ts";
export { FileProvider } from "./providers/file.ts";
export { GitHubProvider } from "./providers/github.ts";
