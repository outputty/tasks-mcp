// The core library — task-management business logic, provider-agnostic and MCP-agnostic. Import this to
// embed the tracker (or drive it from the CLI); the MCP wrapper lives in `../mcp` and builds on top.

export {
  makeService,
  TaskStack,
  DuplicateTaskError,
  type TaskService,
  type SyncResult,
} from "./service.ts";
export { ChangeBus } from "./changes.ts";
export { readProjectSummaries, type ProjectSummary } from "./projects.ts";
export {
  ClaimStore,
  DEFAULT_STALE_MINUTES,
  minutesSince,
  type Claim,
  type StaleClaim,
} from "./claims.ts";
export {
  ConfigProvider,
  ProjectConfigSchema,
  defaultCacheDir,
  validateProjectId,
  type ConfigSources,
} from "./providers/config.ts";
export {
  ready,
  eligible,
  inLane,
  scopesIntersect,
  overlappingClaims,
  planning,
  schedule,
  prereqs,
  blockers,
  tierOf,
  qaOf,
  priorityOf,
  specSettled,
  typeOf,
  isTarget,
  targets,
  tasksOf,
  progressOf,
  roadmap,
  withDefaults,
  idList,
  type Blocker,
  type Eligible,
  type Progress,
  type RoadmapEntry,
} from "./graph.ts";
export type {
  Task,
  NodeType,
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
export {
  buildStack,
  resolveRemotes,
  type Provider,
  type ProviderState,
} from "./providers/provider.ts";
export { FileProvider } from "./providers/file.ts";
export { GitHubProvider } from "./providers/github.ts";
