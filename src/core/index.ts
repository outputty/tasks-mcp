// The core library — task-management business logic, provider-agnostic and MCP-agnostic. Import this to
// embed the tracker (or drive it from the CLI); the MCP wrapper lives in `../mcp` and builds on top.

export {
  makeService,
  TaskStack,
  DuplicateTaskError,
  type TaskService,
  type SyncResult,
} from "./service.ts";
export {
  ConfigProvider,
  ProjectConfigSchema,
  defaultCacheDir,
  projectSlug,
  type ConfigSources,
} from "./providers/config.ts";
export {
  ready,
  planning,
  schedule,
  prereqs,
  blockers,
  tierOf,
  qaOf,
  priorityOf,
  specSettled,
  withDefaults,
  idList,
  type Blocker,
} from "./graph.ts";
export type {
  Task,
  ProjectContext,
  ProjectConfig,
  ServerOptions,
  QaLevel,
  SpecState,
  Priority,
  LabelFieldName,
  TrailEntry,
  TrailKind,
} from "./types.ts";
export { buildStack, type Provider, type ProviderState } from "./providers/provider.ts";
export { FileProvider } from "./providers/file.ts";
export { GitHubProvider } from "./providers/github.ts";
